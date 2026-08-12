// Voice endpoints: what the desk says out loud, and what it hears.
//
// Both answer 200 with a usable value even when the model is missing or
// failing — a caller mid-sentence, or mid-utterance, has nothing useful to do
// with an error.

import { Router } from 'express';
import { briefFor, briefStream } from '../lib/voiceBrief.js';
import { resolveIntent } from '../lib/intent.js';
import { rateLimit } from '../lib/rateLimit.js';
import { log } from '../lib/log.js';

export const voiceRouter = Router();

voiceRouter.post('/voice/brief', rateLimit({ name: 'voice', max: 60 }), async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });

  const options = {
    title: String(req.body?.title || '').slice(0, 120),
    style: req.body?.style === 'alert' ? 'alert' : 'brief',
  };

  // The whole script in one answer, for callers that have nowhere to put a
  // half-finished one: the autonomy webhook, and any client older than this.
  if (!req.body?.stream) {
    const result = await briefFor(text, options);
    return res.json({ ok: true, ...result });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // A proxy that buffers this delivers the whole brief at once, which is
    // precisely the behaviour being removed.
    'X-Accel-Buffering': 'no',
  });

  // A listener who has stopped listening — closed the tab, or started talking
  // over the desk — should not keep a model generating on their behalf.
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  try {
    for await (const event of briefStream(text, { ...options, signal: controller.signal })) {
      if (res.writableEnded) break;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'done', source: 'error' })}\n\n`);
    }
    log.warn(`voice brief stream failed: ${err?.message || err}`);
  }
  if (!res.writableEnded) res.end();
  return undefined;
});

// Spoken request -> a command the desk already understands. Unmapped speech
// comes back unchanged rather than guessed at.
voiceRouter.post('/intent', rateLimit({ name: 'intent', max: 60 }), async (req, res) => {
  const transcript = String(req.body?.transcript || '').trim();
  if (!transcript) return res.status(400).json({ ok: false, error: 'transcript required' });

  const result = await resolveIntent(transcript);
  return res.json({ ok: true, transcript, ...result });
});
