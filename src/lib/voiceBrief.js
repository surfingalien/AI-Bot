// Spoken briefs, shared by everything that has to say something out loud:
// the desk's speech synthesis, and the alerts the autonomy loop pushes to a
// webhook while nobody is watching.
//
// A fired goal at 3am should read "NVDA broke 140, up 4 percent since the
// open", not a metric dump. Same problem as reading a dossier aloud, same
// answer — so it is one implementation, not two.

import crypto from 'node:crypto';
import { config, brainConfigured } from '../config.js';
import { complete, completeStream } from '../brain/client.js';
import {
  MAX_SENTENCES,
  extractVerdict,
  humanizeNumbers,
  needsRewrite,
  splitSentences,
  stripMarkup,
  toSpeech,
} from './speech.js';
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

/** Keep a finished script, evicting the oldest once the map is full. */
function remember(key, value) {
  cache.set(key, { ...value, ts: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
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

  if (!brainConfigured()) return remember(key, { script: fallback, source: 'rules' });

  try {
    // Waiting on the model is the whole latency budget for speech. Past the
    // deadline, say the rules version rather than leaving a silence — the
    // model's answer still lands in the cache and wins next time.
    const raced = await Promise.race([
      modelBrief(input, title, style),
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), config.voice.deadlineMs);
        if (t.unref) t.unref();
      }),
    ]);
    if (raced === null) {
      log.debug('voice brief exceeded its deadline, speaking the rules script');
      return { script: fallback, source: 'rules-timeout' };
    }
    return remember(key, { script: raced || fallback, source: 'model' });
  } catch (err) {
    log.warn(`voice brief fell back to rules: ${err?.message || err}`);
    return remember(key, { script: fallback, source: 'rules' });
  }
}

/** The two messages both the whole-script and the streaming path send up. */
function briefMessages(input, title, style) {
  return [
    { role: 'system', content: style === 'alert' ? ALERT_PROMPT : VOICE_PROMPT },
    {
      role: 'user',
      content: `${title ? `Subject: ${title}\n\n` : ''}Written analysis:\n${input.slice(0, 6000)}`,
    },
  ];
}

// The leading complete sentence of a partial buffer, with the whitespace that
// proves it ended. Deliberately the same boundary `splitSentences` uses, so a
// streamed brief breaks where a whole one would.
const SENTENCE_END = /^([\s\S]*?[.!?])(\s+)/;

/** One sentence of model output, shaped the way the whole script would be. */
function shapeSentence(text) {
  return humanizeNumbers(stripMarkup(text)).trim();
}

/** What is left of a script once its opening sentence has already been said. */
function afterLead(script) {
  const parts = splitSentences(script);
  return parts.length > 1 ? parts.slice(1).join(' ') : '';
}

/**
 * The same brief, sentence by sentence, for callers that can start speaking
 * before the model has finished writing.
 *
 * Emits, in order:
 *   { type:'lead',     script }  — say this now; derived, not generated
 *   { type:'sentence', script }  — the model's, as each one completes
 *   { type:'fallback', script }  — say this instead; never follows a sentence
 *   { type:'done',     source }  — nothing further is coming
 *
 * The ordering guarantee is what keeps the consumer trivial: a `fallback` only
 * ever arrives when no `sentence` has, so nothing can be said twice.
 *
 * @param {string} text
 * @param {{title?:string, style?:'brief'|'alert', skipPassthrough?:boolean, signal?:AbortSignal}} [options]
 */
export async function* briefStream(text, options = {}) {
  const input = String(text || '').trim();
  if (!input) return;

  const style = options.style === 'alert' ? 'alert' : 'brief';
  const title = options.title || '';

  // Already speech: a reminder, or the desk's own one-liner. There is nothing
  // to stream and nothing to wait for.
  if (!options.skipPassthrough && !needsRewrite(input)) {
    yield { type: 'fallback', script: input, source: 'passthrough' };
    yield { type: 'done', source: 'passthrough' };
    return;
  }

  const key = cacheKey(input, style);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts <= CACHE_TTL_MS) {
    yield { type: 'fallback', script: hit.script, source: hit.source, cached: true };
    yield { type: 'done', source: hit.source, cached: true };
    return;
  }
  if (hit) cache.delete(key);

  const fallback = toSpeech(input, { title });

  if (!brainConfigured()) {
    remember(key, { script: fallback, source: 'rules' });
    yield { type: 'fallback', script: fallback, source: 'rules' };
    yield { type: 'done', source: 'rules' };
    return;
  }

  // A verdict line is the one opener that costs nothing and is still true: it
  // is read off the source rather than written about it, so it is available at
  // the instant the request arrives. Saying it immediately is what removes the
  // dead air; the model's own lead is then dropped, because the prompt fixes
  // the shape — lead, then reasons — and the reasons still read as one brief.
  //
  // With no verdict there is no trustworthy instant opener, and inventing one
  // out of the first line of the source would be worse than a short wait.
  const verdict = style === 'brief' ? extractVerdict(input) : null;
  const lead = verdict ? verdict.sentence : null;
  if (lead) yield { type: 'lead', script: lead };

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  const spoken = [];
  let said = lead ? 1 : 0;
  let dropLead = Boolean(lead); // the model's opener duplicates one we just gave
  let buffer = '';
  let timedOut = false;

  // Nothing is being said yet unless a lead went out, so the tolerable wait is
  // the short one. Where there is already audio, the old deadline still holds.
  const budget = lead ? config.voice.deadlineMs : config.voice.firstSentenceMs;
  const timer = setTimeout(() => {
    if (spoken.length === 0) {
      timedOut = true;
      controller.abort();
    }
  }, budget);
  if (timer.unref) timer.unref();

  const emit = (sentence) => {
    const shaped = shapeSentence(sentence);
    if (!shaped) return null;
    if (dropLead) {
      dropLead = false;
      return null;
    }
    if (said >= MAX_SENTENCES) return null;
    said += 1;
    spoken.push(shaped);
    return { type: 'sentence', script: shaped };
  };

  try {
    for await (const delta of completeStream(briefMessages(input, title, style), {
      temperature: 0.4,
      maxTokens: style === 'alert' ? 80 : 160,
      signal: controller.signal,
      timeoutMs: config.voice.brainTimeoutMs,
    })) {
      buffer += delta;

      // A sentence is only known to be finished once whitespace follows it, so
      // whatever trails the last boundary is held back as possibly-incomplete.
      // The buffer is sliced rather than rebuilt from the pieces: the
      // whitespace between sentences is the only evidence a boundary exists,
      // and reassembling the remainder would throw it away.
      let boundary;
      while ((boundary = SENTENCE_END.exec(buffer)) !== null) {
        const whole = boundary[1];
        buffer = buffer.slice(boundary[0].length);
        const event = emit(whole);
        if (event) yield event;
      }
      if (said >= MAX_SENTENCES) break;
    }

    // Whatever is left has no trailing whitespace to mark its end — it is the
    // last sentence, and dropping it would truncate the brief.
    const tail = emit(buffer);
    if (tail) yield tail;

    const script = [lead, ...spoken].filter(Boolean).join(' ').trim();
    if (script) remember(key, { script, source: 'model' });
    yield { type: 'done', source: spoken.length ? 'model' : 'lead-only' };
  } catch (err) {
    if (options.signal?.aborted) return; // the listener left; say nothing

    const source = timedOut ? 'rules-timeout' : 'rules';
    if (spoken.length === 0) {
      // Nothing of the model's has been said, so the rules script can still
      // stand in whole — minus the lead, if that already went out.
      log.debug(`voice brief stream fell back to rules: ${timedOut ? 'deadline' : err?.message || err}`);
      const rest = lead ? afterLead(fallback) : fallback;
      if (rest) yield { type: 'fallback', script: rest, source };
      yield { type: 'done', source };
      return;
    }
    // Some of the model's brief is already spoken. Appending the rules script
    // now would say the same thing twice, so this stops where it is.
    log.warn(`voice brief stream ended early: ${err?.message || err}`);
    yield { type: 'done', source: 'model-partial' };
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onAbort);
  }
}

async function modelBrief(input, title, style) {
  const raw = await complete(briefMessages(input, title, style), {
    temperature: 0.4,
    maxTokens: style === 'alert' ? 80 : 160,
    // `briefFor` stops waiting at its own deadline but lets the call finish so
    // the answer lands in the cache. Without a bound of its own that orphaned
    // call could outlive every reason anyone had for making it.
    timeoutMs: config.voice.brainTimeoutMs,
  });

  // A model that ignores the brief and answers in markdown would defeat it.
  return toSpeech(raw);
}
