// Frost Burst 2 — long-only dip-buying bot for cbBTC/USDC, 1-minute bars.
//
// Strategy: buy sharp short-window dips only once the price is already
// bouncing back, then exit fast on a small take-profit or on a wide
// trailing stop. One open position at a time, full cash per trade.
// Pure function of the bars: no clock, no environment, no randomness,
// so the two graded executions answer identically.
//
// Rule A (quick dip): 15-bar return <= -40 bps AND 5-bar return > 0,
// take-profit +60 bps from the fill price, trailing stop -200 bps
// from the highest close since the fill. 10-bar cooldown after a sell.
//
// Rule C (deep dip): 30-bar return <= -150 bps, no bounce needed —
// a washout this deep usually marks a local bottom, so the bot takes
// the trade and gives it room: take-profit +200 bps, trailing stop
// -200 bps. Whichever rule fires sets the exit for that position.

import { runBars } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const BPS = 10_000n;
const MAX_SLIPPAGE_BPS = 100;

// Rolling close history (raw price units, newest last).
const closes: bigint[] = [];
let barCount = 0;
let lastSellBar = -1_000_000;
// Fill price of the open position (raw units) and its highest close.
let entryPx: bigint | null = null;
let peakPx: bigint | null = null;
// Exit parameters of the open position, set by the rule that fired.
let exitTpBps = 60n;
let exitTrailBps = 200n;
// Exit parameters for the buy order just sent; applied when it fills.
let pendingTpBps = 60n;
let pendingTrailBps = 200n;

function retBps(now: bigint, ago: bigint): bigint {
  return ((now - ago) * BPS) / ago;
}

await runBars({
  onBatch(state, batch) {
    // First fold in the fills of the orders decided on the previous bar.
    for (const fill of batch.fills) {
      if (fill.status !== "filled" || fill.symbol !== SYMBOL) continue;
      if (fill.side === "buy") {
        entryPx = BigInt(fill.price);
        peakPx = entryPx;
        exitTpBps = pendingTpBps;
        exitTrailBps = pendingTrailBps;
      } else {
        entryPx = null;
        peakPx = null;
        lastSellBar = barCount;
      }
    }

    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes.push(close);
    if (closes.length > 61) closes.shift();
    barCount += 1;

    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const qty = held === undefined ? 0n : BigInt(held.qty);

    if (qty > 0n) {
      // Manage the open position: exits are judged on closes, and the
      // order fills at the next bar's open.
      if (entryPx !== null) {
        if (peakPx === null || close > peakPx) peakPx = close;
        const takeProfitPx = (entryPx * (BPS + exitTpBps)) / BPS;
        const trailPx = (peakPx * (BPS - exitTrailBps)) / BPS;
        if (close >= takeProfitPx || close <= trailPx) {
          return [
            {
              side: "sell",
              symbol: SYMBOL,
              qty,
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            },
          ];
        }
      }
      return [];
    }

    // Flat: look for the quick-dip entry.
    if (barCount - lastSellBar <= 10) return [];
    if (closes.length < 16) return [];
    const now = closes[closes.length - 1]!;
    const ago15 = closes[closes.length - 16]!;
    const ago5 = closes[closes.length - 6]!;
    if (retBps(now, ago15) <= -40n && retBps(now, ago5) > 0n) {
      const cash = state.cash;
      if (cash < 1_000_000n) return [];
      pendingTpBps = 60n;
      pendingTrailBps = 200n;
      return [
        {
          side: "buy",
          symbol: SYMBOL,
          notional_quote_units: cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    // Rule C: a 30-bar washout of -150 bps or worse needs no bounce —
    // the dip itself is the signal, and the exit is given more room.
    if (closes.length >= 31) {
      const ago30 = closes[closes.length - 31]!;
      if (retBps(now, ago30) <= -150n) {
        const cash = state.cash;
        if (cash < 1_000_000n) return [];
        pendingTpBps = 200n;
        pendingTrailBps = 200n;
        return [
          {
            side: "buy",
            symbol: SYMBOL,
            notional_quote_units: cash,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
    }
    return [];
  },
});
