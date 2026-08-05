// POST /api/voice/brief — rewrite a written turn into something a person would
// actually say out loud.
//
// The desk speaks whatever text it has. For a dossier that means tables and
// four-decimal figures, which is unlistenable. This endpoint answers with a
// short spoken script instead: the model writes it when a brain is configured,
// and the deterministic shaper covers every other case, so the caller always
// gets something speakable and never an error it has to handle mid-sentence.

import { Router } from 'express';
import crypto from 'node:crypto';
import { brainConfigured } from '../config.js';
import { complete } from '../brain/client.js';
import { needsRewrite, toSpeech } from '../lib/speech.js';
import { rateLimit } from '../lib/rateLimit.js';
import { log } from '../lib/log.js';

export const voiceRouter = Router();

// Everything here is a constraint the synthesiser cannot recover from on its
// own: it cannot skip a table, round a figure, or decide what mattered.
const VOICE_PROMPT = [
  'You turn written analysis into a short spoken briefing, as if telling a colleague',
  'what they need to know while walking to a meeting.',
  '',
  'Rules:',
  '- 2 to 4 sentences. Under 65 words. No preamble, no sign-off, no "here is a summary".',
  '- Lead with the answer or the decision. Then at most two reasons.',
  '- Plain spoken English. No markdown, no bullet points, no symbols, no citation markers.',
  '- At most three numbers, and round them the way people speak: "just under 140 dollars",',
  '  "up about 3 percent", "roughly 2 trillion". Never read a figure to more than one decimal.',
  '- Never read a table. Say what the table shows.',
  '- Name the risk or the caveat if there is one, in the same breath.',
  '- If the source says something is unverified, say so plainly rather than stating it as fact.',
  '- State only what the source supports. Do not add analysis of your own.',
].join('\n');

const cache = new Map(); // hash -> { script, source, ts }
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

function cacheKey(text, kind) {
  return crypto.createHash('sha1').update(`${kind || ''}::${text}`).digest('hex');
}

function readCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function writeCache(key, value) {
  cache.set(key, { ...value, ts: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

export function clearVoiceCache() {
  cache.clear();
}

voiceRouter.post('/voice/brief', rateLimit({ name: 'voice', max: 60 }), async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'text required' });

  const kind = String(req.body?.kind || '').slice(0, 40);
  const title = String(req.body?.title || '').slice(0, 120);

  // Already speech: a reminder or a one-liner needs no rewriting, and paying
  // model latency to confirm that would make the desk feel slow.
  if (!needsRewrite(text)) {
    return res.json({ ok: true, script: text, source: 'passthrough' });
  }

  const key = cacheKey(text, kind);
  const hit = readCache(key);
  if (hit) return res.json({ ok: true, script: hit.script, source: hit.source, cached: true });

  const fallback = toSpeech(text, { title });

  if (!brainConfigured()) {
    writeCache(key, { script: fallback, source: 'rules' });
    return res.json({ ok: true, script: fallback, source: 'rules' });
  }

  try {
    const script = await complete(
      [
        { role: 'system', content: VOICE_PROMPT },
        {
          role: 'user',
          content: `${title ? `Subject: ${title}\n\n` : ''}Written analysis:\n${text.slice(0, 6000)}`,
        },
      ],
      { temperature: 0.4, maxTokens: 160 },
    );

    // A model that ignores the brief and returns markup would defeat the point.
    const cleaned = toSpeech(script);
    const final = cleaned || fallback;
    writeCache(key, { script: final, source: 'model' });
    return res.json({ ok: true, script: final, source: 'model' });
  } catch (err) {
    log.warn(`voice brief fell back to rules: ${err?.message || err}`);
    writeCache(key, { script: fallback, source: 'rules' });
    return res.json({ ok: true, script: fallback, source: 'rules', error: err?.message });
  }
});
