// POST /api/notify — forward an alert to the configured webhook
// (Slack/Discord/anything that accepts a JSON body).

import { Router } from 'express';
import { sendNotification } from '../lib/notify.js';
import { rateLimit } from '../lib/rateLimit.js';

export const notifyRouter = Router();

notifyRouter.post('/notify', rateLimit({ name: 'notify', max: 60 }), async (req, res) => {
  const text = String(req.body?.text || '');
  const requestWebhook = String(req.body?.webhook || '');

  const result = await sendNotification(text, requestWebhook);
  if (!result.delivered) {
    return res.status(result.reason === 'empty message' ? 400 : 502).json({
      ok: false,
      error: result.reason,
    });
  }
  return res.json({ ok: true });
});
