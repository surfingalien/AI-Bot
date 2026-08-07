// Advisory sizing, persona listing, and manual report email.

import { Router } from 'express';
import { config } from '../config.js';
import { sizeCall } from '../lib/kelly.js';
import { scorecard, scorecardMarkdown } from '../lib/predictions.js';
import { listPersonas } from '../lib/personas.js';
import { emailConfigured, sendEmail } from '../lib/email.js';
import { valuePortfolio, portfolioMarkdown } from '../lib/portfolio.js';
import { snapshot } from '../market/yahoo.js';
import { localSignal } from '../lib/indicators.js';
import { rateLimit } from '../lib/rateLimit.js';

export const analysisRouter = Router();

analysisRouter.get('/personas', (_req, res) => {
  res.json({ ok: true, active: config.analysis.persona, personas: listPersonas() });
});

/**
 * Suggested position size for a call.
 *
 * Give it a symbol and it uses the rules engine's own target and stop; give it
 * explicit numbers and it uses those. Either way the win probability comes from
 * the ledger, never from the conviction letter.
 */
analysisRouter.post('/kelly', rateLimit({ name: 'kelly', max: 30 }), async (req, res) => {
  const body = req.body || {};
  const card = scorecard();
  const options = {
    fraction: Number(body.fraction) || config.analysis.kellyFraction,
    maxFraction: Number(body.maxFraction) || config.analysis.kellyMaxFraction,
    minN: config.analysis.kellyMinSamples,
  };

  let call = {
    price: Number(body.price),
    target: Number(body.target),
    stop: Number(body.stop),
    label: body.label,
    conviction: body.conviction,
  };

  if (body.symbol && !(call.price > 0)) {
    try {
      const snap = await snapshot(body.symbol);
      if (!snap.indicators) {
        return res.status(502).json({ ok: false, error: 'no indicators available for that symbol' });
      }
      const signal = localSignal(snap.indicators);
      call = {
        price: snap.indicators.last,
        target: signal.target,
        stop: signal.stop,
        label: signal.label,
        conviction: signal.conv,
      };
    } catch (err) {
      return res.status(502).json({ ok: false, error: err?.message || String(err) });
    }
  }

  const sized = sizeCall(call, card, options);
  if (!sized.ok) return res.status(400).json({ ok: false, error: sized.error });

  return res.json({
    ok: true,
    symbol: body.symbol ? String(body.symbol).toUpperCase() : null,
    call,
    sizing: sized,
    // Advisory only, and said out loud rather than left to be assumed.
    disclaimer: 'Advisory sizing from measured calibration. Nothing here places an order.',
  });
});

analysisRouter.post('/email', rateLimit({ name: 'email', max: 10 }), async (req, res) => {
  const report = String(req.body?.report || '').toLowerCase();
  let markdown = String(req.body?.markdown || '');
  let subject = String(req.body?.subject || '').trim();

  if (!markdown && report === 'scorecard') {
    const card = scorecard();
    markdown = scorecardMarkdown(card);
    subject = subject || 'Prediction scorecard';
  } else if (!markdown && report === 'portfolio') {
    markdown = portfolioMarkdown(await valuePortfolio());
    subject = subject || 'Portfolio valuation';
  }

  if (!markdown) {
    return res.status(400).json({ ok: false, error: 'markdown or a known report is required' });
  }

  const delivery = await sendEmail({
    to: req.body?.to,
    subject: `SurfingAlien — ${subject || 'report'}`,
    markdown,
  });

  // A dry run is a successful call with an unsent message; the shape says which.
  return res.status(delivery.sent ? 200 : 202).json({
    ok: delivery.sent,
    configured: emailConfigured(),
    ...delivery,
  });
});
