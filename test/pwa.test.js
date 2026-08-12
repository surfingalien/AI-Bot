// What has to be true for the desk to install, and what must never be true of
// the worker that makes it possible.
//
// The interesting assertions here are the negative ones. A service worker on a
// desk whose whole purpose is live market data is a liability if it caches the
// wrong thing, and install metadata behind a login is metadata a browser never
// reads — both are silent failures rather than loud ones.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pwa-'));
process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
// Locked, so the checks below prove the install metadata is reachable without
// the secret rather than merely reachable.
process.env.API_TOKEN = 'pwa-secret';

const { createApp } = await import('../src/app.js');
const { renderIndex } = await import('../src/ui.js');

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('the manifest is readable without signing in', async () => {
  // A browser decides whether a site is installable before anyone has entered a
  // token. Behind the lock this 401s at exactly that moment and the desk simply
  // never offers to install — with nothing anywhere to say why.
  const res = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/manifest\+json/);

  const manifest = await res.json();
  assert.equal(manifest.display, 'standalone', 'standalone is the point of installing');
  assert.equal(manifest.start_url, '/');
  assert.ok(manifest.icons.length >= 2, 'a launcher needs more than one size');
  assert.ok(
    manifest.icons.some((i) => i.purpose === 'maskable'),
    'a launcher that crops to a circle will not do so unless told it may',
  );
});

test('the icons are real PNGs of the size they claim', async () => {
  for (const [path, size] of [
    ['/icon-192.png', 192],
    ['/icon-512.png', 512],
    ['/apple-touch-icon.png', 180],
  ]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type') || '', /image\/png/, path);

    const png = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(
      [...png.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      `${path} is not a PNG`,
    );
    // IHDR carries the dimensions, so this catches a generator that silently
    // draws the wrong size far better than a byte count would.
    assert.equal(png.readUInt32BE(16), size, `${path} width`);
    assert.equal(png.readUInt32BE(20), size, `${path} height`);
  }
});

test('the worker never caches anything under /api', async () => {
  // A dossier answered from yesterday's cache is worse than no dossier: it is
  // wrong in a way nobody can see.
  const res = await fetch(`${base}/sw.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /no-cache/, 'a cached worker cannot be replaced');

  const body = await res.text();
  assert.match(body, /pathname\.indexOf\('\/api\/'\) === 0/);
  assert.match(body, /if \(req\.method !== 'GET'\) return;/, 'and never touches a write');
});

test('the desk asks to be installed and knows how to fit a phone', () => {
  const html = renderIndex();

  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);

  // The head is where these have to land — a manifest link in the body is
  // ignored — and index.html is authored elsewhere, so the splice is the whole
  // mechanism.
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes('rel="manifest"'), 'the manifest link is inside <head>');
  assert.ok(head.includes('id="sa-fit"'), 'so are the mobile rules');

  // These selectors are a contract with a desk build authored outside this
  // repo. If it renames them the layout degrades rather than breaking, but the
  // test should say so out loud when it happens.
  const desk = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
  for (const selector of ['class="drawer"', 'class="tabs"', 'class="tab ']) {
    assert.ok(desk.includes(selector), `the mobile rules target ${selector}, which is gone`);
  }
});

test('the desk itself is still behind the lock', async () => {
  // Opening the install metadata must not have opened the desk with it.
  const res = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(res.status, 401);
});
