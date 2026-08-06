// Portfolio valuation and the latency guards on the market feed, both against
// a stub upstream.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-pf-'));

// Prices per symbol; a symbol absent from this map fails, like a delisted or
// mistyped ticker.
const prices = { NVDA: 150, AAPL: 220 };
let requests = 0;
let hang = false;

const upstream = http.createServer((req, res) => {
  requests += 1;
  const sym = (req.url.match(/chart\/([^?]+)/) || [])[1];
  if (hang || !prices[sym]) {
    // Answer slowly and unhelpfully, the way a rate-limited endpoint does.
    return setTimeout(() => res.writeHead(401).end('{}'), hang ? 2000 : 50);
  }
  const base = prices[sym];
  const closes = Array.from({ length: 300 }, (_, i) => base * (0.7 + (i / 300) * 0.3));
  closes[closes.length - 1] = base;
  closes[closes.length - 2] = base / 1.02; // ~2% up on the day
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      chart: {
        result: [
          {
            meta: { symbol: sym, regularMarketPrice: base, chartPreviousClose: base / 1.02 },
            timestamp: closes.map((_, i) => 1700000000 + i * 86400),
            indicators: {
              quote: [
                {
                  close: closes,
                  high: closes.map((c) => c * 1.01),
                  low: closes.map((c) => c * 0.99),
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
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.ALLOW_PRIVATE_EGRESS = 'true';
process.env.YAHOO_BASE = `http://127.0.0.1:${upstream.address().port}`;
process.env.MARKET_CACHE_MS = '0';
process.env.MARKET_TIMEOUT_MS = '1500';
process.env.MARKET_FAILURE_TTL_MS = '5000';
process.env.MARKET_BREAKER_THRESHOLD = '2';

const { createApp } = await import('../src/app.js');
const { valuePortfolio, portfolioMarkdown } = await import('../src/lib/portfolio.js');
const { clearMarketCache } = await import('../src/market/yahoo.js');

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  upstream.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const api = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
};

test('positions are stored with tickers normalised and junk rejected', async () => {
  const res = await api('PUT', '/api/portfolio', {
    positions: [
      { sym: 'nvda', shares: 10, cost: 100 },
      { sym: '$aapl', shares: 5, cost: 200 },
      { sym: 'not a ticker', shares: 1 },
      { sym: 'MSFT', shares: 'many' },
    ],
  });

  assert.deepEqual(
    res.json.portfolio.map((p) => p.sym),
    ['NVDA', 'AAPL'],
  );
  assert.equal(res.json.rejected.length, 2);
});

test('valuation prices every position and totals only what it could price', async () => {
  clearMarketCache();
  const v = await valuePortfolio([
    { sym: 'NVDA', shares: 10, cost: 100 },
    { sym: 'AAPL', shares: 5, cost: 200 },
  ]);

  const nvda = v.positions.find((p) => p.sym === 'NVDA');
  assert.equal(nvda.price, 150);
  assert.equal(nvda.value, 1500);
  assert.equal(nvda.basis, 1000);
  assert.equal(nvda.pnl, 500);
  assert.equal(nvda.pnlPct, 50);

  assert.equal(v.totals.value, 1500 + 1100);
  assert.equal(v.totals.cost, 1000 + 1000);
  assert.equal(v.totals.pnl, 600);
  assert.equal(v.totals.positions, 2);
  assert.deepEqual(v.incomplete, []);
  // Largest holding first — the one worth looking at.
  assert.equal(v.positions[0].sym, 'NVDA');
});

test('an unpriceable position is excluded from totals, not silently zeroed', async () => {
  clearMarketCache();
  const v = await valuePortfolio([
    { sym: 'NVDA', shares: 10, cost: 100 },
    { sym: 'ZZZZ', shares: 100, cost: 50 },
  ]);

  const dead = v.positions.find((p) => p.sym === 'ZZZZ');
  assert.equal(dead.priced, false);
  assert.equal(dead.value, null);
  assert.ok(dead.error);

  assert.equal(v.totals.value, 1500, 'totals cover only what could be priced');
  assert.deepEqual(v.incomplete, ['ZZZZ']);

  // And the written form says so rather than implying a complete picture.
  assert.match(portfolioMarkdown(v), /ZZZZ could not be priced/);
  assert.match(portfolioMarkdown(v), /UNVERIFIED/);
});

test('the day move is reported alongside total P&L', async () => {
  clearMarketCache();
  const v = await valuePortfolio([{ sym: 'NVDA', shares: 10, cost: 100 }]);
  assert.ok(v.totals.dayChangePct > 1.5 && v.totals.dayChangePct < 2.5);
  assert.ok(v.totals.dayChange > 0);
});

test('an empty portfolio values to zero rather than failing', async () => {
  const v = await valuePortfolio([]);
  assert.equal(v.totals.value, 0);
  assert.deepEqual(v.positions, []);
  assert.match(portfolioMarkdown(v), /No positions recorded/);
});

test('the endpoint serves both JSON and a written form', async () => {
  clearMarketCache();
  const res = await api('GET', '/api/portfolio?markdown=1');
  assert.equal(res.status, 200);
  assert.ok(res.json.totals.value > 0);
  assert.match(res.json.markdown, /## Portfolio/);
  // Timing is attached to every response, so slowness is measurable.
  assert.match(res.headers.get('server-timing'), /app;dur=/);
});

test('a repeated failure is remembered instead of re-walking the dead ladder', async () => {
  clearMarketCache();
  hang = true;

  const first = Date.now();
  await valuePortfolio([{ sym: 'NVDA', shares: 1, cost: 1 }]);
  const firstMs = Date.now() - first;

  const second = Date.now();
  await valuePortfolio([{ sym: 'NVDA', shares: 1, cost: 1 }]);
  const secondMs = Date.now() - second;

  hang = false;
  assert.ok(firstMs > 500, `first call pays the timeout (${firstMs}ms)`);
  assert.ok(secondMs < 200, `second call fails fast (${secondMs}ms, was ${firstMs}ms)`);
});

test('repeated failures across symbols trip the breaker', async () => {
  clearMarketCache();
  hang = true;
  // Two different symbols fail: that is the upstream, not the symbols.
  await valuePortfolio([{ sym: 'NVDA', shares: 1, cost: 1 }]);
  await valuePortfolio([{ sym: 'AAPL', shares: 1, cost: 1 }]);

  const before = requests;
  const started = Date.now();
  await valuePortfolio([{ sym: 'MSFT', shares: 1, cost: 1 }]);
  const ms = Date.now() - started;
  hang = false;

  assert.ok(ms < 200, `a third symbol fails fast once the feed is known down (${ms}ms)`);
  assert.equal(requests, before, 'and costs no upstream call at all');

  const cfg = await api('GET', '/api/config');
  assert.equal(cfg.json.market.breakerOpen, true);
  assert.ok(cfg.json.market.reopensInSec > 0);
});
