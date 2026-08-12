// What happens when the model is slow in the ways that actually happen: it
// answers steadily but takes a while, it stops mid-sentence, or it never
// answers at all.
//
// The distinction under test is between bounding the *call* and bounding the
// *silence*. A brief that is still arriving is not late — cutting it off at a
// fixed budget would truncate a perfectly good answer — but a stream that has
// gone quiet is dead and has to be given up on. BRAIN_TIMEOUT_MS is left at its
// generous default throughout, so anything that reads it instead of the voice
// budget hangs here rather than passing.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-voice-timeout-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let deltas = [];
let perDeltaMs = 8;
// After this many deltas the stub stops writing but holds the connection open,
// which is what a wedged provider looks like from here: not an error, not an
// end, just nothing.
let silentAfter = Infinity;
// A request that is never answered at all, for the non-streaming path.
let answerJson = true;

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const parsed = JSON.parse(body || '{}');

    if (!parsed.stream) {
      if (!answerJson) return; // hold it open and say nothing
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: deltas.join('') } }] }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (let i = 0; i < deltas.length; i++) {
      if (res.writableEnded || i >= silentAfter) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: deltas[i] } }] })}\n\n`);
      await sleep(perDeltaMs);
    }
    if (res.writableEnded) return;
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
upstream.listen(0);
await new Promise((r) => upstream.once('listening', r));

process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.BRAIN_BASE = `http://127.0.0.1:${upstream.address().port}/v1`;
process.env.BRAIN_KEY = 'stub';
// The generic ceiling, deliberately left long: every assertion below is about
// the voice budget being consulted instead of this one.
process.env.BRAIN_TIMEOUT_MS = '120000';
process.env.VOICE_BRAIN_TIMEOUT_MS = '300';
// Long enough to stay out of the way. What is being measured here is the
// upstream budget, not the deadline that decides between the model and the
// rules script — that one has its own tests.
process.env.VOICE_FIRST_SENTENCE_MS = '2000';

const { createApp } = await import('../src/app.js');
const { clearVoiceCache } = await import('../src/lib/voiceBrief.js');
const { resolveIntent } = await import('../src/lib/intent.js');

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  upstream.closeAllConnections?.();
  upstream.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function streamBrief(body) {
  const started = Date.now();
  const res = await fetch(`${base}/api/voice/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  });

  const events = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      const payload = buf.slice(0, cut).replace(/^data:\s?/, '').trim();
      buf = buf.slice(cut + 2);
      if (payload) events.push({ ...JSON.parse(payload), at: Date.now() - started });
    }
  }
  return events;
}

// Written analysis, which is what the voice path exists to rewrite. No verdict
// line on purpose: a verdict would put a lead sentence out ahead of the model
// and drop the model's own opener, which is behaviour tested elsewhere and only
// obscures the timing being pinned here.
const WRITTEN =
  'Momentum is constructive with price 12.4531% above the 200-day average [1], ' +
  'though the multiple has expanded alongside it.';

test('a model that keeps writing is never cut off, however long it takes', { timeout: 5000 }, async () => {
  clearVoiceCache();
  silentAfter = Infinity;
  perDeltaMs = 90; // no single gap reaches the 300ms budget
  deltas = [
    'Momentum is ',
    'the reason here. ',
    'Price sits well ',
    'above the average. ',
    'Valuation is ',
    'the caveat.',
  ];

  const events = await streamBrief({ text: WRITTEN });
  const done = events.at(-1);

  // Six deltas at 90ms apart is comfortably past the budget in total. A timeout
  // on the call rather than on the silence would truncate this brief; the whole
  // point of re-arming per chunk is that it does not.
  assert.ok(done.at > 300, `the stream ran ${done.at}ms, which has to exceed the 300ms budget`);
  assert.equal(done.source, 'model');
  assert.deepEqual(
    events.filter((e) => e.type === 'sentence').map((e) => e.script),
    ['Momentum is the reason here.', 'Price sits well above the average.', 'Valuation is the caveat.'],
  );
});

test('a stream that goes quiet mid-brief is given up on', { timeout: 5000 }, async () => {
  clearVoiceCache();
  perDeltaMs = 20;
  silentAfter = 2; // two deltas, then nothing, and the connection stays open
  deltas = [
    'Momentum is the reason here. ',
    'Valuation is the caveat. ',
    'This third sentence is never sent.',
  ];

  const events = await streamBrief({ text: WRITTEN });
  const done = events.at(-1);

  // What was already said stands. Appending the rules script now would repeat
  // it, so the brief stops where it is.
  assert.deepEqual(
    events.filter((e) => e.type === 'sentence').map((e) => e.script),
    ['Momentum is the reason here.', 'Valuation is the caveat.'],
  );
  assert.equal(done.type, 'done');
  assert.equal(done.source, 'model-partial');
  assert.equal(events.filter((e) => e.type === 'fallback').length, 0);

  // Promptly, rather than at the generic two-minute ceiling.
  assert.ok(done.at < 1500, `gave up after ${done.at}ms`);
});

test('intent falls back to what was said when the model does not answer', { timeout: 5000 }, async () => {
  answerJson = false;
  const started = Date.now();

  // Neither a working command nor anything the fast path can place, so it is
  // the model or nothing.
  const res = await resolveIntent('what is going on with data center demand');
  const took = Date.now() - started;

  assert.equal(res.command, 'what is going on with data center demand');
  assert.equal(res.rewritten, false);
  assert.equal(res.source, 'error');
  assert.ok(took < 2000, `waited ${took}ms on a model that was never going to answer`);

  answerJson = true;
});
