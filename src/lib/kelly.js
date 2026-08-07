// Kelly position sizing — advisory only, never executed.
//
// Ported from FinSurfing's lib/kelly.js, including the point its comments are
// emphatic about: the win probability must come from *measured* calibration,
// never from a confidence letter the same engine invented. Feeding a model's
// self-reported confidence into Kelly as a probability is the common mistake,
// and it sizes positions on nothing.
//
// That input now exists here: the prediction ledger resolves past calls, so
// `winProbFrom()` reads a real win rate off the scorecard and says so. Until
// enough calls have resolved, it declines to pretend — the fallback is flagged
// and the suggested size is small.

/**
 * Full Kelly fraction for a bet returning +winFrac with probability p, or
 * −lossFrac otherwise: f* = (p·W − q·L) / (W·L).
 *
 * Clamped at zero — a non-positive edge is never sized — and may exceed 1 when
 * the stop is tight, which is why callers must fraction and cap it.
 */
export function fullKelly(p, winFrac, lossFrac) {
  const W = winFrac;
  const L = lossFrac;
  const q = 1 - p;
  if (!(p > 0 && p < 1) || !(W > 0) || !(L > 0)) return 0;
  const f = (p * W - q * L) / (W * L);
  return f > 0 ? f : 0;
}

/** Expected value per unit risked. At or below zero there is no edge to size. */
export function edge(p, winFrac, lossFrac) {
  if (!(p >= 0 && p <= 1)) return 0;
  return p * winFrac - (1 - p) * lossFrac;
}

/**
 * Suggested size as a fraction of the portfolio.
 *
 * Two guardrails, both deliberate: a fractional multiplier (half Kelly by
 * default, because full Kelly assumes the probability is exactly right) and a
 * hard cap, because a tight stop makes full Kelly ask for leverage.
 */
export function suggestedSize({
  winProb,
  winFrac,
  lossFrac,
  fraction = 0.5,
  maxFraction = 0.2,
}) {
  const full = fullKelly(winProb, winFrac, lossFrac);
  const fractioned = full * fraction;
  const suggested = Math.max(0, Math.min(fractioned, maxFraction));
  return {
    winProb: +Number(winProb).toFixed(3),
    fullKellyPct: +(full * 100).toFixed(1),
    suggestedPct: +(suggested * 100).toFixed(1),
    capped: fractioned > maxFraction,
    edgePerUnit: +edge(winProb, winFrac, lossFrac).toFixed(4),
    fraction,
    maxPct: +(maxFraction * 100).toFixed(1),
  };
}

/**
 * Read an empirical win probability off the prediction scorecard.
 *
 * Prefers the calibration bucket for this conviction level when it has enough
 * resolved calls behind it, then the overall win rate, and only then a
 * conservative default — which is always labelled as such, because a size
 * derived from a guess should never look like one derived from evidence.
 *
 * A measured win rate of zero is evidence, not a missing value: it sizes to
 * nothing, which is the correct answer.
 */
export function winProbFrom(card, { conviction = null, fallback = 0.4, minN = 15 } = {}) {
  const bucket = conviction && card?.calibration?.[conviction];
  if (bucket && typeof bucket.winRate === 'number' && bucket.n >= minN) {
    return { p: bucket.winRate, source: `calibration:${conviction} (n=${bucket.n})`, measured: true };
  }
  if (card && typeof card.winRate === 'number' && card.tradeable >= minN) {
    return {
      p: card.winRate,
      source: `overall ${card.horizonDays}d win rate (n=${card.tradeable})`,
      measured: true,
    };
  }
  return {
    p: fallback,
    source: `default ${fallback} — not enough resolved calls to measure yet`,
    measured: false,
  };
}

/**
 * Size a specific call from its own target/stop and the measured win rate.
 *
 * @param {{price:number, target:number, stop:number, conviction?:string, label?:string}} call
 * @param {object} card scorecard from lib/predictions
 */
export function sizeCall(call, card, options = {}) {
  const price = Number(call.price);
  const target = Number(call.target);
  const stop = Number(call.stop);
  if (!(price > 0) || !Number.isFinite(target) || !Number.isFinite(stop)) {
    return { ok: false, error: 'price, target and stop are required' };
  }

  // A short profits when price falls, so the payoff legs swap.
  const short = String(call.label || 'BUY').toUpperCase() === 'SELL';
  const winFrac = short ? (price - target) / price : (target - price) / price;
  const lossFrac = short ? (stop - price) / price : (price - stop) / price;

  if (!(winFrac > 0) || !(lossFrac > 0)) {
    return {
      ok: false,
      error: 'target and stop are on the wrong sides of price for this direction',
    };
  }

  const prob = winProbFrom(card, { conviction: call.conviction, ...options });
  const size = suggestedSize({
    winProb: prob.p,
    winFrac,
    lossFrac,
    fraction: options.fraction ?? 0.5,
    maxFraction: options.maxFraction ?? 0.2,
  });

  return {
    ok: true,
    ...size,
    winFracPct: +(winFrac * 100).toFixed(2),
    lossFracPct: +(lossFrac * 100).toFixed(2),
    rewardToRisk: +(winFrac / lossFrac).toFixed(2),
    probabilitySource: prob.source,
    // Surfaced rather than buried: a size built on the default probability is
    // a placeholder, and should read as one.
    measured: prob.measured,
    note: prob.measured
      ? 'Sized from measured calibration. Advisory only.'
      : 'Not enough resolved calls to measure a win rate — treat this size as a placeholder.',
  };
}
