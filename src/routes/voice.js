// Voice endpoints: what the desk says out loud, and what it hears.
//
// Both answer 200 with a usable value even when the model is missing or
// failing — a caller mid-sentence, or mid-utterance, has nothing useful to do
// with an error.

import { Router } from 'express';
import { briefFor } from '../lib/voiceBrief.js';
import { resolveIntent } from '../lib/intent.js';
import { rateLimit } from '../lib/rateLimit.js';

export const voiceRouter = Router();

voiceRouter.post('/voice/brief', rateLimit({ name: 'voice', max: 60 }), async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });

  const result = await briefFor(text, {
    title: String(req.body?.title || '').slice(0, 120),
    style: req.body?.style === 'alert' ? 'alert' : 'brief',
  });
  return res.json({ ok: true, ...result });
});

// Spoken request -> a command the desk already understands. Unmapped speech
// comes back unchanged rather than guessed at.
voiceRouter.post('/intent', rateLimit({ name: 'intent', max: 60 }), async (req, res) => {
  const transcript = String(req.body?.transcript || '').trim();
  if (!transcript) return res.status(400).json({ ok: false, error: 'transcript required' });

  const result = await resolveIntent(transcript);
  return res.json({ ok: true, transcript, ...result });
});
