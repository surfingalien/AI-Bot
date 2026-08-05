// GET /api/yahoo/chart/:symbol and /api/yahoo/quote/:symbol — the live data
// feed. Responses keep Yahoo's own envelope so the browser engine's
// parseChart()/parseQuote() work unchanged.

import { Router } from 'express';
import { fetchChart, fetchQuote, snapshot } from '../market/yahoo.js';
import { FetchError } from '../lib/safeFetch.js';
import { rateLimit } from '../lib/rateLimit.js';

export const yahooRouter = Router();

const limiter = rateLimit({ name: 'market', max: 120 });

function fail(res, err) {
  const status = err instanceof FetchError ? err.status : 502;
  return res.status(status).json({ ok: false, error: err?.message || String(err) });
}

yahooRouter.get('/yahoo/chart/:symbol', limiter, async (req, res) => {
  try {
    const json = await fetchChart(req.params.symbol, {
      range: req.query.range,
      interval: req.query.interval,
    });
    return res.json(json);
  } catch (err) {
    return fail(res, err);
  }
});

yahooRouter.get('/yahoo/quote/:symbol', limiter, async (req, res) => {
  try {
    return res.json(await fetchQuote(req.params.symbol));
  } catch (err) {
    return fail(res, err);
  }
});

// Convenience endpoint for scripts and the autonomy UI: quote plus every
// indicator the dossier needs, already computed.
yahooRouter.get('/market/snapshot/:symbol', limiter, async (req, res) => {
  try {
    const snap = await snapshot(req.params.symbol);
    return res.json({ ok: true, ...snap, closes: undefined });
  } catch (err) {
    return fail(res, err);
  }
});
