// Speech synthesised on the server, and every way that can go wrong.
//
// The whole point of this path is a browser with no voices installed, where
// nothing client-side can produce sound. So the failure behaviour matters more
// than the success: every fault here has to end with the desk being told to use
// its own voice, never with a desk that has gone quiet waiting for audio.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-tts-'));

// A minimal WAV: 44-byte header and a little silence. Enough that the desk
// treats it as audio, which is all the desk knows about it.
function wav(samples = 240) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples * 2, 40);
  return Buffer.concat([header, Buffer.alloc(samples * 2)]);
}

let mode = 'ok';
const asked = [];
const service = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, device: 'stub' }));
    }
    asked.push({ url: req.url, body: JSON.parse(body || '{}'), auth: req.headers.authorization });

    if (mode === 'down') return res.destroy();
    if (mode === 'error') {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ detail: 'model exploded' }));
    }
    if (mode === 'retired') {
      // What a decommissioned model actually looks like, in the shape hosted
      // providers use.
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          error: { message: 'The model `playai-tts` has been decommissioned.', code: 'model_decommissioned' },
        }),
      );
    }
    if (mode === 'html') {
      // A proxy or a login page answering 200 with something that is not a
      // sound. Playing it would be worse than not trying.
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>sign in</html>');
    }
    if (mode === 'empty') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return res.end(Buffer.alloc(0));
    }
    if (mode === 'huge') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return res.end(wav(6 * 1024 * 1024));
    }
    if (mode === 'slow') {
      await new Promise((r) => setTimeout(r, 3000));
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    return res.end(wav());
  });
});
service.listen(0);
await new Promise((r) => service.once('listening', r));

process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.TTS_BASE = `http://127.0.0.1:${service.address().port}`;
process.env.TTS_KEY = 'tts-secret';
process.env.TTS_PROVIDER = 'omnivoice';
process.env.TTS_INSTRUCT = 'female, low pitch, british accent';
process.env.TTS_TIMEOUT_MS = '800';
process.env.TTS_MAX_BYTES = String(4 * 1024 * 1024);

const { createApp } = await import('../src/app.js');

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  service.closeAllConnections?.();
  service.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const say = (text) =>
  fetch(`${base}/api/voice/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

test('a sentence comes back as audio the browser can just play', async () => {
  mode = 'ok';
  const res = await say('Nvidia still screens as a buy.');

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /^audio\/wav/);
  const audio = Buffer.from(await res.arrayBuffer());
  assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF', 'not a WAV');
  assert.ok(audio.length > 44);

  // The desk's configured voice travels with the request, and the service key
  // never leaves the server.
  assert.equal(asked.at(-1).body.text, 'Nvidia still screens as a buy.');
  assert.equal(asked.at(-1).body.instruct, 'female, low pitch, british accent');
  assert.equal(asked.at(-1).auth, 'Bearer tts-secret');
});

test('the service key never reaches the browser', async () => {
  mode = 'ok';
  const res = await say('Anything at all.');
  const audio = Buffer.from(await res.arrayBuffer());
  assert.doesNotMatch(audio.toString('latin1'), /tts-secret/);

  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.voice.speech, true, 'the capability is advertised');
  assert.doesNotMatch(JSON.stringify(cfg), /tts-secret/, 'but never the credential');
});

test('every failure tells the desk to use its own voice instead', async () => {
  // 503 is the contract: not an error page, not a hang, and not silence — the
  // signal to fall back. A desk waiting on audio that never comes is the one
  // outcome worse than a plainer voice.
  for (const [broken, why] of [
    ['down', 'the connection dropped'],
    ['error', 'the model failed'],
    ['html', 'something answered that was not audio'],
    ['empty', 'audio with nothing in it'],
    ['huge', 'more audio than a sentence could be'],
    ['slow', 'slower than the timeout'],
  ]) {
    mode = broken;
    const res = await say('A sentence worth hearing.');
    assert.equal(res.status, 503, why);
    assert.match(res.headers.get('content-type') || '', /application\/json/, why);
    const body = await res.json();
    assert.equal(body.ok, false, why);
  }
  mode = 'ok';
});

test('an empty request is refused before anything is generated', async () => {
  const before = asked.length;
  const res = await say('   ');
  assert.equal(res.status, 400);
  assert.equal(asked.length, before, 'a GPU is not spent on an empty string');
});

test('a retired model says so instead of just going quiet', async () => {
  // The failure most likely to happen on a hosted provider, and the one that
  // is a one-line config fix — if anybody is told. Silence is not a diagnosis.
  mode = 'retired';
  const res = await say('Anything at all.');

  assert.equal(res.status, 503, 'still falls back rather than erroring at the desk');
  const body = await res.json();
  assert.match(body.error, /decommissioned/, 'the provider’s own words reach the browser');
  assert.match(body.error, /playai-tts/, 'including which model');

  mode = 'ok';
});
