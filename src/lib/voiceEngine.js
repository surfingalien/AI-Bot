// A second OpenAI-compatible upstream, dedicated to voice: real speech
// synthesis and transcription in place of the browser's own speechSynthesis
// and SpeechRecognition. Same shape as brain/client.js — a self-hosted
// engine (VoiceStudio and others) or a hosted provider, speaking the same
// /audio/speech and /audio/transcriptions dialect OpenAI's TTS/Whisper APIs
// use.

import { config, voiceTtsConfigured, voiceSttConfigured } from '../config.js';

export class VoiceEngineError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'VoiceEngineError';
    this.status = status;
  }
}

function authHeaders(key, extra = {}) {
  const headers = { ...extra };
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function abortSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signals = signal ? [signal, timeout] : [timeout];
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

/**
 * Text -> audio bytes, via an OpenAI-compatible `/audio/speech` endpoint.
 *
 * @param {string} text
 * @param {{voice?: string, signal?: AbortSignal}} [options]
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
export async function synthesizeSpeech(text, options = {}) {
  if (!voiceTtsConfigured()) throw new VoiceEngineError('VOICE_TTS_BASE is not configured', 503);
  const { base, key, model, format, timeoutMs } = config.voice.tts;

  let response;
  try {
    response = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: authHeaders(key, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model,
        input: text,
        voice: options.voice || config.voice.tts.voice,
        response_format: format,
      }),
      signal: abortSignal(timeoutMs, options.signal),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new VoiceEngineError('voice engine timeout', 504);
    throw new VoiceEngineError(`voice engine unreachable: ${err?.message || err}`, 502);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new VoiceEngineError(`voice engine HTTP ${response.status}: ${detail.slice(0, 200)}`, 502);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new VoiceEngineError('voice engine returned no audio', 502);
  const contentType = response.headers.get('content-type') || `audio/${format}`;
  return { buffer, contentType };
}

/**
 * Audio bytes -> transcript, via an OpenAI-compatible `/audio/transcriptions`
 * endpoint (multipart, the same shape Whisper takes).
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {{mimeType?: string, signal?: AbortSignal}} [options]
 * @returns {Promise<string>}
 */
export async function transcribeAudio(bytes, options = {}) {
  if (!voiceSttConfigured()) throw new VoiceEngineError('VOICE_STT_BASE is not configured', 503);
  const { base, key, model, timeoutMs } = config.voice.stt;

  const mimeType = (options.mimeType || 'audio/webm').split(';')[0].trim();
  const ext = mimeType.includes('wav') ? 'wav' : mimeType.includes('mp3') || mimeType.includes('mpeg') ? 'mp3' : 'webm';
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: mimeType }), `audio.${ext}`);
  form.set('model', model);

  let response;
  try {
    response = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(key),
      body: form,
      signal: abortSignal(timeoutMs, options.signal),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') throw new VoiceEngineError('voice engine timeout', 504);
    throw new VoiceEngineError(`voice engine unreachable: ${err?.message || err}`, 502);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new VoiceEngineError(`voice engine HTTP ${response.status}: ${detail.slice(0, 200)}`, 502);
  }

  const json = await response.json().catch(() => null);
  const text = json?.text;
  if (typeof text !== 'string') throw new VoiceEngineError('voice engine returned no text', 502);
  return text;
}
