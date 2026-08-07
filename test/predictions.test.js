// The prediction ledger and its scoring. The rules that matter are the honest
// ones — resolve at the exact horizon, do not count a call whose entry never
// filled, and measure against a benchmark — so those are what is pinned here.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAY = 86400000;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pred-'));
const ledger = path.join(stateDir, 'predictions.jsonl');

// A price path per symbol, indexed by days back from today, so a test can say
// "this symbol rose 10% over the next week" precisely.
const paths = {};
function makePath(fn) {
  return Array.from({ length: 400 }, (_, i) => fn(i));
}

const upstream = http.createServer((req, res) => {
  const sym = decodeURIComponent((req.url.match(/chart\/([^?]+)/) || [])[1] || '');
  const series = paths[sym];
  if (!series) {
    res.writeHead(404).end('{}');
    return;
  }
  const todayMs = Date.now();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      chart: {
        result: [
          {
            meta: { symbol: sym },
            // Oldest first, one bar per day, last bar = today.
            timestamp: series.map((_, i) => Math.floor((todayMs - (series.length - 1 - i) * DAY) / 1000)),
            indicators: {
              quote: [
                {
                  close: series,
                  high: series.map((c) => c * 1.02),
                  low: series.map((c) => c * 0.98),
                },
              ],
            },
          },
        ],
      },
    }),
  );
});
upstream.listen(0);
await new Promise((r) => upstream.once('listening', r));

process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.PREDICTIONS_FILE = ledger;
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.ALLOW_PRIVATE_EGRESS = 'true';
process.env.YAHOO_BASE = `http://127.0.0.1:${upstream.address().port}`;
process.env.MARKET_CACHE_MS = '0';

const preds = await import('../src/lib/predictions.js');
const { clearMarketCache } = await import('../src/market/yahoo.js');
const { createApp } = await import('../src/app.js');

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  upstream.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function reset() {
  fs.rmSync(ledger, { force: true });
  clearMarketCache();
}

// Writes a record dated in the past, the way one logged N days ago would look.
function logAged(entry, daysAgo) {
  preds.logPrediction(entry);
  const rows = preds.readPredictions();
  rows[rows.length - 1].generatedAt = new Date(Date.now() - daysAgo * DAY).toISOString();
  fs.writeFileSync(ledger, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rows[rows.length - 1];
}

test('nearestClose only answers when a bar is actually near the date', () => {
  const bars = [
    { t: 1000 * DAY, c: 10 },
    { t: 1005 * DAY, c: 20 },
  ];
  assert.equal(preds.nearestClose(bars, 1005 * DAY), 20);
  assert.equal(preds.nearestClose(bars, 1004 * DAY), 20, 'within tolerance');
  assert.equal(preds.nearestClose(bars, 1050 * DAY), null, 'far past any bar');
  assert.equal(preds.nearestClose([], 1000 * DAY), null);
});

test('zoneTouched distinguishes "never filled" from "cannot tell"', () => {
  const bars = [
    { t: 10 * DAY, c: 100, h: 101, l: 99 },
    { t: 11 * DAY, c: 105, h: 106, l: 104 },
  ];
  assert.equal(preds.zoneTouched(bars, 10 * DAY, 12 * DAY, 99, 101), true);
  assert.equal(preds.zoneTouched(bars, 10 * DAY, 12 * DAY, 50, 60), false, 'bars existed, never reached');
  assert.equal(preds.zoneTouched(bars, 900 * DAY, 901 * DAY, 99, 101), null, 'no bars to judge by');
  assert.equal(preds.zoneTouched(bars, 10 * DAY, 12 * DAY, null, null), null, 'no zone recorded');
});

test('a call is resolved against the bar at the exact horizon', async () => {
  reset();
  // Flat until 7 days ago, then +10% in the final week.
  paths.NVDA = makePath((i) => (i < 393 ? 100 : 100 + (i - 392) * 1.4));
  paths.SPY = makePath(() => 400);

  logAged(
    {
      symbol: 'NVDA',
      label: 'BUY',
      conviction: 'H',
      basePrice: 100,
      entryLow: 99,
      entryHigh: 101,
    },
    7,
  );

  const { resolved } = await preds.resolveOutcomes();
  assert.ok(resolved >= 1);

  const record = preds.readPredictions()[0];
  assert.ok(record.price7d > 105, `resolved to the +7d bar, got ${record.price7d}`);
  assert.ok(record.ret7d > 5);
  assert.equal(record.entered, true, 'price sat inside the entry zone at the start');
  assert.equal(record.benchRet7d, 0, 'benchmark went nowhere over the same window');
});

test('a call whose entry never filled is excluded from the win rate', async () => {
  reset();
  // Rises the whole way — a great symbol, but the entry was never reachable.
  paths.AAPL = makePath((i) => 100 + i * 0.5);
  paths.SPY = makePath(() => 400);

  logAged(
    {
      symbol: 'AAPL',
      label: 'BUY',
      conviction: 'H',
      basePrice: 100,
      // A zone far below anything the price traded at in the window.
      entryLow: 10,
      entryHigh: 12,
    },
    30,
  );

  await preds.resolveOutcomes();
  const record = preds.readPredictions()[0];
  assert.equal(record.entered, false, 'the entry zone was never touched');
  assert.ok(record.ret30d > 0, 'the symbol still rose');

  const card = preds.scorecard({ horizon: 30 });
  assert.equal(card.resolved, 1);
  assert.equal(card.tradeable, 0, 'an unfilled call cannot count as a win');
  assert.equal(card.winRate, null);
  assert.equal(card.fillRate, 0);
});

test('a SELL that fell counts as a win, not a loss', async () => {
  reset();
  paths.TSLA = makePath((i) => (i < 370 ? 100 : 100 - (i - 369) * 0.5));
  paths.SPY = makePath(() => 400);

  logAged(
    { symbol: 'TSLA', label: 'SELL', conviction: 'M', basePrice: 100, entryLow: 99, entryHigh: 101 },
    30,
  );

  await preds.resolveOutcomes();
  const record = preds.readPredictions()[0];
  assert.ok(record.ret30d < 0, 'price fell');

  const card = preds.scorecard({ horizon: 30 });
  assert.equal(card.winRate, 1, 'direction is respected rather than assuming every call is long');
  assert.equal(card.byLabel.SELL.n, 1);
});

test('beating the benchmark is measured, not assumed', async () => {
  reset();
  // Up 4% while the benchmark is up 10%: a gain, but not alpha.
  paths.MSFT = makePath((i) => (i < 370 ? 100 : 100 + (i - 369) * 0.13));
  paths.SPY = makePath((i) => (i < 370 ? 400 : 400 + (i - 369) * 1.34));

  logAged(
    { symbol: 'MSFT', label: 'BUY', conviction: 'H', basePrice: 100, entryLow: 99, entryHigh: 101 },
    30,
  );

  await preds.resolveOutcomes();
  const card = preds.scorecard({ horizon: 30 });

  assert.equal(card.winRate, 1, 'the position made money');
  assert.equal(card.alphaWinRate, 0, 'but it lagged the benchmark');
  assert.ok(card.avgBenchmark > card.avgReturn);
});

test('calibration reports whether conviction carries information', async () => {
  reset();
  paths.WINR = makePath((i) => (i < 370 ? 100 : 100 + (i - 369) * 0.4));
  paths.LOSR = makePath((i) => (i < 370 ? 100 : 100 - (i - 369) * 0.4));
  paths.SPY = makePath(() => 400);

  // High conviction on the one that fell, low on the one that rose: the
  // conviction letter is carrying no information, and the card should say so.
  logAged(
    { symbol: 'LOSR', label: 'BUY', conviction: 'H', basePrice: 100, entryLow: 99, entryHigh: 101 },
    30,
  );
  logAged(
    { symbol: 'WINR', label: 'BUY', conviction: 'L', basePrice: 100, entryLow: 99, entryHigh: 101 },
    30,
  );

  await preds.resolveOutcomes();
  const card = preds.scorecard({ horizon: 30 });

  assert.equal(card.calibration.H.winRate, 0);
  assert.equal(card.calibration.L.winRate, 1);
  assert.equal(card.calibrated, false);
  assert.match(preds.scorecardMarkdown(card), /not carrying information/);
});

test('a call too young to judge is left pending rather than guessed at', async () => {
  reset();
  paths.NVDA = makePath(() => 100);
  paths.SPY = makePath(() => 400);
  logAged({ symbol: 'NVDA', label: 'BUY', conviction: 'M', basePrice: 100 }, 2);

  const { resolved } = await preds.resolveOutcomes();
  assert.equal(resolved, 0);

  const card = preds.scorecard();
  assert.equal(card.logged, 1);
  assert.equal(card.resolved, 0);
  assert.equal(card.pending, 1);
  assert.match(preds.scorecardMarkdown(card), /Nothing has aged into a resolution yet/);
});

test('the ledger is append-only JSONL a human can read back', async () => {
  reset();
  preds.logPrediction({ symbol: 'nvda', label: 'buy', conviction: 'h', basePrice: 100 });
  preds.logPrediction({ symbol: 'AAPL', label: 'SELL', conviction: 'L', basePrice: 220 });

  const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.symbol, 'NVDA', 'symbols normalised on the way in');
  assert.equal(first.label, 'BUY');
  assert.equal(first.conviction, 'H');
  assert.ok(first.id && first.generatedAt);

  assert.equal(preds.logPrediction({ symbol: 'not a ticker' }), null);
});

test('the endpoint serves the ledger, the scorecard and a written form', async () => {
  reset();
  preds.logPrediction({ symbol: 'NVDA', label: 'BUY', conviction: 'H', basePrice: 100 });

  const res = await fetch(`${base}/api/predictions?markdown=1`);
  const json = await res.json();

  assert.equal(res.status, 200);
  assert.equal(json.predictions.length, 1);
  assert.equal(json.scorecard.logged, 1);
  assert.match(json.markdown, /Prediction scorecard/);
});
