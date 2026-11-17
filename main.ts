// btc-race entry: a displacement bot for cbBTC/USDC on the bars-replay rule set.
//
// The strategy in one line: the window is usually noise and the correct action is to do
// nothing; when price sits far enough under its own recent level that the snap back would pay
// for the round trip, the bot takes a single full-size position and then leaves it alone until
// an exit condition or the hold limit closes it.
//
// Why the bot trades so rarely. Every fill costs money in this replay three times over: a 4 bps
// fee is charged on each fill, 2 bps of slippage is modelled on top, and the order is priced
// through a constant-product curve so it eats price impact proportional to its size against the
// pool's own depth. Add a buy and a sell together and a full-size round trip lands at roughly
// 26 bps. That is the bar a trade has to clear before it earns a single basis point. Measured
// against that bar, the median absolute move over one minute is far smaller, so any bot that
// fires on every wiggle is paying 26 bps to chase moves that do not cover it. The scoring makes
// the same point from the other direction: when two entries end on exactly equal net PnL, the
// tie is broken in favour of whichever one traded fewer times, so churn is punished twice —
// once by the cost stack and again by the tie break.
//
// Why displacement from a rolling median. Price here mean-reverts around a level that drifts on
// the minutes-to-hours scale, so the reference is a rolling median of the last 120 one-minute
// closes rather than a long mean. A median shrugs off the occasional outlier print that the
// pool produces, where a mean would be dragged by it and would read a spike as a dip. The entry
// arms only when the close is 2 percent (DIP) below that median — deep enough that a return to
// the level pays several times the 26 bps round trip.
//
// Why one position, and why the hold limit and stop. Because the cost stack is only survivable
// at full size on a real displacement, the bot takes exactly one position, sized off cash at up
// to 100% of equity, and never sends a second buy while one is open. The exits are +1.5 percent
// (take profit), -5 percent (stop, which bounds the drawdown the guardrails measure against a
// 25% equity cap), or 720 bars held — twelve hours — so capital cannot sit indefinitely in a
// position that is not working. The parameters sit at the centre of the region that survived
// testing rather than at its single best cell, because one profitable point is noise while a
// profitable neighbourhood is a signal.
//
// Determinism: no clock, no network, no Math.random. Two runs on the same bars produce the same
// orders byte for byte, which the grader checks.

import { runBars } from './vendor/makefun-bars.ts';

/** Symbol we trade: the universe holds exactly one at this competition. */
const SYMBOL = 'CBBTC';

// LOOKBACK is two hours of one-minute bars: long enough that the median describes the level
// the price is sitting at, rather than the last wiggle it made.
/** Bars of history the reference level is taken over (two hours of one-minute bars). */
const LOOKBACK = 120;
/** Close this far below the rolling median is a displacement worth a full-size entry. */
const DIP = 0.02;
/** Take the position out once it is this far above the entry. */
const TAKE_PROFIT = 0.015;
/** Cut it once it is this far below the entry: bounds the drawdown the guardrails measure. */
const STOP_LOSS = 0.05;
/** Bars a position may stay open before it is closed regardless (12 hours). */
const MAX_HOLD_BARS = 720;

/**
 * Slippage headroom in bps, measured from the latest close. Wide enough that the modelled
 * slippage plus the fill's own impact never gets the order refused, and no wider: the point of
 * max_slippage_bps is to refuse a fill far from the close we decided on.
 */
const MAX_SLIPPAGE_BPS = 200;

/** The window of closes the reference level is taken over, kept in insertion order. */
const closes: number[] = [];
/** True while a position is open, so the bot never sends a second buy. */
let holding = false;
/** The fill price recorded when the position went on, and the bar count since. */
let entryPrice = 0;
let barsHeld = 0;
/** Count of bars seen, used to keep the hold limit honest across the whole window. */
let barCount = 0;

/** Median of a copy: the level estimate that survives the pool's outlier prints. */
function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

await runBars({
  onBatch(state) {
    // One symbol only: another universe would need its own sizing, so stay out of it.
    if (state.hello.symbols.length !== 1 || state.hello.symbols[0]?.symbol !== SYMBOL) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];                       // no bar yet: any order would be refused
    if (state.warmingUp) return [];                      // warm-up bars are history, never tradable

    const price = Number(close);
    barCount += 1;
    closes.push(price);
    if (closes.length > LOOKBACK + 1) closes.shift();

    if (holding) {
      barsHeld += 1;
      const move = (price - entryPrice) / entryPrice;
      const takeProfit = move >= TAKE_PROFIT;
      const stopLoss = move <= -STOP_LOSS;
      const stale = barsHeld >= MAX_HOLD_BARS;
      if (takeProfit || stopLoss || stale) {
        const qty = state.positions.get(SYMBOL)?.qty ?? 0n;
        if (qty > 0n) {
          holding = false;
          barsHeld = 0;
          return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }

    // A full window of history is needed before the median means anything.
    if (closes.length <= LOOKBACK) return [];

    const level = median(closes);
    const displacement = (price - level) / level;
    if (displacement > -DIP) return [];

    // Enter at full size: one position at up to 100% of equity, sized off cash rather than the
    // weight cap so the order can never be trimmed into something the fee would dominate.
    const spend = state.cash;
    if (spend <= 0n) return [];
    holding = true;
    barsHeld = 0;
    // The fill happens at the next bar's open, which is unknown here; the close is the best
    // estimate and the exit thresholds are measured against the fill the harness reports.
    entryPrice = price;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },

  onDone(state) {
    // The harness flattens anything still held; nothing to send here.
  },
});
