// Shared-secret access control.
//
// Off by default, because on loopback it buys nothing. The moment this binds
// to a routable address it matters: without it, anyone who can reach the port
// can arm goals, read the memory and spend the model budget.
//
// The desk is a page, not an API client, so a header alone would lock the
// operator out of their own UI. Instead the token can arrive once in the URL
// (`/?token=…`), which is exchanged for an httpOnly cookie and stripped from
// the address bar — after that the browser authenticates itself, the token is
// not in the page source, and API clients can still use a bearer header.

import crypto from 'node:crypto';
import { config, authRequired } from '../config.js';

const OPEN_PATHS = new Set(['/api/health']);

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[key] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** Timing-safe comparison that tolerates length differences. */
export function tokenMatches(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) {
    // Still compare something of equal length so the failure path costs the
    // same as a mismatch of the right length.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function presentedToken(req) {
  const auth = req.headers.authorization || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  if (req.headers['x-sa-token']) return String(req.headers['x-sa-token']).trim();
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[config.auth.cookieName]) return cookies[config.auth.cookieName];
  if (req.query && req.query.token) return String(req.query.token);
  return '';
}

export function authMiddleware(req, res, next) {
  if (!authRequired()) return next();
  if (req.method === 'OPTIONS') return next();
  if (OPEN_PATHS.has(req.path)) return next();

  const presented = presentedToken(req);
  if (!tokenMatches(presented, config.auth.token)) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    return res
      .status(401)
      .type('html')
      .send(
        '<!doctype html><meta charset="utf-8"><title>SurfingAlien — locked</title>' +
          '<body style="font-family:ui-monospace,monospace;background:#070d18;color:#9fb8d8;' +
          'display:grid;place-items:center;height:100vh;margin:0;text-align:center">' +
          '<div><h1 style="color:#4fd0e6;letter-spacing:3px;font-size:16px">SURFINGALIEN — LOCKED</h1>' +
          '<p>This desk requires a token.</p>' +
          '<p style="color:#5d7aa3;font-size:12px">Open it once as ' +
          '<code style="color:#f5c451">/?token=YOUR_TOKEN</code> and this browser is remembered.</p></div></body>',
      );
  }

  // Arrived by URL: exchange it for a cookie and get it out of the address
  // bar, browser history and any screenshot.
  if (req.query && req.query.token && req.method === 'GET') {
    res.cookie?.(config.auth.cookieName, config.auth.token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: config.auth.cookieMaxAgeSec * 1000,
      secure: req.secure,
    });
    if (!req.path.startsWith('/api/')) {
      const url = new URL(req.originalUrl, 'http://placeholder');
      url.searchParams.delete('token');
      return res.redirect(302, url.pathname + (url.search || ''));
    }
  }

  return next();
}
