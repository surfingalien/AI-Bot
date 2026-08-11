// The desk's settings panel tells the operator to set PROXY_TOKEN, and sends
// that value as `Authorization: Bearer …`. The server used to read only
// API_TOKEN, so following the UI's own instructions produced a server with no
// auth at all — and the only signal was a startup warning nobody reads.
//
// Its own file because config reads the environment once, at import.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'set-by-the-desk-settings-panel';
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-proxytok-'));

process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
delete process.env.API_TOKEN;
process.env.PROXY_TOKEN = TOKEN;

const { config, authRequired } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('PROXY_TOKEN alone turns auth on', () => {
  assert.equal(authRequired(), true);
  assert.equal(config.auth.token, TOKEN);
});

test('the API is closed, and the desk’s bearer header opens it', async () => {
  assert.equal((await fetch(`${base}/api/config`)).status, 401);

  const res = await fetch(`${base}/api/config`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).auth.required, true);
});

test('API_TOKEN still wins when both are set', async () => {
  process.env.API_TOKEN = 'the-explicit-one';
  // Re-read the module in a fresh registry rather than mutating config, so this
  // asserts the precedence expression rather than the assignment order here.
  const fresh = await import(`../src/config.js?both=1`);
  assert.equal(fresh.config.auth.token, 'the-explicit-one');
  delete process.env.API_TOKEN;
});
