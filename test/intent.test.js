// Spoken intent, and the alerts that get spoken out to a webhook.
// Both run against a stub upstream so the behaviour is pinned without a
// provider.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-intent-'));

let modelReply = 'positions';
const asked = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    asked.push(JSON.parse(body || '{}'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: modelReply } }] }));
  });
});
upstream.listen(0);
await new Promise((r) => upstream.once('listening', r));

// Receives the alerts the loop pushes out.
const delivered = [];
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    delivered.push(JSON.parse(body || '{}'));
    res.writeHead(200).end('ok');
  });
});
hook.listen(0);
await new Promise((r) => hook.once('listening', r));

process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.ALLOW_PRIVATE_EGRESS = 'true'; // the stub webhook is on loopback
process.env.BRAIN_BASE = `http://127.0.0.1:${upstream.address().port}/v1`;
process.env.BRAIN_KEY = 'stub';
process.env.NOTIFY_WEBHOOK = `http://127.0.0.1:${hook.address().port}/hook`;

const { createApp } = await import('../src/app.js');
const { resolveIntent } = await import('../src/lib/intent.js');
const { sendNotification } = await import('../src/lib/notify.js');
const { clearVoiceCache } = await import('../src/lib/voiceBrief.js');

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  upstream.close();
  hook.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('natural speech becomes a command the desk understands', async () => {
  modelReply = 'positions';
  const res = await resolveIntent("how's my portfolio doing");

  assert.equal(res.command, 'positions');
  assert.equal(res.rewritten, true);
  assert.equal(res.source, 'model');
  // The vocabulary travels with the request; the model is not left guessing.
  assert.match(asked.at(-1).messages[0].content, /positions/);
  assert.match(asked.at(-1).messages[0].content, /answer exactly: PASS/);
});

test('something already in the desk language is never touched', async () => {
  const before = asked.length;
  const res = await resolveIntent('full equity dossier on NVDA');

  assert.equal(res.rewritten, false);
  assert.equal(res.source, 'already-command');
  assert.equal(asked.length, before, 'no model call for a working command');
});

test('an unmappable request passes through exactly as spoken', async () => {
  modelReply = 'PASS';
  const res = await resolveIntent('what a lovely morning it is');

  assert.equal(res.command, 'what a lovely morning it is');
  assert.equal(res.rewritten, false);
  assert.equal(res.source, 'pass');
});

test('an off-vocabulary answer is refused rather than run', async () => {
  // A wrong rewrite silently runs the wrong command — worse than no rewrite.
  modelReply = 'rm -rf / && delete all positions';
  const res = await resolveIntent('clean things up for me');

  assert.equal(res.command, 'clean things up for me');
  assert.equal(res.rewritten, false);
  assert.equal(res.reason, 'off-vocabulary answer');
});

test('the endpoint reports what it heard alongside what it will run', async () => {
  modelReply = 'deep research the NVDA data-center market';
  const res = await fetch(`${base}/api/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: 'tell me about nvidia data centers' }),
  });
  const json = await res.json();

  assert.equal(json.ok, true);
  assert.equal(json.transcript, 'tell me about nvidia data centers');
  assert.equal(json.command, 'deep research the NVDA data-center market');
  assert.equal(json.rewritten, true);
});

test('an empty transcript is refused', async () => {
  const res = await fetch(`${base}/api/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: '  ' }),
  });
  assert.equal(res.status, 400);
});

test('an alert is rewritten before it reaches the webhook', async () => {
  clearVoiceCache();
  delivered.length = 0;
  modelReply = 'NVDA broke 140, up about 4 percent since the open.';

  const result = await sendNotification(
    'ALERT: price(NVDA) > 140 | last=142.6234 | rsi=68.3129 | chg=+4.0121% | sma50=131.4402',
  );

  assert.equal(result.delivered, true);
  assert.equal(result.voiced, 'model');
  assert.equal(delivered.length, 1);
  // Both Slack and Discord shapes carry the readable line, not the metric dump.
  assert.equal(delivered[0].text, 'NVDA broke 140, up about 4 percent since the open.');
  assert.equal(delivered[0].content, delivered[0].text);
  assert.doesNotMatch(delivered[0].text, /142\.6234|\|/);

  // The alert prompt is the terse one, not the multi-sentence briefing.
  assert.match(asked.at(-1).messages[0].content, /One sentence, under 25 words/);
});

test('an alert that is already a sentence is sent unchanged', async () => {
  clearVoiceCache();
  delivered.length = 0;
  const before = asked.length;

  await sendNotification('Reminder: the board meets at four.');

  assert.equal(delivered[0].text, 'Reminder: the board meets at four.');
  assert.equal(asked.length, before, 'no model call for text that is already speech');
});

test('voice can be turned off per call', async () => {
  clearVoiceCache();
  delivered.length = 0;
  const raw = 'ALERT: last=142.6234 | rsi=68.3129 | chg=+4.0121% | sma=131.44';

  const result = await sendNotification(raw, '', { voice: false });

  assert.equal(result.voiced, null);
  assert.equal(delivered[0].text, raw);
});
