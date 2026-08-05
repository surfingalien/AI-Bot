import test from 'node:test';
import assert from 'node:assert/strict';
import { computeIndicators, localSignal, rsi, sma, stdev } from '../src/lib/indicators.js';

const series = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

test('sma averages the trailing window only', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
  assert.equal(sma([10, 10, 10, 1, 1], 2), 1);
  assert.equal(sma([1, 2], 5), null);
});

test('stdev of a constant series is zero', () => {
  assert.equal(stdev([4, 4, 4, 4]), 0);
  assert.equal(stdev([1]), 0);
});

test('rsi saturates on an uninterrupted advance and bottoms out on a decline', () => {
  // With zero downside the engine substitutes rs = 100 rather than dividing by
  // zero, which lands at 99.01 instead of a clean 100.
  assert.ok(rsi(series(30, (i) => 100 + i)) > 99);
  assert.ok(rsi(series(30, (i) => 200 - i)) < 1);
  assert.equal(rsi([1, 2], 14), null);
});

test('computeIndicators derives a bull trend from a rising series', () => {
  const closes = series(300, (i) => 100 + i * 0.5);
  const ind = computeIndicators({
    closes,
    highs: closes.map((c) => c + 1),
    lows: closes.map((c) => c - 1),
    dates: series(300, (i) => Math.floor(Date.now() / 1000) - (300 - i) * 86400),
    meta: {},
  });

  assert.equal(ind.n, 300);
  assert.equal(ind.trend, 'BULL');
  assert.ok(ind.s50 > ind.s200);
  assert.ok(ind.last > ind.s50);
  assert.ok(ind.atr > 0);
  assert.ok(ind.macdHist != null);
  assert.ok(ind.m1 > 0 && ind.y1 > 0);
});

test('computeIndicators marks a falling series bearish', () => {
  const closes = series(300, (i) => 400 - i * 0.5);
  const ind = computeIndicators({
    closes,
    highs: closes.map((c) => c + 1),
    lows: closes.map((c) => c - 1),
    dates: [],
    meta: {},
  });
  assert.equal(ind.trend, 'BEAR');
  assert.ok(ind.s50 < ind.s200);
});

test('localSignal scores an accelerating uptrend BUY and a fading tape SELL', () => {
  // An accelerating advance keeps MACD positive; a straight line would not,
  // which is exactly why the scorer holds on one and buys the other.
  const build = (fn) => {
    const closes = series(300, fn);
    return computeIndicators({
      closes,
      highs: closes.map((c) => c + 1),
      lows: closes.map((c) => c - 1),
      dates: [],
      meta: {},
    });
  };
  const up = build((i) => 100 + Math.pow(i, 1.3) * 0.2);
  const down = build((i) => 400 - i * 0.5 + 6 * Math.sin(i / 7));

  const buy = localSignal(up);
  const sell = localSignal(down);
  assert.equal(buy.label, 'BUY');
  assert.equal(sell.label, 'SELL');
  assert.ok(buy.stop < buy.entry && buy.target > buy.entry);
  assert.ok(buy.reasons.length >= 4);
});
