// GET  /api/predictions            the ledger plus a deterministic scorecard
// POST /api/predictions            log a call by hand
// POST /api/predictions/resolve    score everything old enough to have an answer

import { Router } from 'express';
import {
  logPrediction,
  readPredictions,
  resolveOutcomes,
  scorecard,
  scorecardMarkdown,
} from '../lib/predictions.js';
import { rateLimit } from '../lib/rateLimit.js';

export const predictionsRouter = Router();

predictionsRouter.get('/predictions', (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const horizon = req.query.horizon === '7' ? 7 : 30;
  const card = scorecard({ horizon });

  const body = {
    ok: true,
    scorecard: card,
    predictions: readPredictions().slice(-limit).reverse(),
  };
  if (req.query.markdown === '1') body.markdown = scorecardMarkdown(card);
  return res.json(body);
});

predictionsRouter.post('/predictions', (req, res) => {
  const record = logPrediction(req.body || {});
  if (!record) return res.status(400).json({ ok: false, error: 'symbol required' });
  return res.status(201).json({ ok: true, prediction: record });
});

// Resolution walks history for every unresolved symbol, so it is rate limited
// harder than a read.
predictionsRouter.post(
  '/predictions/resolve',
  rateLimit({ name: 'resolve', max: 6 }),
  async (_req, res) => {
    const result = await resolveOutcomes();
    return res.json({ ok: true, ...result, scorecard: scorecard() });
  },
);
