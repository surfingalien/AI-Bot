// POST /api/v1/chat/completions — OpenAI-compatible pass-through to the
// configured upstream, streaming included.
//
// The point is credential containment: the browser engine can point its BASE
// URL at this server and never hold an API key, while tool-calling and SSE
// streaming keep working exactly as they do against the provider directly.

import { Router } from 'express';
import { config, brainConfigured } from '../config.js';
import { brainHeaders, brainUrl, probe } from '../brain/client.js';
import { rateLimit } from '../lib/rateLimit.js';
import { log } from '../lib/log.js';

export const brainRouter = Router();

brainRouter.post(
  '/v1/chat/completions',
  rateLimit({ name: 'brain', max: 60 }),
  async (req, res) => {
    if (!brainConfigured()) {
      return res.status(503).json({
        error: { message: 'model brain not configured on this server (set BRAIN_BASE)' },
      });
    }

    const body = { ...(req.body || {}) };
    if (!body.model) body.model = config.brain.model;
    const wantsStream = Boolean(body.stream);

    // Abort the upstream call if the client goes away mid-stream — but not
    // when the response simply finished normally.
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    let upstream;
    try {
      upstream = await fetch(brainUrl(), {
        method: 'POST',
        headers: brainHeaders(wantsStream ? { Accept: 'text/event-stream' } : {}),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return res.end();
      log.warn(`brain proxy failed: ${err?.message || err}`);
      return res.status(502).json({ error: { message: `upstream unreachable: ${err?.message || err}` } });
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res
        .status(upstream.status)
        .type(upstream.headers.get('content-type') || 'application/json')
        .send(text);
    }

    if (!wantsStream) {
      const text = await upstream.text();
      return res.type(upstream.headers.get('content-type') || 'application/json').send(text);
    }

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // keep nginx from buffering the token stream
    });
    res.flushHeaders?.();

    try {
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) log.warn(`brain stream interrupted: ${err?.message || err}`);
    } finally {
      res.end();
    }
    return undefined;
  },
);

// Liveness check for operators: does the configured upstream actually answer?
brainRouter.get('/brain/probe', rateLimit({ name: 'probe', max: 10 }), async (_req, res) => {
  const result = await probe();
  return res.status(result.ok ? 200 : 503).json({ ...result, model: config.brain.model });
});

// Some clients probe /models before sending a first request.
brainRouter.get('/v1/models', async (_req, res) => {
  if (!brainConfigured()) {
    return res.status(503).json({ error: { message: 'model brain not configured' } });
  }
  try {
    const upstream = await fetch(brainUrl('/models'), {
      headers: brainHeaders(),
      signal: AbortSignal.timeout(config.brain.timeoutMs),
    });
    const text = await upstream.text();
    return res.status(upstream.status).type('application/json').send(text);
  } catch (err) {
    return res.status(502).json({ error: { message: err?.message || String(err) } });
  }
});
