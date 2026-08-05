// End-to-end checks against a real listening server. Config is read at import
// time, so the environment is set before the app modules are pulled in.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-test-'));
process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.AUTONOMY_ENABLED = 'false';
process.env.NOTIFY_WEBHOOK = '';
process.env.BRAIN_BASE = '';
process.env.LOG_LEVEL = 'error';
process.env.RATE_LIMIT_MAX = '10000';

const { createApp } = await import('../src/app.js');

const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const api = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test('health and config report capabilities without leaking secrets', async () => {
  const health = await api('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);

  const config = await api('GET', '/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.json.brain.configured, false);
  assert.equal(config.json.notify.configured, false);
  assert.equal(JSON.stringify(config.json).includes('BRAIN_KEY'), false);
});

test('the desk HTML is served with server defaults injected', async () => {
  const res = await fetch(base + '/');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /SURFINGALIEN AI/);
  assert.match(html, /injected by the SurfingAlien server/);
  // The bootstrap must run before the engine block it configures.
  assert.ok(html.indexOf('__SA_SERVER') < html.indexOf('id="engineSrc"'));
});

test('/api/fetch refuses malformed and private targets', async () => {
  const bad = await api('GET', '/api/fetch?url=ftp://example.com');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.ok, false);

  const priv = await api('GET', '/api/fetch?url=http://169.254.169.254/latest/meta-data/');
  assert.equal(priv.status, 403);
  assert.match(priv.json.error, /non-public/);
});

test('/api/notify reports the missing webhook instead of pretending to send', async () => {
  const res = await api('POST', '/api/notify', { text: 'ping' });
  assert.equal(res.status, 502);
  assert.match(res.json.error, /no webhook configured/);
});

test('/api/notify refuses caller-supplied webhooks by default', async () => {
  const res = await api('POST', '/api/notify', {
    text: 'ping',
    webhook: 'https://example.com/hook',
  });
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /disabled/);
});

test('the brain proxy answers 503 when no upstream is configured', async () => {
  const res = await api('POST', '/api/v1/chat/completions', {
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.status, 503);
  assert.match(res.json.error.message, /not configured/);
});

test('the embeddings passthrough exists so semantic recall can reach the model', async () => {
  // 503 rather than 404: the route is wired, the upstream just is not.
  const res = await api('POST', '/api/v1/embeddings', { input: 'remember this' });
  assert.equal(res.status, 503);
  assert.match(res.json.error.message, /not configured/);
});

test('the panel script is served alongside the desk', async () => {
  const res = await fetch(`${base}/desk-server.js`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /SERVER RUNTIME/);

  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /<script src="\/desk-server\.js" defer><\/script>/);
});

test('invalid symbols are rejected before any upstream call', async () => {
  const res = await api('GET', '/api/yahoo/quote/not%20a%20symbol');
  assert.equal(res.status, 400);
  assert.match(res.json.error, /invalid symbol/);
});

test('goals: arm, run on demand, inspect activity, disable, delete', async () => {
  const created = await api('POST', '/api/autonomy/goals', {
    name: 'heartbeat',
    condText: 'always',
    actionText: 'log still breathing',
    cadenceSec: 60,
  });
  assert.equal(created.status, 201);
  const id = created.json.goal.id;
  assert.equal(created.json.goal.enabled, true);

  const run = await api('POST', `/api/autonomy/goals/${id}/run`);
  assert.equal(run.status, 200);
  assert.equal(run.json.activity.summary, 'still breathing');
  assert.equal(run.json.activity.fired, true);

  const activity = await api('GET', '/api/autonomy/activity');
  assert.equal(activity.json.activity[0].goal, 'heartbeat');

  const patched = await api('PATCH', `/api/autonomy/goals/${id}`, { enabled: false });
  assert.equal(patched.json.goal.enabled, false);

  const removed = await api('DELETE', `/api/autonomy/goals/${id}`);
  assert.equal(removed.json.ok, true);
  assert.equal((await api('DELETE', `/api/autonomy/goals/${id}`)).status, 404);
});

test('goals with an unrunnable condition or action are refused at arm time', async () => {
  const badCond = await api('POST', '/api/autonomy/goals', {
    name: 'nope',
    condText: 'when vibes are good',
    actionText: 'log hi',
  });
  assert.equal(badCond.status, 400);

  const badAction = await api('POST', '/api/autonomy/goals', {
    name: 'nope',
    condText: 'always',
    actionText: 'delete production',
  });
  assert.equal(badAction.status, 400);
  assert.match(badAction.json.error, /unrecognised action/);
});

test('a remember goal writes durable memory', async () => {
  const created = await api('POST', '/api/autonomy/goals', {
    name: 'note',
    condText: 'always',
    actionText: 'remember focus = semiconductors',
  });
  await api('POST', `/api/autonomy/goals/${created.json.goal.id}/run`);

  const view = await api('GET', '/api/autonomy');
  assert.ok(view.json.memory.some((m) => m.k === 'focus' && m.v === 'semiconductors'));

  const saved = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8'));
  assert.ok(saved.memory.some((m) => m.k === 'focus'));
});

test('watchlist accepts valid tickers and reports the rest', async () => {
  const res = await api('PUT', '/api/autonomy/watchlist', {
    symbols: ['nvda', '$AAPL', 'nvda', 'not a ticker'],
  });
  assert.deepEqual(
    res.json.watchlist.map((w) => w.sym),
    ['NVDA', 'AAPL'],
  );
  assert.deepEqual(res.json.rejected, ['not a ticker']);
});

test('genome round-trips through the server in the browser format', async () => {
  const imported = await api('POST', '/api/genome', {
    kind: 'surfingalien-genome',
    v: 4,
    name: 'Operator',
    goals: [
      { name: 'open bell', condText: 'at 09:30', actionText: 'scan watchlist', cadenceSec: 300 },
      { name: 'broken', condText: 'if it feels right', actionText: 'log hi' },
    ],
    watchlist: [{ sym: 'MSFT' }],
    memory: [{ k: 'desk', v: 'equities' }],
    tasks: [{ id: 't1', text: 'review NVDA thesis', owner: 'chief', done: false }],
    portfolio: [{ sym: 'nvda', shares: 10, cost: 118.4 }],
    consensus: true,
  });
  assert.equal(imported.json.importedGoals, 1);
  assert.equal(imported.json.skipped.length, 1);
  assert.match(imported.json.skipped[0].reason, /unrecognised condition/);

  const exported = await api('GET', '/api/genome');
  assert.equal(exported.json.kind, 'surfingalien-genome');
  assert.equal(exported.json.v, 5);
  assert.ok(exported.json.goals.some((g) => g.name === 'open bell'));
  assert.ok(exported.json.watchlist.some((w) => w.sym === 'MSFT'));
  assert.ok(exported.json.tasks.some((t) => t.text === 'review NVDA thesis'));
  // Positions and the bull/bear toggle belong to the desk; the server holds
  // them verbatim so a push/pull round trip does not drop them.
  assert.deepEqual(exported.json.portfolio, [{ sym: 'NVDA', shares: 10, cost: 118.4 }]);
  assert.equal(exported.json.consensus, true);
});

test('an imported open task satisfies a "tasks open" condition', async () => {
  const created = await api('POST', '/api/autonomy/goals', {
    name: 'chase',
    condText: 'tasks open',
    actionText: 'log work remains',
  });
  assert.equal(created.status, 201);

  const before = (await api('GET', '/api/autonomy/activity')).json.activity.length;
  await api('POST', '/api/autonomy/tick');
  const after = (await api('GET', '/api/autonomy/activity')).json.activity;
  assert.ok(after.length > before);
  assert.ok(after.some((a) => a.goal === 'chase' && a.summary === 'work remains'));
});

test('unknown API paths 404 as JSON', async () => {
  const res = await api('GET', '/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.json.ok, false);
});
