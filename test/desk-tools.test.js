// The server's tools are spliced into the desk engine's own source. A syntax
// error there does not fail loudly in one place — it takes the whole desk down
// with a fatal banner, because the engine is one `new Function(src)`. So the
// injection is checked structurally, and the injected source is checked by
// actually parsing it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-desk-tools-'));
process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';

const { renderIndex } = await import('../src/ui.js');

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const html = renderIndex();
const ENGINE_TAG = '<script type="text/plain" id="engineSrc">';

test('the tools land inside the engine block, not after it', () => {
  const open = html.indexOf(ENGINE_TAG);
  const close = html.indexOf('</script>', open + ENGINE_TAG.length);
  const marker = html.indexOf('server tools, appended into the engine scope');
  assert.ok(open > -1 && close > -1);
  assert.ok(marker > open && marker < close, 'outside the block it would run in the wrong scope');
});

test('the engine source still parses as one function body', () => {
  const open = html.indexOf(ENGINE_TAG) + ENGINE_TAG.length;
  const source = html.slice(open, html.indexOf('</script>', open));
  // Exactly what the desk does at boot. A throw here is a fatal banner there.
  assert.doesNotThrow(() => new Function(source));
});

test('both tools are registered', () => {
  assert.match(html, /name: 'book_restaurant'/);
  assert.match(html, /name: 'call_status'/);
});

test('registration is skipped when the desk already ships the tool', () => {
  // The guard is what makes a newer index.html safe to drop in.
  assert.match(html, /if \(TOOL_BY_NAME\[tool\.name\]\) return;/);
});

test('the bootstrap still runs ahead of the engine', () => {
  assert.ok(html.indexOf('seeds first-run defaults only') < html.indexOf(ENGINE_TAG));
});

test('the desk file itself is untouched on disk', () => {
  const raw = fs.readFileSync(path.resolve(process.cwd(), 'public/index.html'), 'utf8');
  assert.ok(!raw.includes('book_restaurant'), 'the authored build must stay as authored');
});

test('an unrecognised build is served rather than guessed at', async () => {
  // No engine block: the splice has nothing to anchor to and must not corrupt
  // whatever the operator actually put there.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-odd-desk-'));
  fs.mkdirSync(path.join(dir, 'public'));
  fs.mkdirSync(path.join(dir, 'src', 'desk'), { recursive: true });
  fs.copyFileSync('src/desk/engine-extensions.js', path.join(dir, 'src/desk/engine-extensions.js'));
  const odd = '<!doctype html><title>something else</title><body>hi</body>';
  fs.writeFileSync(path.join(dir, 'public/index.html'), odd);

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const fresh = await import(`../src/ui.js?odd=${Date.now()}`);
    assert.equal(fresh.renderIndex(), odd);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
