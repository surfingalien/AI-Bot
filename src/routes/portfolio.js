// GET  /api/portfolio  — positions priced live, with P&L
// PUT  /api/portfolio  — replace the held positions
//
// The desk can only value its holdings while a tab is open. Doing it here means
// the answer survives the browser, and the autonomy loop can report it on a
// schedule.

import { Router } from 'express';
import { getState, saveState } from '../autonomy/store.js';
import { valuePortfolio, portfolioMarkdown } from '../lib/portfolio.js';
import { normalizeSymbol } from '../market/yahoo.js';
import { rateLimit } from '../lib/rateLimit.js';

export const portfolioRouter = Router();

portfolioRouter.get('/portfolio', rateLimit({ name: 'portfolio', max: 60 }), async (req, res) => {
  const valuation = await valuePortfolio();
  const body = { ok: true, ...valuation };
  if (req.query.markdown === '1') body.markdown = portfolioMarkdown(valuation);
  return res.json(body);
});

portfolioRouter.put('/portfolio', (req, res) => {
  const input = Array.isArray(req.body?.positions) ? req.body.positions : null;
  if (!input) return res.status(400).json({ ok: false, error: 'positions[] required' });

  const positions = [];
  const rejected = [];
  for (const raw of input) {
    const sym = normalizeSymbol(raw?.sym);
    const shares = Number(raw?.shares);
    if (!sym || !Number.isFinite(shares)) {
      rejected.push(raw);
      continue;
    }
    positions.push({ sym, shares, cost: Number(raw?.cost) || 0 });
  }

  const state = getState();
  state.portfolio = positions;
  saveState({ immediate: true });
  return res.json({ ok: true, portfolio: positions, rejected });
});
