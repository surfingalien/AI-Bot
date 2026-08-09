// Minimal fixed-window limiter. Enough to stop a loose autonomy loop or a
// stuck browser tab from hammering upstreams; not a substitute for a real
// gateway in front of a public deployment.

import { config } from '../config.js';

const buckets = new Map();

export function rateLimit(options = {}) {
  const windowMs = options.windowMs || config.rateLimit.windowMs;
  const max = options.max || config.rateLimit.max;

  return function limiter(req, res, next) {
    const key = `${options.name || 'global'}:${req.ip}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.start + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ ok: false, error: 'rate limit exceeded', retryAfter });
    }
    return next();
  };
}

export function resetRateLimits() {
  buckets.clear();
}
