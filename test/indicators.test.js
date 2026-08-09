import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adx,
  computeIndicators,
  localSignal,
  rsi,
  rsiWilder,
  sma,
  stdev,
  thesisAssumptions,
} from '../src/lib/indicators.js';

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

test("Wilder's RSI smooths forward and differs from the desk's simple average", () => {
  // A sawtooth: the two definitions genuinely disagree here, which is why both
  // are reported rather than one silently replacing the other.
  const closes = series(120, (i) => 100 + (i % 2 ? 3 : 0) + i * 0.1);
  const wilder = rsiWilder(closes);
  const simple = rsi(closes);

  assert.ok(wilder > 0 && wilder < 100);
  assert.notEqual(Math.round(wilder), Math.round(simple));
  assert.equal(rsiWilder([1, 2], 14), null, 'too short to compute');
});

test("Wilder's RSI is bounded and sane at the extremes", () => {
  assert.equal(rsiWilder(series(60, (i) => 100 + i)), 100, 'no downside at all');
  assert.ok(rsiWilder(series(60, (i) => 200 - i)) < 1);
  assert.equal(rsiWilder(series(60, () => 100)), 50, 'a flat series is neutral, not undefined');
});

test('ADX measures trend strength independently of direction', () => {
  const strongUp = series(200, (i) => 100 + i * 0.8);
  const chop = series(200, (i) => 100 + Math.sin(i / 2) * 3);
  const trend = adx(
    strongUp.map((c) => c + 1),
    strongUp.map((c) => c - 1),
    strongUp,
  );
  const choppy = adx(
    chop.map((c) => c + 1),
    chop.map((c) => c - 1),
    chop,
  );

  assert.ok(trend > choppy, `a clean trend should read stronger (${trend} vs ${choppy})`);
  assert.ok(trend >= 0 && trend <= 100);
  assert.equal(adx([1, 2], [1, 2], [1, 2]), null);
});

test('a weak trend caps conviction rather than being reported and ignored', () => {
  const chop = series(300, (i) => 100 + i * 0.25 + Math.sin(i / 2) * 6);
  const ind = computeIndicators({
    closes: chop,
    highs: chop.map((c) => c + 2),
    lows: chop.map((c) => c - 2),
    dates: [],
    meta: {},
  });
  const sig = localSignal({ ...ind, adx: 12, s50: 1, s200: 0, last: 100, rsi: 45, macdHist: 1, m1: 5 });

  assert.notEqual(sig.conv, 'H', 'high conviction is withheld when the trend is weak');
  assert.ok(sig.reasons.some((r) => /ADX below 20/.test(r)), 'and the reason is stated');
});

test('the signal quotes an entry zone, not a false-precision point', () => {
  const closes = series(300, (i) => 100 + i * 0.4);
  const ind = computeIndicators({
    closes,
    highs: closes.map((c) => c + 1),
    lows: closes.map((c) => c - 1),
    dates: [],
    meta: {},
  });
  const sig = localSignal(ind);

  assert.ok(sig.entryLow < sig.entry && sig.entry < sig.entryHigh);
  assert.ok(sig.entryHigh - sig.entryLow > 0, 'the zone has width');
  assert.ok(sig.entryHigh - sig.entryLow < ind.last * 0.2, 'but is not uselessly wide');
});

test('thesis assumptions are written in the goal grammar so they can be armed', async () => {
  const closes = series(300, (i) => 100 + i * 0.4);
  const ind = computeIndicators({
    closes,
    highs: closes.map((c) => c + 1),
    lows: closes.map((c) => c - 1),
    dates: [],
    meta: {},
  });
  const assumptions = thesisAssumptions(ind, 'BUY', 'NVDA');

  assert.ok(assumptions.length >= 2);
  // Each one must parse as a condition the autonomy loop can actually evaluate.
  const { parseCondition } = await import('../src/autonomy/conditions.js');
  for (const text of assumptions) {
    assert.notEqual(parseCondition(text).kind, 'invalid', `unusable assumption: ${text}`);
  }
});
