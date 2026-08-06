// Spoken briefs, shared by everything that has to say something out loud:
// the desk's speech synthesis, and the alerts the autonomy loop pushes to a
// webhook while nobody is watching.
//
// A fired goal at 3am should read "NVDA broke 140, up 4 percent since the
// open", not a metric dump. Same problem as reading a dossier aloud, same
// answer — so it is one implementation, not two.

import crypto from 'node:crypto';
import { brainConfigured } from '../config.js';
import { complete } from '../brain/client.js';
import { needsRewrite, toSpeech } from './speech.js';
import { log } from './log.js';

// Every line here is a constraint the caller cannot recover from on its own:
// a synthesiser cannot skip a table, and a webhook cannot round a figure.
export const VOICE_PROMPT = [
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

// An alert is heard on a phone, out of context, with no screen to check.
const ALERT_PROMPT = [
  'You write one-line alerts that a person reads on a phone, away from their desk.',
  '',
  'Rules:',
  '- One sentence, under 25 words. No preamble, no markdown, no symbols beyond a percent sign.',
  '- Say what happened and the one number that matters, rounded the way people speak.',
  '- Name the symbol plainly. Never read a table or a list of metrics.',
  '- State only what the input supports. Never invent a cause or a recommendation.',
].join('\n');

const cache = new Map(); // hash -> { script, source, ts }
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

function cacheKey(text, kind) {
  return crypto.createHash('sha1').update(`${kind || ''}::${text}`).digest('hex');
}

export function clearVoiceCache() {
  cache.clear();
}

/**
 * Rewrite written analysis into a spoken script.
 *
 * Never throws and never returns empty: a caller mid-sentence has nothing
 * useful to do with an error, so a model failure degrades to the rules shaper.
 *
 * @param {string} text
 * @param {{title?:string, style?:'brief'|'alert', skipPassthrough?:boolean}} [options]
 * @returns {Promise<{script:string, source:'model'|'rules'|'passthrough', cached?:boolean}>}
 */
export async function briefFor(text, options = {}) {
  const input = String(text || '').trim();
  if (!input) return { script: '', source: 'passthrough' };

  const style = options.style === 'alert' ? 'alert' : 'brief';
  const title = options.title || '';

  // Already speech — a reminder or a one-liner. Paying model latency to
  // confirm that would just make the desk feel slow.
  if (!options.skipPassthrough && !needsRewrite(input)) {
    return { script: input, source: 'passthrough' };
  }

  const key = cacheKey(input, style);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts <= CACHE_TTL_MS) {
    return { script: hit.script, source: hit.source, cached: true };
  }
  if (hit) cache.delete(key);

  const fallback = toSpeech(input, { title });

  const remember = (value) => {
    cache.set(key, { ...value, ts: Date.now() });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  };

  if (!brainConfigured()) return remember({ script: fallback, source: 'rules' });

  try {
    const raw = await complete(
      [
        { role: 'system', content: style === 'alert' ? ALERT_PROMPT : VOICE_PROMPT },
        {
          role: 'user',
          content: `${title ? `Subject: ${title}\n\n` : ''}Written analysis:\n${input.slice(0, 6000)}`,
        },
      ],
      { temperature: 0.4, maxTokens: style === 'alert' ? 80 : 160 },
    );

    // A model that ignores the brief and answers in markdown would defeat it.
    const cleaned = toSpeech(raw);
    return remember({ script: cleaned || fallback, source: 'model' });
  } catch (err) {
    log.warn(`voice brief fell back to rules: ${err?.message || err}`);
    return remember({ script: fallback, source: 'rules' });
  }
}
