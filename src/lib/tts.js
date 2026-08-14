// Speech as audio, synthesised anywhere but here.
//
// Every other voice fix in this desk has been about *what* to say and *when*.
// This is about the last mile, which no amount of client-side care can rescue:
// a browser with no voices installed produces no sound, reports no error, and
// cannot be made to. Audio bytes have no such failure mode — the browser only
// has to play a sound, which it can always do.
//
// The service is anything that answers POST with audio; `services/omnivoice`
// in this repo is one. Nothing here is specific to that model beyond the
// request shape, so a different backend is a URL change.
//
// Never throws. A desk that cannot reach its synthesiser should read the brief
// in the browser's own voice, not go quiet — falling back is the whole reason
// this returns null rather than raising.

import { config, ttsConfigured } from '../config.js';
import { log } from './log.js';

/** Audio types a browser can play from a blob without help. */
const PLAYABLE = /^audio\/(wav|wave|x-wav|mpeg|mp3|ogg|webm|flac|aac|mp4)/i;

/**
 * The credential for the speech service.
 *
 * Groq serves the model and the voice from one host and one key, so a desk
 * using it for both would otherwise have to set the same secret twice. Reused
 * only when the two point at exactly the same base — a key is not something to
 * send somewhere it was not issued for.
 */
function ttsKey() {
  if (config.tts.key) return config.tts.key;
  if (config.tts.base && config.tts.base === config.brain.base) return config.brain.key;
  return '';
}

/** What to POST, and where, for each backend shape. */
function request(said, options) {
  if (config.tts.provider === 'omnivoice') {
    return {
      url: `${config.tts.base}/speak`,
      body: {
        text: said,
        // Hints. A backend that does neither voice design nor stored clones
        // ignores them rather than failing.
        instruct: options.instruct ?? config.tts.instruct,
        voice: options.voice ?? config.tts.voice,
      },
    };
  }

  // OpenAI's speech shape, which Groq implements as well.
  return {
    url: `${config.tts.base}/audio/speech`,
    body: {
      model: options.model || config.tts.model,
      input: said,
      voice: options.voice || config.tts.voice,
      response_format: config.tts.format,
    },
  };
}

// Why the last attempt produced no sound, in the provider's own words. Kept so
// the desk can say it rather than leaving an operator to guess — the same
// reason the browser path records its errors.
let lastFailure = null;

/** The provider's message, dug out of whatever shape it arrived in. */
function explain(status, detail) {
  try {
    const json = JSON.parse(detail);
    const message = json?.error?.message || json?.message || json?.detail;
    if (message) return `HTTP ${status}: ${String(message).slice(0, 300)}`;
  } catch {
    /* not JSON; the raw body is the best there is */
  }
  return `HTTP ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
}

/** The reason the last attempt failed, or null if the last one worked. */
export function lastTtsFailure() {
  return lastFailure;
}

/**
 * Synthesise one passage.
 *
 * @param {string} text
 * @param {{instruct?:string, voice?:string, model?:string, signal?:AbortSignal}} [options]
 * @returns {Promise<{audio:Buffer, type:string}|null>} null when unavailable
 */
export async function speak(text, options = {}) {
  const said = String(text || '').trim();
  if (!said || !ttsConfigured()) return null;

  const timeout = AbortSignal.timeout(config.tts.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const headers = { 'Content-Type': 'application/json', Accept: 'audio/*' };
  const key = ttsKey();
  if (key) headers.Authorization = `Bearer ${key}`;

  const { url, body } = request(said, options);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    // A caller who left mid-sentence is not a fault worth logging.
    if (options.signal?.aborted) return null;
    lastFailure = `unreachable: ${err?.message || err}`;
    log.warn(`tts unreachable, falling back to the browser: ${err?.message || err}`);
    return null;
  }

  if (!response.ok) {
    // The provider's own words, not a status code. The failure most likely to
    // happen here is a retired model — Groq has already decommissioned one —
    // and "model `x` has been decommissioned" is the difference between a
    // one-line config change and an afternoon.
    const detail = await response.text().catch(() => '');
    lastFailure = explain(response.status, detail);
    log.warn(`tts HTTP ${response.status}: ${lastFailure}`);
    return null;
  }

  const type = (response.headers.get('content-type') || 'audio/wav').split(';')[0].trim();
  if (!PLAYABLE.test(type)) {
    // Something answered, but not with a sound. Reading its body to the
    // operator as if it were audio would be worse than saying nothing.
    lastFailure = `answered with ${type}, which is not audio`;
    log.warn(`tts returned ${type}, which is not audio`);
    return null;
  }

  let audio;
  try {
    audio = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    lastFailure = `the audio could not be read: ${err?.message || err}`;
    log.warn(`tts body unreadable: ${err?.message || err}`);
    return null;
  }

  if (!audio.length) {
    lastFailure = 'the service answered with no audio at all';
    return null;
  }
  if (audio.length > config.tts.maxBytes) {
    lastFailure = `${audio.length} bytes of audio, over the ${config.tts.maxBytes} ceiling`;
    log.warn(`tts returned ${audio.length} bytes, over the ${config.tts.maxBytes} ceiling`);
    return null;
  }

  lastFailure = null;
  return { audio, type };
}

/**
 * Whether speech is set up, and what went wrong last time — for diagnostics,
 * not the hot path.
 *
 * Only OmniVoice has somewhere free to knock. A hosted provider charges for
 * every synthesis, so probing one on a timer would spend the budget answering a
 * question nobody asked; what is reported there is the configuration and the
 * last real attempt, which is the honest answer rather than an invented one.
 */
export async function probeTts() {
  if (!ttsConfigured()) return { ok: false, error: 'not configured' };

  const shape = { provider: config.tts.provider, model: config.tts.model, voice: config.tts.voice };

  if (config.tts.provider !== 'omnivoice') {
    return lastFailure
      ? { ok: false, error: lastFailure, ...shape }
      : { ok: true, note: 'configured; not probed, because synthesis is billed', ...shape };
  }

  try {
    const key = ttsKey();
    const res = await fetch(`${config.tts.base}/health`, {
      signal: AbortSignal.timeout(Math.min(config.tts.timeoutMs, 5000)),
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, ...shape };
    const body = await res.json().catch(() => ({}));
    return { ok: true, ...shape, ...body };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), ...shape };
  }
}
