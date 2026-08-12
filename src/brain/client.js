// Server-side access to the OpenAI-compatible "model brain". Used both by the
// /api/v1 proxy route and by autonomy activities that need synthesis while no
// browser tab is open.

import { config, brainConfigured } from '../config.js';

export class BrainError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'BrainError';
    this.status = status;
  }
}

export function brainHeaders(extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (config.brain.key) headers.Authorization = `Bearer ${config.brain.key}`;
  if (/openrouter/i.test(config.brain.base)) {
    headers['HTTP-Referer'] = config.brain.referer;
    headers['X-Title'] = config.brain.title;
  }
  return headers;
}

export function brainUrl(path = '/chat/completions') {
  if (!brainConfigured()) throw new BrainError('BRAIN_BASE is not configured', 503);
  return `${config.brain.base}${path}`;
}

/**
 * Raw pass-through call. Returns the undecoded Response so streaming callers
 * can pipe it straight to the client.
 */
export async function brainRequest(body, { headers = {}, signal } = {}) {
  const response = await fetch(brainUrl(), {
    method: 'POST',
    headers: brainHeaders(headers),
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(config.brain.timeoutMs),
  });
  return response;
}

/**
 * Non-streaming completion. Returns the assistant message text.
 */
export async function complete(messages, options = {}) {
  const body = {
    model: options.model || config.brain.model,
    messages,
    ...(options.temperature != null ? { temperature: options.temperature } : {}),
    ...(options.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
  };

  let response;
  try {
    response = await brainRequest(body);
  } catch (err) {
    if (err instanceof BrainError) throw err;
    if (err?.name === 'TimeoutError') throw new BrainError('model brain timeout', 504);
    throw new BrainError(`model brain unreachable: ${err?.message || err}`, 502);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new BrainError(`model brain HTTP ${response.status}: ${text.slice(0, 200)}`, 502);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BrainError('model brain returned non-JSON', 502);
  }
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new BrainError('model brain returned no content', 502);
  return content;
}

/**
 * Streaming completion. Yields assistant text as it arrives, rather than the
 * whole message once it is finished.
 *
 * This exists for speech. A spoken brief read out of `complete()` cannot begin
 * until the last token lands, so the operator hears nothing for as long as the
 * model takes to write four sentences — where what they actually need is the
 * first one. Everything that reads on a screen should keep using `complete()`;
 * a reader can wait, a listener cannot.
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {{model?:string, temperature?:number, maxTokens?:number, signal?:AbortSignal}} [options]
 * @yields {string} content deltas, in order
 */
export async function* completeStream(messages, options = {}) {
  const body = {
    model: options.model || config.brain.model,
    messages,
    stream: true,
    ...(options.temperature != null ? { temperature: options.temperature } : {}),
    ...(options.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
  };

  let response;
  try {
    response = await brainRequest(body, {
      headers: { Accept: 'text/event-stream' },
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof BrainError) throw err;
    if (err?.name === 'TimeoutError') throw new BrainError('model brain timeout', 504);
    throw new BrainError(`model brain unreachable: ${err?.message || err}`, 502);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new BrainError(`model brain HTTP ${response.status}: ${text.slice(0, 200)}`, 502);
  }
  if (!response.body) throw new BrainError('model brain returned no stream', 502);

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    // A network chunk lands wherever it lands, which is routinely mid-frame.
    // Only whole lines are consumed; the remainder waits for the next chunk.
    let cut;
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line.startsWith('data:')) continue; // comments, keep-alives, event: lines

      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // not every provider's frames are ours to understand
      }
      // An error delivered inside the stream is still an error.
      if (json?.error) {
        throw new BrainError(`model brain stream error: ${json.error.message || 'unknown'}`, 502);
      }
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) yield delta;
    }
  }
}

/** Cheap liveness probe used by /api/config consumers and tests. */
export async function probe() {
  if (!brainConfigured()) return { ok: false, error: 'not configured' };
  try {
    const text = await complete([{ role: 'user', content: 'Reply with the single word OK.' }], {
      maxTokens: 8,
    });
    return { ok: Boolean(text), model: config.brain.model, sample: text.trim().slice(0, 40) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
