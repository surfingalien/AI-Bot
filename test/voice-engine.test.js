// The optional server-side voice engine — real synthesis and transcription in
// place of the browser's own — exercised against a stub upstream so the
// contract (routing, headers, fallback statuses) is verified without a real
// provider or a network.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-voice-engine-'));

const seen = [];
let speechStatus = 200;
let transcribeStatus = 200;

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen.push({
      url: req.url,
      method: req.method,
      auth: req.headers.authorization,
      contentType: req.headers['content-type'],
      bodyLength: body.length,
      json: req.url === '/audio/speech' ? JSON.parse(body.toString('utf8') || '{}') : null,
    });

    if (req.url === '/audio/speech') {
      if (speechStatus !== 200) {
        res.writeHead(speechStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'stub failure' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(Buffer.from('fake-mp3-bytes'));
      return;
    }

    if (req.url === '/audio/transcriptions') {
      if (transcribeStatus !== 200) {
        res.writeHead(transcribeStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'stub failure' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: 'the mic heard this' }));
      return;
    }

    res.writeHead(404).end();
  });
});
upstream.listen(0);
await new Promise((r) => upstream.once('listening', r));

const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.VOICE_TTS_BASE = upstreamBase;
process.env.VOICE_TTS_KEY = 'tts-key-should-not-leak';
process.env.VOICE_STT_BASE = upstreamBase;
process.env.VOICE_STT_KEY = 'stt-key-should-not-leak';

const { createApp } = await import('../src/app.js');

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  upstream.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('/api/config advertises the voice engine as configured', async () => {
  const res = await fetch(`${base}/api/config`);
  const json = await res.json();
  assert.equal(json.voice.tts, true);
  assert.equal(json.voice.stt, true);
});

test('speak: synthesizes audio and never leaks the upstream key', async () => {
  seen.length = 0;
  const res = await fetch(`${base}/api/voice/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Nvidia is up three percent.' }),
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /^audio\//);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.toString('utf8'), 'fake-mp3-bytes');

  const call = seen.at(-1);
  assert.equal(call.url, '/audio/speech');
  assert.equal(call.auth, 'Bearer tts-key-should-not-leak');
  assert.equal(call.json.input, 'Nvidia is up three percent.');
  assert.doesNotMatch(buf.toString('latin1'), /tts-key-should-not-leak/);
});

test('speak: 400 without text', async () => {
  const res = await fetch(`${base}/api/voice/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('speak: upstream failure surfaces as a clean error, not a 200 of garbage', async () => {
  speechStatus = 500;
  const res = await fetch(`${base}/api/voice/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'anything' }),
  });
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.equal(json.ok, false);
  speechStatus = 200;
});

test('transcribe: forwards recorded audio and returns the transcript', async () => {
  seen.length = 0;
  const res = await fetch(`${base}/api/voice/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm' },
    body: Buffer.from('fake-webm-bytes'),
  });

  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.text, 'the mic heard this');

  const call = seen.at(-1);
  assert.equal(call.url, '/audio/transcriptions');
  assert.equal(call.auth, 'Bearer stt-key-should-not-leak');
  assert.match(call.contentType, /^multipart\/form-data/);
});

test('transcribe: 400 on an empty body', async () => {
  const res = await fetch(`${base}/api/voice/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm' },
    body: Buffer.alloc(0),
  });
  assert.equal(res.status, 400);
});

test('transcribe: upstream failure surfaces as a clean error', async () => {
  transcribeStatus = 500;
  const res = await fetch(`${base}/api/voice/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm' },
    body: Buffer.from('fake-webm-bytes'),
  });
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.equal(json.ok, false);
  transcribeStatus = 200;
});

test('both endpoints degrade to 503 when no voice engine is configured', async () => {
  const { config } = await import('../src/config.js');
  const savedTts = config.voice.tts.base;
  const savedStt = config.voice.stt.base;
  config.voice.tts.base = '';
  config.voice.stt.base = '';

  try {
    const speak = await fetch(`${base}/api/voice/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'anything' }),
    });
    assert.equal(speak.status, 503);

    const transcribe = await fetch(`${base}/api/voice/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: Buffer.from('fake-webm-bytes'),
    });
    assert.equal(transcribe.status, 503);

    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.equal(cfg.voice.tts, false);
    assert.equal(cfg.voice.stt, false);
  } finally {
    config.voice.tts.base = savedTts;
    config.voice.stt.base = savedStt;
  }
});
