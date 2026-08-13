// Voice endpoints: what the desk says out loud, and what it hears.
//
// Both answer 200 with a usable value even when the model is missing or
// failing — a caller mid-sentence, or mid-utterance, has nothing useful to do
// with an error.

import { Router } from 'express';
import { briefFor, briefStream } from '../lib/voiceBrief.js';
import { resolveIntent } from '../lib/intent.js';
import { speak } from '../lib/tts.js';
import { ttsConfigured } from '../config.js';
import { rateLimit } from '../lib/rateLimit.js';
import { log } from '../lib/log.js';

export const voiceRouter = Router();

// A sentence in, a sound out.
//
// This exists because the browser's own synthesiser cannot be relied on: with
// no voices installed it produces nothing, silently, and no client-side code
// can change that. Audio the browser merely has to play always works.
//
// 503 when there is no service, which is the signal to use the browser instead
// — an unconfigured desk is not a broken one.
voiceRouter.post('/voice/speak', rateLimit({ name: 'speak', max: 60 }), async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });
  if (!ttsConfigured()) {
    return res.status(503).json({ ok: false, error: 'no speech service configured (set TTS_BASE)' });
  }

  // The listener closing the tab or talking over the desk should stop the
  // generation, not just discard it.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const spoken = await speak(text, {
    instruct: req.body?.instruct,
    voice: req.body?.voice,
    signal: controller.signal,
  });

  if (res.writableEnded) return undefined;
  if (!spoken) {
    // Deliberately not an error: the caller's next move is the same either way,
    // which is to read it in the browser's voice.
    return res.status(503).json({ ok: false, error: 'speech service did not answer with audio' });
  }

  res.set('Content-Type', spoken.type);
  res.set('Cache-Control', 'no-store');
  return res.send(spoken.audio);
});

voiceRouter.post('/voice/brief', rateLimit({ name: 'voice', max: 60 }), async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });

  const options = {
    title: String(req.body?.title || '').slice(0, 120),
    style: req.body?.style === 'alert' ? 'alert' : 'brief',
    // A sentence the caller has already spoken, so the brief does not say it
    // again. Only meaningful while streaming — a caller taking the whole script
    // in one answer has not started speaking yet.
    spokenLead: String(req.body?.spokenLead || '').slice(0, 400),
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
