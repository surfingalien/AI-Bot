import test from 'node:test';
import assert from 'node:assert/strict';
import { conditionSymbols, evaluateCondition, parseCondition } from '../src/autonomy/conditions.js';
import { parseAction } from '../src/autonomy/actions.js';

test('parses every supported condition form', () => {
  assert.equal(parseCondition('always').kind, 'always');
  assert.deepEqual(parseCondition('at 09:30'), { kind: 'time', hh: 9, mm: 30 });
  assert.deepEqual(parseCondition('memory contains Earnings'), {
    kind: 'memory',
    query: 'earnings',
  });
  assert.equal(parseCondition('tasks open').kind, 'tasksOpen');
  assert.deepEqual(parseCondition('price(NVDA) > 140'), {
    kind: 'metric',
    metric: 'price',
    symbol: 'NVDA',
    op: '>',
    value: 140,
  });
  assert.deepEqual(parseCondition('rsi($aapl) <= 30'), {
    kind: 'metric',
    metric: 'rsi',
    symbol: 'AAPL',
    op: '<=',
    value: 30,
  });
});

test('rejects nonsense and out-of-range times', () => {
  assert.equal(parseCondition('').kind, 'invalid');
  assert.equal(parseCondition('when the moon is full').kind, 'invalid');
  assert.equal(parseCondition('at 25:00').kind, 'invalid');
  assert.equal(parseCondition('price(NVDA) ~ 140').kind, 'invalid');
});

test('conditionSymbols lists the symbols a condition needs', () => {
  assert.deepEqual(conditionSymbols('price(NVDA) > 140'), ['NVDA']);
  assert.deepEqual(conditionSymbols('rsi(msft) < 30'), ['MSFT']);
  assert.deepEqual(conditionSymbols('always'), []);
});

test('metric conditions compare against the live feed', () => {
  const feed = { NVDA: { indicators: { last: 150, rsi: 72, chgPct: -2.5 } } };
  const check = (text) => evaluateCondition(parseCondition(text), { feed });

  assert.equal(check('price(NVDA) > 140'), true);
  assert.equal(check('price(NVDA) < 140'), false);
  assert.equal(check('rsi(NVDA) >= 70'), true);
  assert.equal(check('chg(NVDA) <= -2'), true);
});

test('a metric with no feed is undecidable, not false', () => {
  assert.equal(evaluateCondition(parseCondition('price(TSLA) > 1'), { feed: {} }), null);
  assert.equal(
    evaluateCondition(parseCondition('price(TSLA) > 1'), { feed: { TSLA: { indicators: {} } } }),
    null,
  );
});

test('memory conditions read durable state', () => {
  const state = { memory: [{ k: 'pref:chief', v: 'weekly earnings review' }] };
  assert.equal(evaluateCondition(parseCondition('memory contains earnings'), { state }), true);
  assert.equal(evaluateCondition(parseCondition('memory contains dividends'), { state }), false);
});

test('a time condition fires once per day', () => {
  const cond = parseCondition('at 09:30');
  const now = new Date('2026-01-15T10:00:00');
  assert.equal(evaluateCondition(cond, { now, goal: {} }), true);
  assert.equal(
    evaluateCondition(cond, { now, goal: { lastFireDay: now.toDateString() } }),
    false,
  );
  assert.equal(evaluateCondition(cond, { now: new Date('2026-01-15T08:00:00'), goal: {} }), false);
});

test('parses every supported action form', () => {
  assert.deepEqual(parseAction('notify markets opened'), {
    kind: 'notify',
    text: 'markets opened',
  });
  assert.deepEqual(parseAction('alert NVDA broke out'), { kind: 'alert', text: 'NVDA broke out' });
  assert.deepEqual(parseAction('remember focus = semis'), {
    kind: 'remember',
    key: 'focus',
    value: 'semis',
  });
  assert.equal(parseAction('scan watchlist').kind, 'scan');
  assert.deepEqual(parseAction('research AI capex cycle'), {
    kind: 'research',
    topic: 'AI capex cycle',
  });
  assert.equal(parseAction('digest').kind, 'digest');
  assert.equal(parseAction('rm -rf /').kind, 'invalid');
  assert.equal(parseAction('').kind, 'invalid');
});
