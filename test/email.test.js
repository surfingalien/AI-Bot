// Email delivery against a stub standing in for Resend, plus the markdown
// rendering that decides what actually lands in an inbox.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-mail-'));

const sent = [];
let failNext = false;
const resend = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (failNext) {
      failNext = false;
      res.writeHead(422, { 'Content-Type': 'application/json' });
      return res.end('{"message":"invalid from address"}');
    }
    sent.push({ auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"id":"stub"}');
  });
});
resend.listen(0);
await new Promise((r) => resend.once('listening', r));

process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.PREDICTIONS_FILE = path.join(stateDir, 'predictions.jsonl');
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.ALLOW_PRIVATE_EGRESS = 'true';
process.env.EMAIL_TO = 'operator@example.com';
process.env.EMAIL_FROM = 'SurfingAlien <desk@example.com>';

const emailLib = await import('../src/lib/email.js');
const { config } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');

// The endpoint is configurable precisely so it can be pointed at a stub.
config.email.resendUrl = `http://127.0.0.1:${resend.address().port}/emails`;

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  resend.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('markdown becomes HTML a mail client can render', () => {
  const html = emailLib.markdownToHtml(
    [
      '## Portfolio',
      '| Symbol | Value |',
      '|---|---|',
      '| NVDA | $1,500 |',
      '',
      '**Total** is _up_ today.',
      '- one position',
    ].join('\n'),
  );

  assert.match(html, /<h3[^>]*>Portfolio<\/h3>/);
  assert.match(html, /<table/);
  assert.match(html, /<th[^>]*>Symbol<\/th>/);
  assert.match(html, /<td[^>]*>NVDA<\/td>/);
  assert.doesNotMatch(html, /\|---\|/, 'the separator row is layout, not content');
  assert.match(html, /<strong>Total<\/strong>/);
  assert.match(html, /<em>up<\/em>/);
  assert.match(html, /• one position/);
  assert.match(html, /not financial advice/i);
});

test('markdown rendering escapes anything that would inject markup', () => {
  const html = emailLib.markdownToHtml('A <script>alert(1)</script> line & an ampersand');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('with no provider configured it reports a dry run rather than claiming success', async () => {
  const result = await emailLib.sendEmail({ subject: 'Test', markdown: '# hello' });
  assert.equal(result.sent, false);
  assert.equal(result.via, 'dry-run');
  assert.match(result.reason, /no email provider/);
  assert.equal(emailLib.emailConfigured(), false);
});

test('with no recipient it says so instead of sending nowhere', async () => {
  const previous = config.email.to;
  config.email.to = '';
  const result = await emailLib.sendEmail({ subject: 'Test', markdown: 'hi' });
  config.email.to = previous;

  assert.equal(result.sent, false);
  assert.match(result.reason, /no recipient/);
});

test('a configured provider actually receives the message', async () => {
  config.email.resendKey = 'stub-key-must-not-leak';
  sent.length = 0;

  const result = await emailLib.sendEmail({
    subject: 'Prediction scorecard',
    markdown: '## Scorecard\n\nWin rate **60%**.',
  });

  assert.equal(result.sent, true);
  assert.equal(result.via, 'resend');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.to, ['operator@example.com']);
  assert.equal(sent[0].body.from, 'SurfingAlien <desk@example.com>');
  assert.equal(sent[0].body.subject, 'Prediction scorecard');
  assert.match(sent[0].body.html, /<strong>60%<\/strong>/);
  // Plain text rides along for clients that will not render HTML.
  assert.match(sent[0].body.text, /Win rate/);
  assert.equal(sent[0].auth, 'Bearer stub-key-must-not-leak');
});

test('a provider error is reported, not swallowed', async () => {
  failNext = true;
  const result = await emailLib.sendEmail({ subject: 'Test', markdown: 'hi' });

  assert.equal(result.sent, false);
  assert.equal(result.via, 'resend');
  assert.match(result.reason, /422|invalid from address/);
});

test('the endpoint mails a generated report and never echoes the key', async () => {
  sent.length = 0;
  const res = await fetch(`${base}/api/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report: 'scorecard' }),
  });
  const json = await res.json();

  assert.equal(res.status, 200);
  assert.equal(json.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.subject, /Prediction scorecard/);
  assert.doesNotMatch(JSON.stringify(json), /stub-key-must-not-leak/);

  config.email.resendKey = '';
});

test('the endpoint refuses a request with nothing to send', async () => {
  const res = await fetch(`${base}/api/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report: 'nonsense' }),
  });
  assert.equal(res.status, 400);
});
