import test from 'node:test';
import assert from 'node:assert/strict';
import { edge, fullKelly, sizeCall, suggestedSize, winProbFrom } from '../src/lib/kelly.js';

test('full Kelly follows the formula and refuses a non-positive edge', () => {
  // p=0.6, win +50%, loss -50% -> (0.6*0.5 - 0.4*0.5) / 0.25 = 0.4
  assert.equal(+fullKelly(0.6, 0.5, 0.5).toFixed(4), 0.4);
  assert.equal(fullKelly(0.4, 0.5, 0.5), 0, 'a losing edge sizes to nothing');
  assert.equal(fullKelly(0.5, 0.5, 0.5), 0, 'a coin flip with symmetric payoff has no edge');
  assert.equal(fullKelly(0, 0.5, 0.5), 0);
  assert.equal(fullKelly(1, 0.5, 0.5), 0, 'certainty is rejected as an input, not sized to infinity');
});

test('edge is expected value per unit risked', () => {
  assert.equal(+edge(0.6, 0.5, 0.5).toFixed(4), 0.1);
  assert.ok(edge(0.3, 0.2, 0.5) < 0);
});

test('sizing is fractioned and hard-capped, because a tight stop asks for leverage', () => {
  // Full Kelly here exceeds 100% of the portfolio.
  const tight = suggestedSize({ winProb: 0.7, winFrac: 0.3, lossFrac: 0.02 });
  assert.ok(tight.fullKellyPct > 100, 'full Kelly wants leverage');
  assert.equal(tight.suggestedPct, 20, 'the cap holds');
  assert.equal(tight.capped, true);

  const half = suggestedSize({ winProb: 0.6, winFrac: 0.5, lossFrac: 0.5, fraction: 0.5 });
  assert.equal(half.suggestedPct, 20, 'half of 40% still meets the 20% cap');
  const quarter = suggestedSize({ winProb: 0.6, winFrac: 0.5, lossFrac: 0.5, fraction: 0.25 });
  assert.equal(quarter.suggestedPct, 10);
});

test('the win probability comes from measured calibration, never a confidence letter', () => {
  const card = {
    horizonDays: 30,
    winRate: 0.55,
    tradeable: 40,
    calibration: { H: { n: 20, winRate: 0.7 }, L: { n: 20, winRate: 0.4 } },
  };

  const high = winProbFrom(card, { conviction: 'H' });
  assert.equal(high.p, 0.7);
  assert.equal(high.measured, true);
  assert.match(high.source, /calibration:H \(n=20\)/);

  // Too few samples in the bucket -> fall back to the overall measured rate.
  const thin = winProbFrom({ ...card, calibration: { H: { n: 3, winRate: 0.9 } } }, { conviction: 'H' });
  assert.equal(thin.p, 0.55);
  assert.match(thin.source, /overall 30d win rate/);
});

test('with nothing resolved yet it declines to pretend', () => {
  const prob = winProbFrom({ tradeable: 0, calibration: {} }, { conviction: 'H' });
  assert.equal(prob.measured, false);
  assert.equal(prob.p, 0.4);
  assert.match(prob.source, /not enough resolved calls/);
});

test('a measured win rate of zero is evidence, not a missing value', () => {
  const card = { horizonDays: 30, winRate: 0, tradeable: 30, calibration: {} };
  const prob = winProbFrom(card);
  assert.equal(prob.p, 0, 'it sizes to nothing rather than substituting the optimistic default');
  assert.equal(prob.measured, true);
});

test('a call is sized from its own target and stop', () => {
  const card = {
    horizonDays: 30,
    winRate: 0.6,
    tradeable: 50,
    calibration: { M: { n: 30, winRate: 0.6 } },
  };
  const sized = sizeCall(
    { price: 100, target: 130, stop: 90, label: 'BUY', conviction: 'M' },
    card,
  );

  assert.equal(sized.ok, true);
  assert.equal(sized.winFracPct, 30);
  assert.equal(sized.lossFracPct, 10);
  assert.equal(sized.rewardToRisk, 3);
  assert.ok(sized.suggestedPct > 0 && sized.suggestedPct <= 20);
  assert.equal(sized.measured, true);
});

test('a short swaps the payoff legs rather than sizing backwards', () => {
  const card = { horizonDays: 30, winRate: 0.6, tradeable: 50, calibration: {} };
  const short = sizeCall({ price: 100, target: 80, stop: 110, label: 'SELL' }, card);

  assert.equal(short.ok, true);
  assert.equal(short.winFracPct, 20, 'a short profits as price falls');
  assert.equal(short.lossFracPct, 10);
});

test('a target and stop on the wrong sides are refused, not silently sized', () => {
  const card = { horizonDays: 30, winRate: 0.6, tradeable: 50, calibration: {} };
  const wrong = sizeCall({ price: 100, target: 80, stop: 90, label: 'BUY' }, card);
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /wrong sides/);

  assert.equal(sizeCall({ price: 0, target: 10, stop: 5 }, card).ok, false);
});

test('an unmeasured size is labelled as a placeholder', () => {
  const sized = sizeCall(
    { price: 100, target: 120, stop: 95, label: 'BUY', conviction: 'H' },
    { tradeable: 0, calibration: {} },
  );
  assert.equal(sized.measured, false);
  assert.match(sized.note, /placeholder/);
});

test('personas frame the analysis without licensing new numbers', async () => {
  const { getPersona, listPersonas, personaSystemPrompt } = await import('../src/lib/personas.js');

  assert.ok(listPersonas().length >= 5);
  assert.equal(getPersona('buffett').name, 'Warren Buffett');
  assert.equal(getPersona('nonsense').id, 'neutral', 'an unknown persona falls back, never throws');
  assert.equal(getPersona().id, 'neutral');

  const prompt = personaSystemPrompt('buffett', 'BASE INSTRUCTIONS HERE');
  assert.match(prompt, /moat/i, 'the persona lens is present');
  assert.match(prompt, /PERSONA CONSTRAINTS/);
  assert.match(prompt, /BASE INSTRUCTIONS HERE/, 'the base task survives the framing');
  // The honesty rules come last so they outrank the persona.
  assert.ok(
    prompt.indexOf('UNVERIFIED') > prompt.indexOf('PERSONA CONSTRAINTS'),
    'the rules that outrank the persona come after it',
  );
  assert.match(prompt, /never invent a number/i);
});
