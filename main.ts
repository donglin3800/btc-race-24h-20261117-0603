/**
 * Dip-buy mean-reversion bot for cbBTC (agent-fun/bars-replay/v1).
 *
 * The harness sends a hello once, then one batch per minute: each batch
 * carries the 1-minute bar that just closed, the fills of the orders sent
 * on the previous batch, and the account. The bot answers every batch with
 * exactly one reply echoing its seq and carrying its orders (at most one
 * order here).
 *
 * Strategy, in plain terms: Bitcoin on this pool mostly chops sideways in
 * 1-minute bars, with occasional sharp hourly drops that bounce back. The
 * bot waits flat in cash until the close has fallen at least 1.00% over the
 * last 60 bars, then buys with all its cash. It sells the whole position
 * when the close is 1.80% above its entry fill, or 1.00% below it, or when
 * a bounce that already reached +1.20% gives back 0.80% (a trailing exit).
 * If it has still made no trade by bar 900 it relaxes the dip to 0.60% so
 * a quiet window still gets at least one trade. No new entries in the
 * last 60 bars.
 *
 * Everything is BigInt arithmetic on the raw integer prices and quote units
 * the protocol uses, so two executions on the same bars produce the same
 * orders byte for byte: no clock, no randomness, no environment, no files.
 */

import * as readline from "node:readline";

const SYMBOL = "CBBTC";
const MAX_SLIPPAGE_BPS = 150;
const LOOKBACK = 60;
const DIP_BPS = 100n; // enter when the 60-bar close return is <= -1.00%
const FALLBACK_DIP_BPS = 60n; // after bar 900 with no fill yet: <= -0.60%
const TAKE_PROFIT_BPS = 180n; // exit at +1.80% over the entry fill
const STOP_BPS = 100n; // exit at -1.00% under the entry fill
const TRAIL_ARM_BPS = 120n; // trailing exit arms once the gain reaches +1.20%
const TRAIL_DROP_BPS = 80n; // ... and exits if the gain falls 0.80% from its best
const NO_ENTRY_AFTER = 1380; // no new entries in the last 60 bars of the window
const COOLDOWN_BARS = 5; // wait 5 bars after a sell before re-entering
const MIN_NOTIONAL = 1000000n; // 1 USDC, in quote units (the harness minimum)

type Order = {
  side: "buy" | "sell";
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
};

const closes: bigint[] = []; // closes of CBBTC bars, oldest first, raw ints
let warmupBars = 0;
let cash = 0n; // quote units, from the latest batch account
let posQty = 0n; // qty of CBBTC held, raw units (qty_scale 8)
let entryPrice = 0n; // raw fill price of the current position
let bestGainBps = 0n; // best close gain over entry, in bps
let state: "flat" | "buying" | "holding" | "selling" = "flat";
let nextId = 1;
let fillsDone = 0; // filled orders so far (drives the fallback)
let cooldownUntil = -1; // seq before which no new entry is sent

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line) as Record<string, unknown>;
  const kind = msg["type"];
  if (kind === "hello") {
    warmupBars = Number(msg["warmup_bars"] ?? 0);
    continue;
  }
  if (kind === "done") break;
  if (kind !== "batch") continue;

  const seq = Number(msg["seq"]);

  // Fold in the fills of the orders sent on the previous batch.
  const fills = (msg["fills"] as Array<Record<string, unknown>>) ?? [];
  for (const fill of fills) {
    if (fill["symbol"] !== SYMBOL) continue;
    if (fill["status"] === "filled") {
      fillsDone += 1;
      if (fill["side"] === "buy") {
        entryPrice = BigInt(fill["price"] as string);
        bestGainBps = 0n;
        state = "holding";
      } else if (fill["side"] === "sell") {
        entryPrice = 0n;
        posQty = 0n;
        state = "flat";
        cooldownUntil = seq + COOLDOWN_BARS;
      }
    } else {
      // Rejected: the order never happened.
      if (fill["side"] === "buy" && state === "buying") state = "flat";
      else if (fill["side"] === "sell" && state === "selling")
        state = "holding";
    }
  }

  // The account is authoritative about cash and the position.
  const account = (msg["account"] as Record<string, unknown>) ?? {};
  cash = BigInt((account["cash_quote_units"] as string) ?? "0");
  const positions = (account["positions"] as Array<Record<string, unknown>>) ?? [];
  let held: Record<string, unknown> | null = null;
  for (const position of positions) {
    if (position["symbol"] === SYMBOL) held = position;
  }
  posQty = held !== null ? BigInt(held["qty"] as string) : 0n;
  if (posQty === 0n && (state === "holding" || state === "selling")) {
    state = "flat";
    entryPrice = 0n;
  }
  if (posQty > 0n && state === "flat") {
    // Holding, but no fill was seen for it: rebuild the entry price from
    // the position's cost. Cost is the notional spent, and the fill itself
    // was the notional less the 4 bps fee, so the fill price is the cost
    // per unit scaled back up by 10000/9996 (to within integer rounding).
    state = "holding";
    const cost = BigInt(held!["cost_quote_units"] as string);
    entryPrice = (cost * 10000000n * 10000n) / (posQty * 9996n);
    bestGainBps = 0n;
  }

  const bars = (msg["bars"] as Array<Record<string, unknown>>) ?? [];
  for (const bar of bars) {
    if (bar["symbol"] === SYMBOL) closes.push(BigInt(bar["c"] as string));
  }

  const orders: Order[] = [];
  if (seq >= warmupBars && closes.length > 0) {
    const close = closes[closes.length - 1];
    if (state === "holding" && posQty > 0n && entryPrice > 0n) {
      const gainBps = ((close - entryPrice) * 10000n) / entryPrice;
      if (gainBps > bestGainBps) bestGainBps = gainBps;
      const trailing =
        bestGainBps >= TRAIL_ARM_BPS &&
        gainBps <= bestGainBps - TRAIL_DROP_BPS;
      if (
        gainBps >= TAKE_PROFIT_BPS ||
        gainBps <= -STOP_BPS ||
        trailing
      ) {
        orders.push({
          side: "sell",
          client_id: `o${nextId}`,
          symbol: SYMBOL,
          qty: posQty.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        nextId += 1;
        state = "selling";
      }
    } else if (state === "flat" && closes.length > LOOKBACK) {
      if (seq < NO_ENTRY_AFTER && seq >= cooldownUntil) {
        const old = closes[closes.length - LOOKBACK - 1];
        const dipBps = ((old - close) * 10000n) / old;
        let threshold = DIP_BPS;
        if (fillsDone === 0 && seq >= 900) threshold = FALLBACK_DIP_BPS;
        if (dipBps >= threshold && cash >= MIN_NOTIONAL) {
          orders.push({
            side: "buy",
            client_id: `o${nextId}`,
            symbol: SYMBOL,
            notional_quote_units: cash.toString(),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          nextId += 1;
          state = "buying";
        }
      }
    }
  }

  process.stdout.write(
    JSON.stringify({ type: "reply", seq, orders }) + "\n",
  );
}
