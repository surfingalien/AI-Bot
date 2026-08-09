// Shared-secret access control, and the escape hatch that keeps the desk
// usable in a browser without putting the token in the page source.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'correct-horse-battery-staple';
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-auth-'));

process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.API_TOKEN = TOKEN;

// Imported dynamically: config reads the environment at module load, and a
// static import would be hoisted above the assignments above.
const { parseCookies, tokenMatches } = await import('../src/lib/auth.js');
const { createApp } = await import('../src/app.js');
const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('token comparison rejects near misses and length games', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches('correct-horse-battery-stapl', TOKEN), false);
  assert.equal(tokenMatches('correct-horse-battery-staplE', TOKEN), false);
  assert.equal(tokenMatches('', TOKEN), false);
  assert.equal(tokenMatches(TOKEN, ''), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
});

test('cookie parsing handles spacing, encoding and junk', () => {
  assert.deepEqual(parseCookies('a=1; b=two'), { a: '1', b: 'two' });
  assert.deepEqual(parseCookies('sa_token=a%20b'), { sa_token: 'a b' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies('novalue; x=1'), { x: '1' });
});

test('health stays open so a load balancer needs no secret', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
});

test('the API is closed without a token', async () => {
  for (const [method, url] of [
    ['GET', '/api/config'],
    ['GET', '/api/autonomy'],
    ['GET', '/api/genome'],
    ['POST', '/api/voice/brief'],
  ]) {
    const res = await fetch(base + url, { method });
    assert.equal(res.status, 401, `${url} should be closed`);
    assert.equal((await res.json()).error, 'unauthorized');
  }
});

test('arming a goal without a token is refused', async () => {
  const res = await fetch(`${base}/api/autonomy/goals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'intruder', condText: 'always', actionText: 'log hi' }),
  });
  assert.equal(res.status, 401);
});

test('a bearer header opens the API', async () => {
  const res = await fetch(`${base}/api/config`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.auth.required, true);
  // Knowing auth is on is fine; the secret itself must never be served.
  assert.doesNotMatch(JSON.stringify(json), new RegExp(TOKEN));
});

test('the X-SA-Token header works for clients that cannot set Authorization', async () => {
  const res = await fetch(`${base}/api/config`, { headers: { 'X-SA-Token': TOKEN } });
  assert.equal(res.status, 200);
});

test('the desk page is locked, and says how to unlock it', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 401);
  const html = await res.text();
  assert.match(html, /LOCKED/);
  assert.match(html, /\?token=/);
  assert.doesNotMatch(html, new RegExp(TOKEN), 'the lock screen must not leak the token');
});

test('?token= is exchanged for a cookie and stripped from the URL', async () => {
  const res = await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/', 'the token leaves the address bar');

  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /sa_token=/);
  assert.match(cookie, /HttpOnly/i, 'not readable from page scripts');
  assert.match(cookie, /SameSite=Lax/i);

  // The cookie alone now opens both the page and the API.
  const jar = cookie.split(';')[0];
  const page = await fetch(base + '/', { headers: { Cookie: jar } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SURFINGALIEN AI/);

  const api = await fetch(`${base}/api/autonomy`, { headers: { Cookie: jar } });
  assert.equal(api.status, 200);
});

test('a wrong token in the URL does not set a cookie', async () => {
  const res = await fetch(`${base}/?token=wrong`, { redirect: 'manual' });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('a forged cookie is rejected', async () => {
  const res = await fetch(`${base}/api/config`, { headers: { Cookie: 'sa_token=nope' } });
  assert.equal(res.status, 401);
});
