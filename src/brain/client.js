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
 *
 * `timeoutMs` overrides the configured ceiling; a caller on the voice path
 * wants a far shorter one than a dossier being written to a screen. Pass 0 to
 * time the request out yourself, which is what the streaming path does.
 */
export async function brainRequest(body, { headers = {}, signal, timeoutMs } = {}) {
  const budget = timeoutMs == null ? config.brain.timeoutMs : timeoutMs;
  // Composed rather than chosen between: a caller-supplied signal used to
  // replace the timeout outright, so any request made with one — every
  // streamed brief — had no upstream timeout at all.
  const timeout = budget > 0 ? AbortSignal.timeout(budget) : null;
  const signals = [signal, timeout].filter(Boolean);

  const response = await fetch(brainUrl(), {
    method: 'POST',
    headers: brainHeaders(headers),
    body: JSON.stringify(body),
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
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
    response = await brainRequest(body, { timeoutMs: options.timeoutMs });
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
 * `timeoutMs` bounds silence rather than the call. It is armed before the
 * request and re-armed on every chunk, so it catches an upstream that never
 * answers or stops mid-brief, while a model that is steadily writing is left
 * alone however long it takes. Timing the whole call instead would cut off the
 * end of a long brief for no reason: once audio is playing, nobody is waiting.
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {{model?:string, temperature?:number, maxTokens?:number, signal?:AbortSignal, timeoutMs?:number}} [options]
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

  const budget = options.timeoutMs == null ? config.brain.timeoutMs : options.timeoutMs;
  const stall = new AbortController();
  const signals = options.signal ? [options.signal, stall.signal] : [stall.signal];
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  let silent = false;
  let timer = null;
  const waitForMore = () => {
    if (!(budget > 0)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      silent = true;
      stall.abort();
    }, budget);
    if (timer.unref) timer.unref();
  };

  // Anything thrown from here on could be this timer firing, and an abort
  // carries no explanation of its own.
  const explain = (err) => {
    if (silent) return new BrainError('model brain timeout', 504);
    if (err instanceof BrainError) return err;
    if (err?.name === 'TimeoutError') return new BrainError('model brain timeout', 504);
    return err;
  };

  try {
    waitForMore();

    let response;
    try {
      // The timeout is this generator's own; brainRequest must not add a
      // second one that would cut a healthy stream off at the same budget.
      response = await brainRequest(body, {
        headers: { Accept: 'text/event-stream' },
        signal,
        timeoutMs: 0,
      });
    } catch (err) {
      const known = explain(err);
      if (known instanceof BrainError) throw known;
      throw new BrainError(`model brain unreachable: ${err?.message || err}`, 502);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new BrainError(`model brain HTTP ${response.status}: ${text.slice(0, 200)}`, 502);
    }
    if (!response.body) throw new BrainError('model brain returned no stream', 502);

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for await (const chunk of response.body) {
        waitForMore();
        buffer += decoder.decode(chunk, { stream: true });

        // A network chunk lands wherever it lands, which is routinely
        // mid-frame. Only whole lines are consumed; the remainder waits for the
        // next chunk.
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
            throw new BrainError(
              `model brain stream error: ${json.error.message || 'unknown'}`,
              502,
            );
          }
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) yield delta;
        }
      }
    } catch (err) {
      throw explain(err);
    }
  } finally {
    clearTimeout(timer);
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
