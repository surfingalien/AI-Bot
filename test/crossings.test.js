import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCondition,
  parseCondition,
  rememberReadings,
} from '../src/autonomy/conditions.js';

const feedAt = (last) => ({ NVDA: { indicators: { last, rsi: 50, chgPct: 0 } } });

test('crossings parse in both directions', () => {
  assert.deepEqual(parseCondition('price(NVDA) crosses above 140'), {
    kind: 'cross',
    metric: 'price',
    symbol: 'NVDA',
    direction: 'above',
    value: 140,
  });
  assert.deepEqual(parseCondition('rsi($aapl) crosses below 30'), {
    kind: 'cross',
    metric: 'rsi',
    symbol: 'AAPL',
    direction: 'below',
    value: 30,
  });
  assert.equal(parseCondition('price(NVDA) crosses sideways 140').kind, 'invalid');
});

test('a crossing needs a previous reading before it can fire', () => {
  const cond = parseCondition('price(NVDA) crosses above 140');
  const goal = {};
  // First sample only establishes the baseline, even though 150 > 140.
  assert.equal(evaluateCondition(cond, { feed: feedAt(150), goal }), null);
});

test('a crossing fires once on the transition, not while it stays true', () => {
  const cond = parseCondition('price(NVDA) crosses above 140');
  const goal = {};
  const step = (price) => {
    const feed = feedAt(price);
    const verdict = evaluateCondition(cond, { feed, goal });
    rememberReadings(cond, goal, feed);
    return verdict;
  };

  assert.equal(step(138), null, 'baseline');
  assert.equal(step(139), false, 'still below');
  assert.equal(step(141), true, 'crossed');
  assert.equal(step(145), false, 'above, but the crossing already happened');
  assert.equal(step(150), false);
  assert.equal(step(137), false, 'back below');
  assert.equal(step(142), true, 'crossed again after re-arming');
});

test('crossing below is the mirror image', () => {
  const cond = parseCondition('rsi(NVDA) crosses below 30');
  const goal = {};
  const step = (rsi) => {
    const feed = { NVDA: { indicators: { last: 100, rsi, chgPct: 0 } } };
    const verdict = evaluateCondition(cond, { feed, goal });
    rememberReadings(cond, goal, feed);
    return verdict;
  };

  assert.equal(step(45), null);
  assert.equal(step(32), false);
  assert.equal(step(28), true);
  assert.equal(step(25), false, 'oversold is not a new crossing');
  assert.equal(step(35), false);
  assert.equal(step(29), true);
});

test('touching the level exactly is not yet a crossing', () => {
  const cond = parseCondition('price(NVDA) crosses above 140');
  const goal = {};
  const step = (price) => {
    const feed = feedAt(price);
    const verdict = evaluateCondition(cond, { feed, goal });
    rememberReadings(cond, goal, feed);
    return verdict;
  };

  assert.equal(step(139), null);
  assert.equal(step(140), false, 'at the level, not through it');
  assert.equal(step(141), true, 'through it');
});

test('a crossing with no feed stays undecidable rather than false', () => {
  const cond = parseCondition('price(TSLA) crosses above 140');
  assert.equal(evaluateCondition(cond, { feed: {}, goal: {} }), null);
});

test('readings are tracked per symbol and metric', () => {
  const goal = {};
  const feed = {
    NVDA: { indicators: { last: 150, rsi: 71, chgPct: 2 } },
    AAPL: { indicators: { last: 220, rsi: 44, chgPct: -1 } },
  };
  rememberReadings(parseCondition('price(NVDA) crosses above 140'), goal, feed);
  rememberReadings(parseCondition('rsi(AAPL) crosses below 30'), goal, feed);

  assert.equal(goal.lastReading.NVDA.price, 150);
  assert.equal(goal.lastReading.AAPL.rsi, 44);
  assert.equal(goal.lastReading.NVDA.rsi, undefined, 'only what was asked for');
});
