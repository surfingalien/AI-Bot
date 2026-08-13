// Speech as audio, synthesised somewhere with a GPU.
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

export class TtsUnavailable extends Error {}

/** Audio types a browser can play from a blob without help. */
const PLAYABLE = /^audio\/(wav|wave|x-wav|mpeg|mp3|ogg|webm|flac|aac|mp4)/i;

/**
 * Synthesise one passage.
 *
 * @param {string} text
 * @param {{instruct?:string, voice?:string, signal?:AbortSignal}} [options]
 * @returns {Promise<{audio:Buffer, type:string}|null>} null when unavailable
 */
export async function speak(text, options = {}) {
  const said = String(text || '').trim();
  if (!said || !ttsConfigured()) return null;

  const timeout = AbortSignal.timeout(config.tts.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const headers = { 'Content-Type': 'application/json', Accept: 'audio/wav' };
  if (config.tts.key) headers.Authorization = `Bearer ${config.tts.key}`;

  let response;
  try {
    response = await fetch(`${config.tts.base}/speak`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text: said,
        // Both are hints. A backend that does not do voice design or stored
        // clones ignores them rather than failing.
        instruct: options.instruct ?? config.tts.instruct,
        voice: options.voice ?? config.tts.voice,
      }),
      signal,
    });
  } catch (err) {
    // A caller who left mid-sentence is not a fault worth logging.
    if (options.signal?.aborted) return null;
    log.warn(`tts unreachable, falling back to the browser: ${err?.message || err}`);
    return null;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    log.warn(`tts HTTP ${response.status}: ${detail.slice(0, 200)}`);
    return null;
  }

  const type = (response.headers.get('content-type') || 'audio/wav').split(';')[0].trim();
  if (!PLAYABLE.test(type)) {
    // Something answered, but not with a sound. Reading its body to the
    // operator as if it were audio would be worse than saying nothing.
    log.warn(`tts returned ${type}, which is not audio`);
    return null;
  }

  let audio;
  try {
    audio = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    log.warn(`tts body unreadable: ${err?.message || err}`);
    return null;
  }

  if (!audio.length) return null;
  if (audio.length > config.tts.maxBytes) {
    log.warn(`tts returned ${audio.length} bytes, over the ${config.tts.maxBytes} ceiling`);
    return null;
  }

  return { audio, type };
}

/** Whether the service is reachable at all — for diagnostics, not the hot path. */
export async function probeTts() {
  if (!ttsConfigured()) return { ok: false, error: 'not configured' };
  try {
    const res = await fetch(`${config.tts.base}/health`, {
      signal: AbortSignal.timeout(Math.min(config.tts.timeoutMs, 5000)),
      headers: config.tts.key ? { Authorization: `Bearer ${config.tts.key}` } : {},
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    return { ok: true, ...body };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
