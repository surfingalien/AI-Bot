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
