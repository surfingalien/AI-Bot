import express from 'express';
import path from 'node:path';
import { config, brainConfigured } from './config.js';
import { renderIndex } from './ui.js';
import { fetchRouter } from './routes/fetch.js';
import { notifyRouter } from './routes/notify.js';
import { yahooRouter } from './routes/yahoo.js';
import { brainRouter } from './routes/brain.js';
import { autonomyRouter } from './routes/autonomy.js';
import { genomeRouter } from './routes/genome.js';
import { voiceRouter } from './routes/voice.js';
import { status } from './autonomy/engine.js';
import { log } from './lib/log.js';

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

  app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

  // Capability advertisement. Booleans only — no secret ever crosses this line.
  app.get('/api/config', (_req, res) => {
    res.json({
      ok: true,
      brain: { configured: brainConfigured(), model: config.brain.model, proxyPath: '/api/v1' },
      notify: { configured: Boolean(config.notify.webhook) },
      market: { provider: 'yahoo', cacheMs: config.market.cacheMs },
      egress: { privateAllowed: config.fetch.allowPrivateEgress },
      autonomy: { enabled: config.autonomy.enabled, ...status() },
    });
  });

  app.use('/api', fetchRouter);
  app.use('/api', notifyRouter);
  app.use('/api', yahooRouter);
  app.use('/api', brainRouter);
  app.use('/api', autonomyRouter);
  app.use('/api', genomeRouter);
  app.use('/api', voiceRouter);

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
