// The acknowledgement is the one line that has to appear instantly, so it is
// built from the utterance alone — no fetch, no model, nothing that can be slow
// or wrong. These run the injected source in a fake engine scope and call the
// functions directly, which is the only way to assert them without a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(process.cwd(), 'src/desk/engine-extensions.js'), 'utf8');

function loadInFakeEngine({ name = 'Operator', dataBase = '', fetch = () => new Promise(() => {}) } = {}) {
  const win = {};
  const turns = [];
  const spoken = [];
  const run = new Function(
    'TOOLS',
    'TOOL_BY_NAME',
    'TOOL_SCHEMAS',
    'S',
    'window',
    'openLiveTurn',
    'pushTurn',
    'speak',
    'fetch',
    source,
  );
  run(
    [],
    {},
    [],
    { name, dataBase },
    win,
    undefined,
    (t) => turns.push(t),
    (t) => spoken.push(t),
    fetch,
  );
  return { ext: win.__saExt, turns, spoken, win };
}

const { ext } = loadInFakeEngine();
const { acknowledge, wakeLine } = ext;

test('a URL is acknowledged by its host, not its query string', () => {
  assert.equal(acknowledge('what do you make of https://www.reuters.com/markets/x?y=1'), 'Reading reuters.com…');
  assert.equal(acknowledge('http://example.co.uk/a/b'), 'Reading example.co.uk…');
});

test('common intents are named specifically', () => {
  assert.match(acknowledge('book a table at Nobu'), /booking/i);
  assert.match(acknowledge('how is my portfolio doing'), /positions/i);
  assert.match(acknowledge('show me the scorecard'), /record/i);
  assert.match(acknowledge('backtest NVDA momentum'), /backtest/i);
  assert.match(acknowledge('remember the board meets first Mondays'), /writing/i);
});

test('a bare ticker is named back', () => {
  assert.equal(acknowledge('NVDA'), 'Pulling NVDA…');
  assert.equal(acknowledge('full equity dossier on AAPL'), 'Pulling AAPL…');
});

test('capitalised English is not mistaken for a ticker', () => {
  // "Pulling THE…" would be worse than saying nothing specific at all.
  for (const utterance of ['THE market today', 'HOW does this work', 'WHY is it down']) {
    assert.doesNotMatch(acknowledge(utterance), /^Pulling/, utterance);
  }
});

test('anything else still gets a real sentence', () => {
  assert.equal(acknowledge('what should I do about the meeting?'), 'Thinking about that…');
  assert.equal(acknowledge('hello'), 'On it…');
  assert.equal(acknowledge(''), 'One moment.');
  assert.equal(acknowledge(null), 'One moment.');
});

test('it never touches the network', () => {
  // The whole point: a function that cannot be slow, because it cannot wait on
  // anything. Loading with a fetch that throws proves nothing calls it.
  const win = {};
  const run = new Function(
    'TOOLS',
    'TOOL_BY_NAME',
    'TOOL_SCHEMAS',
    'S',
    'window',
    'openLiveTurn',
    'pushTurn',
    'speak',
    'fetch',
    source,
  );
  run([], {}, [], { name: 'X', dataBase: '' }, win, undefined, () => {}, () => {}, () => {
    throw new Error('acknowledge must not fetch');
  });
  assert.equal(win.__saExt.acknowledge('NVDA'), 'Pulling NVDA…');
});

test('the wake line reports what happened while the tab was shut', () => {
  const now = Date.now();
  const line = wakeLine(
    { goals: [{ enabled: true }, { enabled: true }, { enabled: false }] },
    { activity: [{ t: now - 60000, label: 'scan watchlist: 3 symbols' }] },
  );
  assert.match(line, /^Good (morning|afternoon|evening), Operator\./);
  assert.match(line, /2 goals armed/, 'disabled goals are not armed');
  assert.match(line, /1 thing fired/);
  assert.match(line, /scan watchlist/);
});

test('a quiet night says so rather than saying nothing', () => {
  const line = wakeLine({ goals: [{ enabled: true }] }, { activity: [] });
  assert.match(line, /1 goal armed/, 'singular');
  assert.match(line, /Nothing fired/);
});

test('stale activity is not reported as news', () => {
  const old = Date.now() - 40 * 3600 * 1000;
  const line = wakeLine({ goals: [{ enabled: true }] }, { activity: [{ t: old, label: 'ancient' }] });
  assert.doesNotMatch(line, /ancient/);
  assert.match(line, /Nothing fired/);
});

test('with no goals armed it does not claim a quiet night', () => {
  const line = wakeLine({ goals: [] }, { activity: [] });
  assert.match(line, /No goals armed/);
  assert.doesNotMatch(line, /Nothing fired/, 'nothing could have fired — that is not news');
});

test('an unreachable server is said out loud, not answered for', () => {
  // "No goals armed" here would be an answer invented out of a call that
  // failed, and the greeting exists precisely to report what the browser
  // cannot know on its own.
  const line = wakeLine(null, null);
  assert.match(line, /^Good (morning|afternoon|evening), Operator\./);
  assert.match(line, /cannot reach the server/i);
  assert.doesNotMatch(line, /goals armed/);
});

test('the desk greets even when it has no server to ask', async () => {
  // The greeting used to require a configured proxy and a 200 back, and
  // swallowed every reason it got neither — so on a desk that had either
  // problem it simply never happened, silently.
  const { ext, turns, spoken } = loadInFakeEngine({ dataBase: '' });
  ext.wake();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(turns.length, 1, 'the greeting happens regardless');
  assert.equal(turns[0].user, '(waking up)');
  assert.match(turns[0].text, /^Good (morning|afternoon|evening), Operator\./);
  assert.deepEqual(spoken, [turns[0].text], 'and is spoken, not only written');
  assert.match(ext.wakeError(), /no DATA PROXY/, 'the reason is recoverable rather than swallowed');
});

test('a server that never answers does not hold the greeting hostage', async () => {
  // A status call that hangs used to mean no greeting at all. It now costs the
  // news, not the greeting.
  const { ext, turns } = loadInFakeEngine({
    dataBase: 'http://desk.invalid',
    fetch: () => new Promise(() => {}), // never settles
  });
  const started = Date.now();
  ext.wake();
  await new Promise((r) => setTimeout(r, 1600));

  assert.equal(turns.length, 1, 'greeted anyway');
  assert.match(turns[0].text, /cannot reach the server/i);
  assert.ok(Date.now() - started < 2500, 'and did not wait out the request');
});

test('a server that answers in time is quoted rather than guessed at', async () => {
  const body = {
    '/api/autonomy': { goals: [{ enabled: true }] },
    '/api/autonomy/activity': { activity: [] },
  };
  const { ext, turns } = loadInFakeEngine({
    dataBase: 'http://desk.test',
    fetch: (url) => {
      const key = Object.keys(body).find((k) => url.includes(k));
      return Promise.resolve({ status: 200, json: () => Promise.resolve(body[key]) });
    },
  });
  ext.wake();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(turns.length, 1);
  assert.match(turns[0].text, /1 goal armed/);
  assert.doesNotMatch(turns[0].text, /cannot reach/);
});
