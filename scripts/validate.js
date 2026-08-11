#!/usr/bin/env node
// End-to-end validation of a real server process.
//
// `npm test` proves the units. This proves the assembled app: it boots
// src/server.js the way a host does, points every outbound dependency at a
// stub, and walks every route. That means what is being validated is the
// application rather than this machine's network policy — the run is identical
// on a laptop, in CI, and in a sandbox where the real upstreams are blocked.
//
// Exit code is the whole contract: 0 means every check passed.
//
//   npm run validate              routes only
//   npm run validate -- --browser also drive the desk in a real browser
//
// The browser pass needs playwright-core and a Chromium; when either is
// missing it is skipped and said so, never silently counted as a pass.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'validate-' + Math.random().toString(36).slice(2, 10);
const wantBrowser = process.argv.includes('--browser');

const results = [];
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function record(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`${ok ? green('✓') : red('✗')} ${label}${detail ? `  ${dim(detail)}` : ''}`);
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

// ── the stub every outbound dependency points at ────────────────────────────
// Shaped like the real responses, not like whatever the code happens to accept:
// a chart with enough closes for the long moving averages, an OpenAI-compatible
// completion, a Resend accept, an HTML page for the reader.
const closes = Array.from({ length: 320 }, (_, i) => 100 + i * 0.4 + Math.sin(i / 9) * 3);

const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => handle(req, res, raw));
});

function handle(req, res, raw) {
  const json = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url.startsWith('/emails')) return json({ id: 'stub-email' });
  if (req.url.startsWith('/hook')) return res.writeHead(200).end('ok');
  if (req.url.includes('/chat/completions')) {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* the route walk posts a minimal body; the desk posts a full one */
    }
    // The desk warms the brain with a non-streaming POST at boot. Answering
    // that with SSE makes it conclude the brain is dead and route everything to
    // its local agents, which quietly invalidates every model-backed check.
    if (body.stream !== true) {
      return json({ choices: [{ message: { content: 'A short spoken answer. Momentum is fine.' } }] });
    }

    const messages = body.messages || [];
    const toolAlreadyRan = messages.some((m) => m.role === 'tool');
    const asked = String(messages.filter((m) => m.role === 'user').pop()?.content || '');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

    if (/\bbook\b/i.test(asked) && !toolAlreadyRan) {
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_book_1',
                  type: 'function',
                  function: {
                    name: 'book_restaurant',
                    arguments: JSON.stringify({
                      venue: 'Osteria Mozza',
                      phone: '+1 (323) 297-0100',
                      partySize: 4,
                      when: 'Friday at 8pm',
                      onBehalfOf: 'Suhas',
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
    } else {
      sse({ choices: [{ delta: { content: 'Done — details are above.' } }] });
    }
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  if (req.url.includes('/embeddings')) return json({ data: [{ embedding: [0.1, 0.2] }] });
  if (req.url.includes('/models')) return json({ data: [{ id: 'stub-model' }] });
  if (req.url.startsWith('/page')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<html><head><title>A Source</title></head><body><p>Revenue grew 12%.</p></body></html>');
  }
  const sym = (req.url.match(/chart\/([^?]+)/) || [])[1] || 'TEST';
  return json({
    chart: {
      result: [
        {
          meta: {
            symbol: sym,
            regularMarketPrice: closes.at(-1),
            chartPreviousClose: closes.at(-2),
            longName: `${sym} Inc.`,
          },
          timestamp: closes.map((_, i) => Math.floor(Date.now() / 1000) - (closes.length - 1 - i) * 86400),
          indicators: {
            quote: [{ close: closes, high: closes.map((c) => c + 1), low: closes.map((c) => c - 1) }],
          },
        },
      ],
    },
  });
}

// ── a real server process, booted the way a host boots it ───────────────────
const children = [];
const tempDirs = [];

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-validate-'));
  tempDirs.push(dir);

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      API_TOKEN: TOKEN,
      LOG_LEVEL: 'error',
      STATE_FILE: path.join(dir, 'state.json'),
      PREDICTIONS_FILE: path.join(dir, 'predictions.jsonl'),
      // The loop runs, because the desk panel reports its real state and a
      // stopped loop is a different thing to validate. The tick is pushed out
      // of the run's lifetime instead: a background firing mid-walk would make
      // the activity assertions non-deterministic, so ticks happen only where
      // this script asks for one.
      AUTONOMY_ENABLED: 'true',
      AUTONOMY_TICK_MS: String(60 * 60 * 1000),
      YAHOO_BASE: stubBase,
      BRAIN_BASE: stubBase,
      BRAIN_KEY: 'stub-key',
      RESEND_API_KEY: 'stub-key',
      RESEND_ENDPOINT: `${stubBase}/emails`,
      EMAIL_TO: 'validate@example.com',
      NOTIFY_WEBHOOK: `${stubBase}/hook`,
      ...extraEnv,
    },
  });
  children.push(child);

  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  child.on('exit', (code) => {
    if (code) console.log(red(`server exited early (${code}):\n${logs.join('')}`));
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not come up:\n${logs.join('')}`);
    await new Promise((r) => setTimeout(r, 120));
  }
  return { base, child };
}

function stopAll() {
  for (const c of children) c.kill('SIGTERM');
  for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  stub.close();
}

// ── the walk ────────────────────────────────────────────────────────────────
let BASE = '';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

async function hit(label, method, url, { body, expect } = {}) {
  try {
    const res = await fetch(BASE + url, {
      method,
      headers: body ? { ...AUTH, 'Content-Type': 'application/json' } : AUTH,
      body: body ? JSON.stringify(body) : undefined,
    });
    const ok = expect ? expect.includes(res.status) : res.status < 400;
    results.push({ label, ok });
    console.log(
      `${ok ? green('✓') : red('✗')} ${String(res.status).padEnd(4)} ${method.padEnd(6)} ${url}  ${dim(label)}`,
    );
    return res;
  } catch (err) {
    results.push({ label, ok: false });
    console.log(`${red('✗')} ERR  ${method.padEnd(6)} ${url}  ${err.message}`);
    return null;
  }
}

const stubPort = await freePort();
const stubBase = `http://127.0.0.1:${stubPort}`;
stub.listen(stubPort, '127.0.0.1');
await new Promise((r) => stub.once('listening', r));

try {
  // Private egress is on for the main pass because every stub lives on
  // loopback. The production posture — egress locked — is asserted separately
  // at the end, against its own server.
  const main = await startServer({ ALLOW_PRIVATE_EGRESS: 'true' });
  BASE = main.base;

  console.log('\n── auth boundary ──');
  const open = await fetch(`${BASE}/api/health`);
  record('health is reachable with no token', open.status === 200, String(open.status));
  const closed = await fetch(`${BASE}/api/config`);
  record('everything else is closed without one', closed.status === 401, String(closed.status));

  console.log('\n── the desk ──');
  await hit('desk HTML', 'GET', '/');
  await hit('panel script', 'GET', '/desk-server.js');
  await hit('favicon answered quietly', 'GET', '/favicon.ico', { expect: [204] });

  console.log('\n── market feed ──');
  await hit('chart', 'GET', '/api/yahoo/chart/AAPL');
  await hit('quote (fallback ladder)', 'GET', '/api/yahoo/quote/AAPL');
  await hit('snapshot', 'GET', '/api/market/snapshot/NVDA');
  await hit('invalid symbol refused', 'GET', '/api/yahoo/quote/not%20a%20symbol', { expect: [400] });

  console.log('\n── research + brain ──');
  await hit('page reader', 'GET', `/api/fetch?url=${stubBase}/page`);
  await hit('brain probe', 'GET', '/api/brain/probe');
  await hit('chat completions', 'POST', '/api/v1/chat/completions', {
    body: { messages: [{ role: 'user', content: 'hi' }] },
  });
  await hit('embeddings', 'POST', '/api/v1/embeddings', { body: { input: 'remember this' } });
  await hit('deep research', 'POST', '/api/research', { body: { topic: 'test', urls: [`${stubBase}/page`] } });

  console.log('\n── voice ──');
  await hit('spoken brief', 'POST', '/api/voice/brief', {
    body: { text: '## X\n| a | b |\n|---|---|\n| 1 | 2 |\n\nUp 12.4531% today.' },
  });
  await hit('intent', 'POST', '/api/intent', { body: { transcript: "how's my portfolio doing" } });

  console.log('\n── autonomy ──');
  const armed = await hit('arm a goal', 'POST', '/api/autonomy/goals', {
    body: { name: 'validation', condText: 'price(NVDA) crosses above 1', actionText: 'log validated', cadenceSec: 60 },
    expect: [201],
  });
  const goalId = armed ? (await armed.json()).goal.id : null;
  await hit('unrunnable goal refused', 'POST', '/api/autonomy/goals', {
    body: { name: 'x', condText: 'when vibes are good', actionText: 'log y' },
    expect: [400],
  });
  await hit('state', 'GET', '/api/autonomy');
  await hit('activity', 'GET', '/api/autonomy/activity');
  await hit('watchlist', 'PUT', '/api/autonomy/watchlist', { body: { symbols: ['NVDA', 'AAPL'] } });
  await hit('memory', 'POST', '/api/autonomy/memory', { body: { k: 'desk', v: 'equities' } });
  if (goalId) await hit('run a goal now', 'POST', `/api/autonomy/goals/${goalId}/run`);
  await hit('tick', 'POST', '/api/autonomy/tick');
  if (goalId) await hit('disarm', 'DELETE', `/api/autonomy/goals/${goalId}`);

  console.log('\n── portfolio, ledger, sizing ──');
  await hit('set positions', 'PUT', '/api/portfolio', { body: { positions: [{ sym: 'NVDA', shares: 10, cost: 100 }] } });
  await hit('valuation', 'GET', '/api/portfolio?markdown=1');
  await hit('log a prediction', 'POST', '/api/predictions', {
    body: { symbol: 'NVDA', label: 'BUY', conviction: 'M', basePrice: 100, entryLow: 99, entryHigh: 101, target: 130, stop: 90 },
    expect: [201],
  });
  await hit('scorecard', 'GET', '/api/predictions?markdown=1');
  await hit('resolve outcomes', 'POST', '/api/predictions/resolve');
  await hit('kelly from a symbol', 'POST', '/api/kelly', { body: { symbol: 'NVDA' } });
  await hit('kelly refuses incoherent levels', 'POST', '/api/kelly', {
    body: { price: 100, target: 80, stop: 90, label: 'BUY' },
    expect: [400],
  });
  await hit('personas', 'GET', '/api/personas');

  console.log('\n── booking ──');
  await hit('an unconfigured booking says so', 'POST', '/api/book', {
    body: { venue: 'Osteria Mozza', phone: '+13232970100', partySize: 4, when: 'Friday 8pm' },
    expect: [501],
  });
  await hit('a malformed booking is a 400', 'POST', '/api/book', { body: { venue: 'X' }, expect: [400] });
  await hit('call status', 'GET', '/api/book/status/CA123', { expect: [501] });

  console.log('\n── reports out ──');
  await hit('alert webhook', 'POST', '/api/notify', { body: { text: 'validation alert' } });
  await hit('email a report', 'POST', '/api/email', { body: { report: 'scorecard' } });

  console.log('\n── genome + diagnostics ──');
  await hit('export genome', 'GET', '/api/genome');
  await hit('import genome', 'POST', '/api/genome', {
    body: { kind: 'surfingalien-genome', v: 5, goals: [], watchlist: [{ sym: 'MSFT' }] },
  });
  await hit('diagnostics', 'GET', '/api/diagnostics');
  await hit('unknown route 404s as JSON', 'GET', '/api/nope', { expect: [404] });

  // ── the production posture ────────────────────────────────────────────────
  // The pass above ran with private egress deliberately open so the stubs were
  // reachable. That is not how this deploys, so the default is asserted on its
  // own server: /api/fetch must refuse both cloud metadata and loopback.
  console.log('\n── SSRF guard, with egress at its default ──');
  const guarded = await startServer();
  const guardedBase = BASE;
  BASE = guarded.base;
  await hit('cloud metadata refused', 'GET', '/api/fetch?url=http://169.254.169.254/', { expect: [403] });
  await hit('loopback refused', 'GET', `/api/fetch?url=${stubBase}/page`, { expect: [403] });
  BASE = guardedBase;

  if (wantBrowser) {
    console.log('\n── the desk in a browser ──');
    const code = await new Promise((resolve) => {
      const b = spawn(process.execPath, ['scripts/validate-browser.js'], {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, VALIDATE_BASE: main.base, VALIDATE_TOKEN: TOKEN },
      });
      b.on('exit', resolve);
    });
    // 2 is the agreed "skipped, and here is why" code; only 1 is a failure.
    // A skip records nothing, so it can never be counted toward a green total.
    if (code === 0) results.push({ label: 'browser pass', ok: true });
    if (code === 1) results.push({ label: 'browser pass', ok: false });
  } else {
    console.log(dim('\n(browser pass not requested — run with `-- --browser` to include it)'));
  }
} finally {
  stopAll();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length ? red(`${results.length - failed.length}/${results.length} checks passed`) : green(`${results.length}/${results.length} checks passed`)}`,
);
for (const f of failed) console.log(red(`  - ${f.label}`));
process.exit(failed.length ? 1 : 0);
