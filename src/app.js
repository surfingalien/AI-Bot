import express from 'express';
import path from 'node:path';
import { config, brainConfigured, authRequired } from './config.js';
import { authMiddleware } from './lib/auth.js';
import { renderIndex } from './ui.js';
import { fetchRouter } from './routes/fetch.js';
import { notifyRouter } from './routes/notify.js';
import { yahooRouter } from './routes/yahoo.js';
import { brainRouter } from './routes/brain.js';
import { autonomyRouter } from './routes/autonomy.js';
import { genomeRouter } from './routes/genome.js';
import { voiceRouter } from './routes/voice.js';
import { portfolioRouter } from './routes/portfolio.js';
import { predictionsRouter } from './routes/predictions.js';
import { status } from './autonomy/engine.js';
import { marketHealth, fetchQuote } from './market/yahoo.js';
import { probe } from './brain/client.js';
import { briefFor } from './lib/voiceBrief.js';
import { rateLimit } from './lib/rateLimit.js';
import { log } from './lib/log.js';

// "It takes forever" is not actionable; a number is. Every response carries
// its own duration, and anything slow says so in the log with the path that
// caused it.
function timing(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms >= config.slowRequestMs) {
      log.warn(`slow ${req.method} ${req.originalUrl} took ${Math.round(ms)}ms`);
    }
  });
  // Server-Timing shows up in the browser's network panel per request.
  const send = res.send.bind(res);
  res.send = (body) => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (!res.headersSent) res.set('Server-Timing', `app;dur=${ms.toFixed(1)}`);
    return send(body);
  };
  const json = res.json.bind(res);
  res.json = (body) => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (!res.headersSent) res.set('Server-Timing', `app;dur=${ms.toFixed(1)}`);
    return json(body);
  };
  next();
}

function cors(req, res, next) {
  const origin = req.headers.origin;
  // No Origin means same-origin or a file:// page — nothing to negotiate.
  if (origin) {
    const allowed =
      config.corsOrigins.includes('*') ||
      config.corsOrigins.includes(origin) ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (allowed) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    } else if (req.method !== 'GET') {
      return res.status(403).json({ ok: false, error: `origin not allowed: ${origin}` });
    }
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

export function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(cors);
  app.use(express.json({ limit: '1mb' }));
  app.use(timing);

  // Health stays open so a load balancer never needs the secret.
  app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
  app.use(authMiddleware);

  // Capability advertisement. Booleans only — no secret ever crosses this line.
  app.get('/api/config', (_req, res) => {
    res.json({
      ok: true,
      brain: { configured: brainConfigured(), model: config.brain.model, proxyPath: '/api/v1' },
      notify: { configured: Boolean(config.notify.webhook) },
      market: {
        provider: 'yahoo',
        cacheMs: config.market.cacheMs,
        warmMs: config.market.warmMs,
        ...marketHealth(),
      },
      egress: { privateAllowed: config.fetch.allowPrivateEgress },
      auth: { required: authRequired() },
      voice: { alerts: config.notify.voice },
      autonomy: { enabled: config.autonomy.enabled, ...status() },
    });
  });

  // Where the time actually goes. Times each hop independently so "it takes
  // forever" becomes a number attached to a stage.
  app.get('/api/diagnostics', rateLimit({ name: 'diag', max: 10 }), async (_req, res) => {
    const time = async (name, fn) => {
      const started = Date.now();
      try {
        const detail = await fn();
        return { name, ms: Date.now() - started, ok: true, detail: detail ?? null };
      } catch (err) {
        return { name, ms: Date.now() - started, ok: false, error: err?.message || String(err) };
      }
    };

    const stages = [];
    stages.push(
      await time('market quote (AAPL)', async () => {
        const q = await fetchQuote('AAPL');
        return { source: q.source || 'v7', partial: Boolean(q.partial) };
      }),
    );
    stages.push(
      await time('model brain', async () => {
        if (!brainConfigured()) return 'not configured';
        const p = await probe();
        if (!p.ok) throw new Error(p.error || 'probe failed');
        return p.model;
      }),
    );
    stages.push(
      await time('voice brief (rules or model)', async () => {
        const b = await briefFor('Momentum is constructive with price 12.4531% above the average.', {
          skipPassthrough: true,
        });
        return b.source;
      }),
    );

    const total = stages.reduce((a, s) => a + s.ms, 0);
    res.json({
      ok: true,
      totalMs: total,
      stages,
      market: marketHealth(),
      hint:
        stages.find((s) => !s.ok && s.name.startsWith('market'))
          ? 'The market feed is failing; dossiers will be slow until the breaker settles or the feed recovers.'
          : null,
    });
  });

  app.use('/api', fetchRouter);
  app.use('/api', notifyRouter);
  app.use('/api', yahooRouter);
  app.use('/api', brainRouter);
  app.use('/api', autonomyRouter);
  app.use('/api', genomeRouter);
  app.use('/api', voiceRouter);
  app.use('/api', portfolioRouter);
  app.use('/api', predictionsRouter);

  app.get('/', (_req, res) => {
    res.type('html').send(renderIndex());
  });
  // The desk declares no icon, so browsers ask anyway; answer quietly rather
  // than leaving a 404 in every operator's console.
  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  app.use(express.static(path.resolve(process.cwd(), 'public'), { index: false }));

  app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'no such endpoint' }));

  // eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity
  app.use((err, _req, res, _next) => {
    log.error(`unhandled error: ${err?.message || err}`);
    res.status(err?.status || 500).json({ ok: false, error: err?.message || 'internal error' });
  });

  return app;
}
