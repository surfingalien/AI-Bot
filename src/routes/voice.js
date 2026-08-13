// Voice endpoints: what the desk says out loud, and what it hears.
//
// Both answer 200 with a usable value even when the model is missing or
// failing — a caller mid-sentence, or mid-utterance, has nothing useful to do
// with an error.

import { Router, raw } from 'express';
import { briefFor, briefStream } from '../lib/voiceBrief.js';
import { resolveIntent } from '../lib/intent.js';
import { synthesizeSpeech, transcribeAudio, VoiceEngineError } from '../lib/voiceEngine.js';
import { voiceTtsConfigured, voiceSttConfigured } from '../config.js';
import { rateLimit } from '../lib/rateLimit.js';
import { log } from '../lib/log.js';

export const voiceRouter = Router();

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

// Text -> real synthesized speech, when a voice engine is configured. Absent
// one, the browser's own speechSynthesis is what speaks — this endpoint
// simply does not exist for it to call.
voiceRouter.post('/voice/speak', rateLimit({ name: 'voice-speak', max: 60 }), async (req, res) => {
  if (!voiceTtsConfigured()) {
    return res
      .status(503)
      .json({ ok: false, error: 'voice synthesis not configured on this server (set VOICE_TTS_BASE)' });
  }
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });

  try {
    const { buffer, contentType } = await synthesizeSpeech(text.slice(0, 2000), {
      voice: req.body?.voice ? String(req.body.voice).slice(0, 60) : undefined,
    });
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-store');
    return res.send(buffer);
  } catch (err) {
    const status = err instanceof VoiceEngineError ? err.status : 502;
    log.warn(`voice speak failed: ${err?.message || err}`);
    return res.status(status).json({ ok: false, error: err?.message || 'synthesis failed' });
  }
});

// Recorded audio -> transcript, when a voice engine is configured. This is
// the fallback path for browsers with no SpeechRecognition of their own
// (Firefox, Safari) — the desk records instead of streaming to the browser's
// built-in recognizer, then sends the clip here once the operator stops
// talking.
voiceRouter.post(
  '/voice/transcribe',
  rateLimit({ name: 'voice-transcribe', max: 30 }),
  raw({ type: () => true, limit: '15mb' }),
  async (req, res) => {
    if (!voiceSttConfigured()) {
      return res
        .status(503)
        .json({ ok: false, error: 'transcription not configured on this server (set VOICE_STT_BASE)' });
    }
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || !bytes.length) {
      return res.status(400).json({ ok: false, error: 'audio body required' });
    }

    try {
      const text = await transcribeAudio(bytes, { mimeType: req.headers['content-type'] });
      return res.json({ ok: true, text: text.trim() });
    } catch (err) {
      const status = err instanceof VoiceEngineError ? err.status : 502;
      log.warn(`voice transcribe failed: ${err?.message || err}`);
      return res.status(status).json({ ok: false, error: err?.message || 'transcription failed' });
    }
  },
);
