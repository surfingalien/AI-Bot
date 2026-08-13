// The desk is authored outside this repo and re-uploaded whole, so these tests
// pin the contract between it and the server: the anchors the injector needs,
// and the endpoints the engine calls by hand.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
const panel = fs.readFileSync(path.resolve('public/desk-server.js'), 'utf8');

test('the desk still exposes the engine block the injector targets', () => {
  const anchor = '<script type="text/plain" id="engineSrc">';
  assert.equal(html.split(anchor).length - 1, 1, 'expected exactly one engine block');
});

test('the desk calls every endpoint the server implements', () => {
  for (const route of [
    '/api/fetch?url=',
    '/api/yahoo/chart/',
    '/api/yahoo/quote/',
    '/api/notify',
    '/chat/completions',
    '/embeddings',
  ]) {
    assert.ok(html.includes(route), `desk should call ${route}`);
  }
});

test('the desk reads its configuration from the localStorage keys we seed', () => {
  for (const key of ["'sa_'", 'dataBase', 'base', 'model', 'brain']) {
    assert.ok(html.includes(key), `expected storage contract: ${key}`);
  }
});

test('the panel keeps its own namespace and never touches engine internals', () => {
  // Every class it injects is prefixed, so it cannot collide with the desk's.
  const classes = [...panel.matchAll(/'\.([a-z][a-z0-9-]*)\{/g)].map((m) => m[1]);
  assert.ok(classes.length > 10, 'expected the panel to define styles');
  for (const cls of classes) {
    assert.ok(cls.startsWith('sasrv-'), `unprefixed class would leak into the desk: .${cls}`);
  }
});

test('the panel talks to the server only through documented endpoints', () => {
  const calls = [...panel.matchAll(/api\('(\/[^']+)'/g)].map((m) => m[1].split('?')[0]);
  const allowed = new Set([
    '/api/config',
    '/api/autonomy',
    '/api/autonomy/activity',
    '/api/autonomy/goals',
    '/api/genome',
    '/api/voice/brief',
    '/api/voice/speak',
    '/api/voice/transcribe',
    '/api/intent',
    '/api/diagnostics',
  ]);
  for (const call of calls) {
    const base = call.replace(/\/api\/autonomy\/goals\/.*$/, '/api/autonomy/goals');
    assert.ok(allowed.has(base), `undocumented endpoint: ${call}`);
  }
});

test('the panel stays inert when the server does not answer', () => {
  const boot = panel.slice(panel.indexOf('function boot()'));
  // Nothing mounts unless /api/config confirms a server, and a failed probe is
  // swallowed rather than logged at the operator.
  assert.match(boot, /if \(res\.status !== 200 \|\| !res\.json \|\| !res\.json\.ok\) return;/);
  assert.ok(boot.indexOf('return;') < boot.indexOf('mount('), 'mount sits behind the check');
  assert.match(boot, /\.catch\(function \(\) \{\}\)/);

  // Both patches install synchronously — the desk captures the recognition
  // constructor at boot, so a patch waiting on the config round trip would
  // lose the race. They stay dormant via serverReady instead.
  assert.ok(boot.indexOf('installVoice()') > 0 && boot.indexOf('installIntent()') > 0);
  assert.ok(
    boot.indexOf('installVoice()') < boot.indexOf("addEventListener('DOMContentLoaded', boot)"),
    'patches install before the engine runs',
  );
  assert.match(panel, /if \(!serverReady \|\| voiceMode === 'verbatim' \|\| !text\)/);
  assert.match(panel, /if \(!serverReady \|\| !intentMode \|\| !said\)/);
});

test('speech interception restores the desk behaviour when the rewrite fails', () => {
  // A server that goes away mid-session must not leave the desk mute.
  assert.match(panel, /voiceMode === 'verbatim' \|\| !text\) return original\(utterance\)/);
  assert.match(panel, /emit\(text, 'raw'\)/);
  // Stale rewrites are dropped rather than spoken after a newer answer.
  assert.match(panel, /if \(ticket !== speakSeq \|\| !script\) return;/);
});

test('the brief is spoken as it streams, not once it is finished', () => {
  // The request has to ask for a stream, and has to be able to read one.
  assert.match(panel, /stream: true/);
  assert.match(panel, /Accept: 'text\/event-stream'/);
  assert.match(panel, /r\.body\.getReader\(\)/);

  // Frames are only parsed once whole: an SSE frame ends at a blank line, and
  // a network chunk lands wherever it lands.
  assert.match(panel, /buf\.indexOf\('\\n\\n'\)/);

  // Every speakable event reaches synthesis, and each one is spoken on its own
  // rather than accumulated — that is the whole point of streaming.
  assert.match(panel, /ev\.type === 'lead' \|\| ev\.type === 'sentence' \|\| ev\.type === 'fallback'/);

  // A server that cannot stream still answers with the whole script, and that
  // is what the client falls back to rather than going mute.
  assert.match(panel, /return r\.json\(\)\.then/);
  assert.match(panel, /text\/event-stream'\) === 0/);

  // Abandoning the read is what tells the server to stop generating.
  assert.match(panel, /reader\.cancel\(\)/);
});

test('a correct utterance is actually got as far as a speaker', () => {
  // Everything upstream can be right and still make no sound. These are the
  // three ways a browser swallows speech, none of which the code that asked
  // for it can see.
  assert.match(panel, /function whenVoicesReady\(run\)/, 'voices load asynchronously');
  assert.match(panel, /voiceschanged/);
  assert.match(panel, /if \(window\.speechSynthesis\.paused\) window\.speechSynthesis\.resume\(\)/);
  assert.match(panel, /speaking\.push\(u\)/, 'a reference, so it cannot be collected mid-sentence');

  // The wait is bounded: a browser with no voices never fires voiceschanged,
  // and hanging on that would be a worse failure than speaking into a void.
  assert.match(panel, /setTimeout\(go, VOICES_WAIT_MS\)/);

  // And the failure is recorded rather than swallowed, because "it is silent"
  // is a symptom and not a diagnosis.
  assert.match(panel, /u\.onerror = release/);
  assert.match(panel, /lastSpeechError = String\(ev\.error\)/);
});

test('the panel says why it is not talking, not just that it is not', () => {
  const status = panel.slice(panel.indexOf('function voiceStatus()'), panel.indexOf('function renderVoice()'));
  // Four different causes, only one of which is fixable here — and the old
  // line blamed the one switch for all of them.
  assert.match(status, /no speech synthesis/);
  assert.match(status, /No voices are installed/);
  assert.match(status, /refused the last thing/);
  assert.match(status, /SPEAK is on in its settings/);
});

test('one launcher opens either panel, and neither takes the desk away', () => {
  assert.match(panel, /function buildMenu\(\)/);
  assert.match(panel, /function deskDrawer\(want\)/);

  // The desk's own drawer is opened by its class, because the function that
  // opens it is closure-scoped inside the engine and unreachable from here.
  assert.match(panel, /document\.getElementById\('drawer'\)/);
  assert.match(panel, /d\.classList\.toggle\('open', next\)/);

  // Opening the server panel must not close that drawer: the composer lives
  // inside it, so closing it to make room takes the input away.
  const toggle = panel.slice(panel.indexOf('function toggle()'), panel.indexOf('function deskDrawer'));
  assert.doesNotMatch(toggle, /deskDrawer\(false\)/);
});

test('the desk works out what was meant while it is still being said', () => {
  // Speculation is only safe because /api/intent answers a question rather
  // than running anything, and because a guess about the wrong words is
  // discarded rather than run.
  assert.match(panel, /function speculate\(\)/);
  assert.match(panel, /settle = setTimeout\(speculate, SETTLE_MS\)/);

  // The moment speech stops is earlier than any settle timer can be, and a
  // short utterance may end before the timer ever fires.
  assert.match(panel, /rec\.addEventListener\('speechend', function \(\) \{/);
  assert.match(panel, /early && sameWords\(early\.key, said\) \? early\.answer : askIntent\(said\)/);

  // Bounded: a guess costs a request, and one of them can be a model call.
  assert.match(panel, /guesses >= MAX_GUESSES/);

  // A new utterance starts with no inherited guess, and the pending timer
  // cannot fire into the next one.
  const wrapped = panel.slice(panel.indexOf('function Wrapped()'));
  assert.match(wrapped, /clearTimeout\(settle\);\s*\n\s*guess = null;/);
});

test('the desk stops talking when the operator starts', () => {
  // Barge-in: both the mic opening and speech actually starting cancel what is
  // queued, and both void the brief still in flight so it cannot arrive later.
  assert.match(panel, /function bargeIn\(\)/);
  assert.match(panel, /window\.speechSynthesis\.cancel\(\)/);
  assert.match(panel, /rec\.addEventListener\('start', bargeIn\)/);
  assert.match(panel, /rec\.addEventListener\('speechstart', bargeIn\)/);

  const barge = panel.slice(panel.indexOf('function bargeIn()'));
  assert.ok(
    barge.indexOf('speakSeq++') < barge.indexOf('speechSynthesis.cancel()'),
    'the ticket is claimed before the queue is cleared, so nothing slips in between',
  );
});
