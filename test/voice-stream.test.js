// The streaming spoken brief, against a stub upstream that streams the way a
// provider does — a token at a time, on the wire, with real gaps between them.
//
// What is under test is the timing contract as much as the content: the first
// sentence has to reach the caller while the model is still writing the last
// one. A test that only checked the assembled script would pass just as well
// against the blocking implementation this replaced.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-voice-stream-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What the stub says, and how slowly. Deltas are split mid-sentence on purpose:
// a provider has no idea where sentences end, and neither does the transport.
let deltas = [];
let firstDelayMs = 0;
let perDeltaMs = 8;
let aborted = false;
const seen = [];

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const parsed = JSON.parse(body || '{}');
    seen.push(parsed);

    if (!parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: deltas.join('') } }] }));
      return;
    }

    res.on('close', () => {
      if (!res.writableEnded) aborted = true;
    });

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    await sleep(firstDelayMs);
    for (const delta of deltas) {
      if (res.writableEnded || aborted) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
      await sleep(perDeltaMs);
    }
    if (res.writableEnded || aborted) return;
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
process.env.BRAIN_KEY = 'test-key-should-not-leak';
process.env.BRAIN_MODEL = 'stub-model';
// Short enough to prove the deadline exists without making the suite wait on it.
process.env.VOICE_FIRST_SENTENCE_MS = '400';

const { createApp } = await import('../src/app.js');
const { clearVoiceCache } = await import('../src/lib/voiceBrief.js');

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  upstream.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** Read the SSE response, stamping each event with when it actually arrived. */
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
  return { status: res.status, type: res.headers.get('content-type') || '', events };
}

const scripts = (events, type) =>
  events.filter((e) => (type ? e.type === type : e.type !== 'done')).map((e) => e.script);

test('sentences are delivered as they are written, not once the brief is finished', async () => {
  clearVoiceCache();
  aborted = false;
  firstDelayMs = 0;
  perDeltaMs = 40;
  deltas = [
    'Momentum is ',
    'constructive here. ',
    'Price sits about 12.4531% ',
    'above the 200-day average. ',
    'The caveat is valuation.',
  ];

  const res = await streamBrief({ text: 'A written passage with 12.3456% in it and [1] a citation.' });

  assert.equal(res.status, 200);
  assert.match(res.type, /^text\/event-stream/);

  const sentences = res.events.filter((e) => e.type === 'sentence');
  assert.equal(sentences.length, 3, 'one event per sentence, not one per delta');
  assert.match(sentences[0].script, /^Momentum is constructive here\.$/);
  assert.match(sentences[2].script, /valuation/);

  // The whole point: the first sentence is out well before the last one is
  // even written. Against a blocking implementation these would be equal.
  const done = res.events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.source, 'model');
  assert.ok(
    sentences[0].at < done.at - 40,
    `first sentence at ${sentences[0].at}ms should precede completion at ${done.at}ms`,
  );

  // Per-sentence shaping matches what the whole-script path would have done.
  assert.match(sentences[1].script, /12\.5 percent/);
  assert.doesNotMatch(JSON.stringify(res.events), /12\.4531/);
});

test('a verdict is spoken at once, and the model does not say it twice', async () => {
  clearVoiceCache();
  aborted = false;
  firstDelayMs = 250; // the model is thinking; the lead must not wait for it
  perDeltaMs = 8;
  deltas = [
    'Nvidia still screens as a buy. ',
    'Momentum is the reason. ',
    'Valuation is the caveat.',
  ];

  const res = await streamBrief({
    text:
      '## NVDA\n| Metric | Value |\n|---|---|\n| Last | $142.6234 |\n\n' +
      'Momentum is constructive with price 12.4531% above the 200-day average [1].\n' +
      '**VERDICT:** BUY (M)',
    title: 'NVDA dossier',
  });

  const first = res.events[0];
  assert.equal(first.type, 'lead');
  assert.match(first.script, /The call is buy, medium conviction\./);
  assert.ok(first.at < 200, `the lead waited ${first.at}ms on a model that took 250ms to start`);

  // The model's own opener is dropped, because the lead already made that
  // claim. What survives is the reasoning, which is what was missing.
  const sentences = res.events.filter((e) => e.type === 'sentence');
  assert.deepEqual(scripts(sentences), ['Momentum is the reason.', 'Valuation is the caveat.']);
  assert.doesNotMatch(JSON.stringify(sentences), /screens as a buy/);

  // Nothing is said twice, and nothing arrives after the brief is complete.
  assert.equal(res.events.filter((e) => e.type === 'fallback').length, 0);
  assert.equal(res.events.at(-1).type, 'done');
});

test('a model too slow to start is not waited on in silence', async () => {
  clearVoiceCache();
  aborted = false;
  firstDelayMs = 1500; // well past VOICE_FIRST_SENTENCE_MS
  perDeltaMs = 8;
  deltas = ['This answer arrives far too late to be spoken.'];

  const res = await streamBrief({
    text: 'Momentum is constructive with price 12.4531% above the 200-day average [1].',
  });

  const fallback = res.events.find((e) => e.type === 'fallback');
  assert.ok(fallback, 'the rules script stands in rather than leaving dead air');
  assert.equal(fallback.source, 'rules-timeout');
  assert.match(fallback.script, /12\.5 percent/);
  assert.ok(fallback.at < 1200, `fell back after ${fallback.at}ms, not after the model finished`);

  // The guarantee the client depends on: a fallback never follows a sentence,
  // so nothing can be spoken twice.
  assert.equal(res.events.filter((e) => e.type === 'sentence').length, 0);
  assert.equal(res.events.at(-1).source, 'rules-timeout');

  // And the model was told to stop rather than left generating for nobody.
  await sleep(120);
  assert.equal(aborted, true);
});

test('the upstream key never travels back to the caller', async () => {
  clearVoiceCache();
  aborted = false;
  firstDelayMs = 0;
  deltas = ['A perfectly ordinary spoken brief about the position.'];

  const res = await streamBrief({ text: 'A long written passage with 12.3456% and [1] a citation.' });
  assert.doesNotMatch(JSON.stringify(res.events), /test-key-should-not-leak/);
  assert.equal(seen.at(-1).stream, true, 'the stream is asked for upstream, not faked locally');
});

test('a caller that does not ask for a stream still gets the whole script', async () => {
  clearVoiceCache();
  aborted = false;
  firstDelayMs = 0;
  deltas = ['The position is unchanged. Nothing here needs acting on today.'];

  const res = await fetch(`${base}/api/voice/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'A written passage with 12.3456% and [1] a citation.' }),
  });

  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.source, 'model');
  assert.match(json.script, /The position is unchanged/);
  assert.equal(seen.at(-1).stream, undefined, 'the blocking path does not ask for a stream');
});

test('text is still required, streaming or not', async () => {
  const res = await fetch(`${base}/api/voice/brief`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '   ', stream: true }),
  });
  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
});
