// The model path for spoken briefs, exercised against a stub upstream so the
// contract is verified without a real provider or a network.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-voice-'));

// Records what the server asks the model for, and answers as a provider would.
const seen = [];
let reply = 'Nvidia still screens as a buy, medium conviction. Momentum is the reason — it is trading about twelve percent above its two hundred day line. Valuation is the caveat.';

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
  });
});
upstream.listen(0);
await new Promise((r) => upstream.once('listening', r));

process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.BRAIN_BASE = `http://127.0.0.1:${upstream.address().port}/v1`;
process.env.BRAIN_KEY = 'test-key-should-not-leak';
process.env.BRAIN_MODEL = 'stub-model';

const { createApp } = await import('../src/app.js');
const { clearVoiceCache } = await import('../src/routes/voice.js');

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  upstream.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const brief = async (body) => {
  const res = await fetch(`${base}/api/voice/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

test('a dossier is rewritten by the model into a spoken brief', async () => {
  clearVoiceCache();
  seen.length = 0;

  const res = await brief({
    text:
      '## NVDA\n| Metric | Value |\n|---|---|\n| Last | $142.6234 |\n\n' +
      'Momentum is constructive with price 12.4531% above the 200-day average [1].\n' +
      '**VERDICT:** BUY (M)',
    title: 'NVDA dossier',
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.source, 'model');
  assert.match(res.json.script, /Nvidia still screens as a buy/);

  const call = seen[0];
  assert.equal(call.url, '/v1/chat/completions');
  assert.equal(call.body.model, 'stub-model');
  // The written analysis goes up; the voice constraints ride with it.
  assert.match(call.body.messages[0].content, /2 to 4 sentences/);
  assert.match(call.body.messages[0].content, /Never read a table/);
  assert.match(call.body.messages[1].content, /NVDA dossier/);
});

test('the upstream key never travels back to the caller', async () => {
  clearVoiceCache();
  const res = await brief({ text: 'A long written passage with 12.3456% and [1] a citation.' });
  assert.doesNotMatch(JSON.stringify(res.json), /test-key-should-not-leak/);
  assert.match(seen.at(-1).auth, /^Bearer test-key-should-not-leak$/);
});

test('markup a model leaves behind is stripped before it is spoken', async () => {
  clearVoiceCache();
  reply = '**The call is buy.** See the table [1] at https://example.com for 12.4531% detail.';

  const res = await brief({ text: 'A written passage with 12.3456% and [2] a citation in it.' });
  assert.equal(res.json.source, 'model');
  assert.doesNotMatch(res.json.script, /[*|#]/);
  assert.doesNotMatch(res.json.script, /https?:/);
  assert.doesNotMatch(res.json.script, /\[\d\]/);
  assert.match(res.json.script, /12\.5 percent/, 'figures still get spoken rounding');
});

test('an upstream failure falls back to the rules script rather than silence', async () => {
  clearVoiceCache();
  const original = process.env.BRAIN_BASE;
  // Point at a closed port to force the failure path.
  const dead = http.createServer();
  dead.listen(0);
  await new Promise((r) => dead.once('listening', r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));

  process.env.BRAIN_BASE = `http://127.0.0.1:${deadPort}/v1`;
  const { config } = await import('../src/config.js');
  config.brain.base = `http://127.0.0.1:${deadPort}/v1`;

  const res = await brief({
    text: 'Momentum is constructive with price 12.4531% above the 200-day average [1].',
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.source, 'rules');
  assert.match(res.json.script, /12\.5 percent/);

  config.brain.base = original.replace(/\/v1$/, '/v1');
  process.env.BRAIN_BASE = original;
});
