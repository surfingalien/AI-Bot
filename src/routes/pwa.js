// What turns the desk from a page into something that installs.
//
// Three things are needed and none of them can live in index.html, which is
// authored elsewhere and re-uploaded whole: a manifest, icons, and a service
// worker. Serving them here means a new desk build drops in without carrying
// any of this with it.
//
// The service worker deliberately does almost nothing. A desk whose whole point
// is live market data must never answer from a cache it forgot to invalidate,
// so nothing under /api is cached, ever. What it caches is the shell — enough
// that an installed app opens to something rather than to a browser error when
// the network is slow or absent.

import { Router } from 'express';
import { iconFor } from '../lib/icon.js';

export const pwaRouter = Router();

const ICON_SIZES = { '/icon-192.png': 192, '/icon-512.png': 512, '/apple-touch-icon.png': 180 };

// Bumping this is what retires an old shell cache. It is the only versioning
// the worker has, and it needs to change whenever the shell changes.
const SHELL_VERSION = 'sa-shell-v1';

pwaRouter.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json').json({
    name: 'SurfingAlien Desk',
    short_name: 'SurfingAlien',
    description: 'Deep-research desk: dossiers, autonomy goals and spoken briefings.',
    start_url: '/',
    scope: '/',
    // Standalone is the point of installing: no address bar, no browser chrome,
    // and the desk's own full-height layout finally gets the whole screen.
    display: 'standalone',
    orientation: 'any',
    background_color: '#040e22',
    theme_color: '#040e22',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Maskable is a separate declaration even when it is the same file: a
      // launcher that crops to a circle will not do so unless told it may.
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

for (const [path, size] of Object.entries(ICON_SIZES)) {
  pwaRouter.get(path, (_req, res) => {
    res.type('image/png').set('Cache-Control', 'public, max-age=604800').send(iconFor(size));
  });
}

pwaRouter.get('/sw.js', (_req, res) => {
  res
    .type('application/javascript')
    // A worker cached by the browser is a worker that cannot be replaced.
    .set('Cache-Control', 'no-cache')
    .send(`/* SurfingAlien desk — shell only, never data */
var SHELL = '${SHELL_VERSION}';

self.addEventListener('install', function (e) {
  // The desk is one HTML file, so the shell is one entry.
  e.waitUntil(caches.open(SHELL).then(function (c) { return c.addAll(['/']); }).then(function () {
    return self.skipWaiting();
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === SHELL ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Market data, model answers, autonomy state — all of it is only worth having
  // fresh. A stale dossier is worse than no dossier.
  if (url.pathname.indexOf('/api/') === 0) return;

  // Network first, so an open tab always has the current desk. The cache is
  // what answers when there is no network at all.
  e.respondWith(
    fetch(req)
      .then(function (res) {
        if (res && res.ok && (url.pathname === '/' || /\\.(js|css|png|webmanifest)$/.test(url.pathname))) {
          var copy = res.clone();
          caches.open(SHELL).then(function (c) { c.put(req, copy); });
        }
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('/');
        });
      }),
  );
});
`);
});
