// Portfolio valuation.
//
// The desk holds positions but can only price them while a tab is open. Doing
// it here means "how's my portfolio doing" has a real answer, the autonomy loop
// can report P&L on a schedule, and the number survives the browser being shut.
//
// Every position is priced independently: one unreachable symbol costs that
// row, not the whole portfolio.

import { snapshot } from '../market/yahoo.js';
import { getState } from '../autonomy/store.js';

function round(n, dp = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * @returns {Promise<{positions:Array, totals:object, asOf:string, incomplete:string[]}>}
 */
export async function valuePortfolio(positions) {
  const holdings = positions || getState().portfolio || [];
  if (!holdings.length) {
    return {
      positions: [],
      totals: { value: 0, cost: 0, pnl: 0, pnlPct: null, dayChange: 0, dayChangePct: null },
      asOf: new Date().toISOString(),
      incomplete: [],
    };
  }

  const priced = await Promise.all(
    holdings.map(async (h) => {
      const shares = Number(h.shares) || 0;
      const cost = Number(h.cost) || 0;
      try {
        const snap = await snapshot(h.sym);
        const price = snap.indicators?.last ?? snap.quote?.regularMarketPrice ?? null;
        if (price == null) throw new Error('no price available');

        const value = price * shares;
        const basis = cost * shares;
        const dayPct = snap.indicators?.chgPct ?? snap.quote?.regularMarketChangePercent ?? null;
        // Day change in currency, derived from the percentage move on today's
        // value — the previous close is not always in the payload.
        const dayChange = dayPct != null ? value - value / (1 + dayPct / 100) : null;

        return {
          sym: snap.symbol,
          name: snap.quote?.shortName || null,
          shares,
          cost: round(cost),
          price: round(price),
          value: round(value),
          basis: round(basis),
          pnl: round(value - basis),
          pnlPct: basis ? round(((value - basis) / basis) * 100) : null,
          dayChangePct: round(dayPct),
          dayChange: round(dayChange),
          priced: true,
        };
      } catch (err) {
        return {
          sym: String(h.sym || '').toUpperCase(),
          shares,
          cost: round(cost),
          price: null,
          value: null,
          basis: round(cost * shares),
          pnl: null,
          pnlPct: null,
          priced: false,
          error: err?.message || String(err),
        };
      }
    }),
  );

  const usable = priced.filter((p) => p.priced);
  const value = usable.reduce((a, p) => a + (p.value || 0), 0);
  const cost = usable.reduce((a, p) => a + (p.basis || 0), 0);
  const dayChange = usable.reduce((a, p) => a + (p.dayChange || 0), 0);
  const openingValue = value - dayChange;

  return {
    positions: priced.sort((a, b) => (b.value || 0) - (a.value || 0)),
    totals: {
      value: round(value),
      cost: round(cost),
      pnl: round(value - cost),
      pnlPct: cost ? round(((value - cost) / cost) * 100) : null,
      dayChange: round(dayChange),
      dayChangePct: openingValue ? round((dayChange / openingValue) * 100) : null,
      positions: priced.length,
    },
    asOf: new Date().toISOString(),
    // Named explicitly so a partial valuation is never mistaken for a complete
    // one — the totals below exclude these.
    incomplete: priced.filter((p) => !p.priced).map((p) => p.sym),
  };
}

/** A written summary; the voice layer turns this into something speakable. */
export function portfolioMarkdown(valuation) {
  const { positions, totals, incomplete } = valuation;
  if (!positions.length) return '## Portfolio\n\n_No positions recorded._';

  const sign = (n) => (n == null ? 'N/A' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}`);
  const rows = positions
    .map((p) =>
      p.priced
        ? `| ${p.sym} | ${p.shares} | $${p.cost} | $${p.price} | $${p.value} | ${sign(p.pnl)} (${sign(
            p.pnlPct,
          )}%) | ${sign(p.dayChangePct)}% |`
        : `| ${p.sym} | ${p.shares} | $${p.cost} | — | — | UNVERIFIED | — |`,
    )
    .join('\n');

  return [
    `## Portfolio — ${new Date(valuation.asOf).toISOString().slice(0, 10)}`,
    '',
    '| Symbol | Shares | Cost | Price | Value | P&L | Day |',
    '|---|---|---|---|---|---|---|',
    rows,
    '',
    `**Total value** $${totals.value} · **cost** $${totals.cost} · **P&L** ${sign(
      totals.pnl,
    )} (${sign(totals.pnlPct)}%) · **today** ${sign(totals.dayChange)} (${sign(
      totals.dayChangePct,
    )}%)`,
    incomplete.length
      ? `\n_${incomplete.join(', ')} could not be priced and are excluded from the totals._`
      : '',
    '\n_Not financial advice._',
  ].join('\n');
}
