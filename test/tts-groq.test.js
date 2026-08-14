// The OpenAI-compatible speech shape, which is what Groq serves.
//
// Separate from tts.test.js because the backend is chosen by environment, and
// the environment is per-process. What is pinned here is the request the desk
// actually sends — a wrong field name is a silent desk, and silence is the one
// symptom this whole path exists to remove.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-groq-'));

function wav() {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + 240, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(240, 40);
  return Buffer.concat([header, Buffer.alloc(240)]);
}

const asked = [];
// One host serving both the model and the voice, which is how Groq works and
// the reason the key is shared rather than set twice.
const groq = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    asked.push({ url: req.url, body: JSON.parse(body || '{}'), auth: req.headers.authorization });

    if (req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { content: 'A spoken answer.' } }] }));
    }
    if (req.url.endsWith('/audio/speech')) {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return res.end(wav());
    }
    res.writeHead(404).end();
    return undefined;
  });
});
groq.listen(0);
await new Promise((r) => groq.once('listening', r));
const groqBase = `http://127.0.0.1:${groq.address().port}/openai/v1`;

process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
// The same base for both, which is the point: one account, one key.
process.env.BRAIN_BASE = groqBase;
process.env.BRAIN_KEY = 'gsk-one-key-for-both';
process.env.TTS_BASE = groqBase;
process.env.TTS_KEY = ''; // deliberately unset — it should fall back to the brain's
process.env.TTS_MODEL = 'canopylabs/orpheus-v1-english';
process.env.TTS_VOICE = 'hannah';
process.env.TTS_FORMAT = 'wav';

const { createApp } = await import('../src/app.js');

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  groq.closeAllConnections?.();
  groq.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('the desk sends the speech request in the shape Groq expects', async () => {
  const res = await fetch(`${base}/api/voice/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Momentum is constructive here.' }),
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /^audio\/wav/);
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString('ascii'), 'RIFF');

  const sent = asked.at(-1);
  assert.match(sent.url, /\/audio\/speech$/, 'the OpenAI speech path, not OmniVoice’s');
  // Field names are the contract. `text` instead of `input` is a 400 from the
  // provider and a silent desk here.
  assert.deepEqual(sent.body, {
    model: 'canopylabs/orpheus-v1-english',
    input: 'Momentum is constructive here.',
    voice: 'hannah',
    response_format: 'wav',
  });
});

test('one key covers the model and the voice when they share a host', async () => {
  // Groq serves both from one account. Making the operator paste the same
  // secret into two variables is an invitation to update only one of them.
  assert.equal(asked.at(-1).auth, 'Bearer gsk-one-key-for-both');

  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.voice.speech, true);
  assert.doesNotMatch(JSON.stringify(cfg), /gsk-one-key-for-both/, 'and it never reaches the browser');
});

test('the model is configuration, not a constant in the source', async () => {
  // Providers retire these — playai-tts already went — and a model id compiled
  // into the source turns that into an outage that needs a release.
  const { config } = await import('../src/config.js');
  assert.equal(config.tts.model, 'canopylabs/orpheus-v1-english');
  assert.equal(config.tts.provider, 'openai', 'the hosted shape is the default');

  const source = fs.readFileSync(path.resolve('src/lib/tts.js'), 'utf8');
  assert.doesNotMatch(source, /orpheus|playai/i, 'no model id baked into the client');
});
