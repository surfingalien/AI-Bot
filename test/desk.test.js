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
    '/api/intent',
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
  assert.match(panel, /speakScript\(text, utterance, original, 'raw'\)/);
  // Stale rewrites are dropped rather than spoken after a newer answer.
  assert.match(panel, /if \(ticket !== speakSeq\) return;/);
});
