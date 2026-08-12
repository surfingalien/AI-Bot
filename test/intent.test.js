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

test('everyday phrasings resolve locally, with no model round trip', async () => {
  const before = asked.length;

  for (const [said, expected] of [
    ["how's my portfolio doing", 'positions'],
    ['show me my holdings', 'positions'],
    ['scan the watchlist', 'scan watchlist'],
    ['give me the weekly report', 'weekly report'],
    ['catch me up', 'audio brief'],
    ['tell me about nvidia', 'full equity dossier on NVDA'],
    ['compare apple vs microsoft', 'compare AAPL vs MSFT'],
    ['please remember that the board meets first Mondays', 'remember the board meets first Mondays'],
    ['add a task to review the NVDA thesis', 'add task review the NVDA thesis'],
  ]) {
    const res = await resolveIntent(said);
    assert.equal(res.command, expected, said);
    assert.equal(res.source, 'fast-path', said);
  }

  assert.equal(asked.length, before, 'the fast path costs no model latency');
});

test('the rest of the vocabulary resolves locally too', async () => {
  // Earnings, valuation and backtests had no local pattern at all, so every one
  // of them paid a model round trip before the desk started working — on the
  // path where the operator is standing there waiting for it to.
  const before = asked.length;

  for (const [said, expected] of [
    ['nvidia earnings', 'earnings decode NVDA'],
    ["apple's earnings", 'earnings decode AAPL'],
    ['how did meta do last quarter', 'earnings decode META'],
    ['tesla quarterly results', 'earnings decode TSLA'],
    ["what's nvidia worth", 'DCF value NVDA'],
    ['fair value of meta', 'DCF value META'],
    ['dcf on nvidia', 'DCF value NVDA'],
    ['backtest nvidia', 'backtest NVDA momentum strategy'],
    ['test momentum on apple', 'backtest AAPL momentum strategy'],
    ['how am I doing', 'positions'],
    ['what am I holding', 'positions'],
    ['update me', 'audio brief'],
    ['run the scan', 'scan watchlist'],
  ]) {
    const res = await resolveIntent(said);
    assert.equal(res.command, expected, said);
    assert.equal(res.source, 'fast-path', said);
  }

  assert.equal(asked.length, before, 'none of these are worth a round trip');
});

test('a subject that is really a pronoun is left to the model', async () => {
  // "tell me about it" matches the dossier shape exactly, and IT is a listed
  // symbol. Running it would answer a question nobody asked, confidently.
  modelReply = 'PASS';

  for (const said of ['tell me about it', 'what is it worth', 'value the position']) {
    const res = await resolveIntent(said);
    assert.equal(res.command, said, said);
    assert.notEqual(res.source, 'fast-path', said);
  }

  // Said as a symbol rather than a word, it is a symbol again.
  const explicit = await resolveIntent('what is $IT worth');
  assert.equal(explicit.command, 'DCF value IT');
  assert.equal(explicit.source, 'fast-path');
});

test('a spoken subject is resolved rather than passed through as a symbol', async () => {
  // "backtest nvidia" reads like a command and is not one: the desk wants a
  // symbol. Treating it as already-valid sent "nvidia" downstream as a ticker.
  const res = await resolveIntent('backtest nvidia');
  assert.equal(res.command, 'backtest NVDA momentum strategy');
  assert.equal(res.rewritten, true);

  // The real command form still passes through untouched.
  for (const command of ['backtest NVDA momentum strategy', 'earnings decode NVDA', 'DCF value NVDA']) {
    const kept = await resolveIntent(command);
    assert.equal(kept.command, command, command);
    assert.equal(kept.rewritten, false, command);
  }
});

test('a research question keeps its subject rather than becoming an earnings decode', async () => {
  // The earnings shape matches inside this, and matching it first would throw
  // away the part that made it a research question.
  const res = await resolveIntent("research nvidia's earnings quality");
  assert.equal(res.command, "deep research nvidia's earnings quality");
  assert.equal(res.source, 'fast-path');
});

test('a phrase that is already a valid command keeps its own wording', async () => {
  // "remember that X" is a working command; normalising it would be churn, and
  // leaving valid commands alone is the conservative default.
  const res = await resolveIntent('remember that the board meets first Mondays');
  assert.equal(res.command, 'remember that the board meets first Mondays');
  assert.equal(res.rewritten, false);
});

test('a request the fast path cannot place goes to the model', async () => {
  modelReply = 'deep research the NVDA data-center market';
  const res = await resolveIntent('what is going on with data center demand');

  assert.equal(res.command, 'deep research the NVDA data-center market');
  assert.equal(res.rewritten, true);
  assert.equal(res.source, 'model');
  // The vocabulary travels with the request; the model is not left guessing.
  assert.match(asked.at(-1).messages[0].content, /positions/);
  assert.match(asked.at(-1).messages[0].content, /answer exactly: PASS/);
});

test('a qualified subject is not flattened into a bare dossier', async () => {
  // "tell me about nvidia" is a dossier; adding a subject makes it research,
  // and the fast path must not silently drop the subject.
  modelReply = 'deep research the NVDA data-center market';
  const res = await resolveIntent('tell me about nvidia data centers');

  assert.equal(res.source, 'model');
  assert.notEqual(res.command, 'full equity dossier on NVDA');
});

test('something already in the desk language is never touched', async () => {
  const before = asked.length;

  for (const command of [
    'full equity dossier on NVDA',
    'positions',
    'scan watchlist',
    '@chief brief me',
  ]) {
    const res = await resolveIntent(command);
    assert.equal(res.command, command, command);
    assert.equal(res.rewritten, false, command);
  }

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
  const res = await fetch(`${base}/api/intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: "how's my portfolio doing" }),
  });
  const json = await res.json();

  assert.equal(json.ok, true);
  assert.equal(json.transcript, "how's my portfolio doing");
  assert.equal(json.command, 'positions');
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
