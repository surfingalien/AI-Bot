// The market chain end to end — fetch, parse, indicators, signal, and the
// quote fallback ladder — against a stub standing in for Yahoo.
//
// Yahoo itself cannot be reached from CI, so this pins everything except
// whether Yahoo's response shape has changed. scripts/verify-feed.js answers
// that last question against the real thing.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.ALLOW_PRIVATE_EGRESS = 'true'; // the stub is on loopback
process.env.LOG_LEVEL = 'error';
process.env.MARKET_CACHE_MS = '0';

// What Yahoo answers with, including the parts that trip naive parsers:
// holiday gaps as null bars, and a meta block carrying the 52-week levels.
let mode = 'v7';
const bars = 320;
function chartPayload(symbol) {
  const closes = Array.from({ length: bars }, (_, i) => 100 + i * 0.5 + Math.sin(i / 9) * 3);
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            currency: 'USD',
            longName: `${symbol} Inc.`,
            regularMarketPrice: closes[bars - 1],
            chartPreviousClose: closes[bars - 2],
            fiftyTwoWeekHigh: Math.max(...closes),
            fiftyTwoWeekLow: Math.min(...closes),
          },
          timestamp: closes.map((_, i) => 1700000000 + i * 86400),
          indicators: {
            quote: [
              {
                // Two market holidays: null closes that must not reach the math.
                close: closes.map((c, i) => (i === 40 || i === 41 ? null : c)),
                high: closes.map((c) => c + 1.2),
                low: closes.map((c) => c - 1.4),
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
}

const upstream = http.createServer((req, res) => {
  const json = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const symbol = (req.url.match(/(?:chart|quoteSummary)\/([^?]+)/) || [])[1] || 'TEST';

  if (req.url.startsWith('/v1/test/getcrumb')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('stub-crumb');
  }
  if (req.url.startsWith('/v8/finance/chart/')) return json(chartPayload(symbol));

  if (req.url.startsWith('/v7/finance/quote')) {
    if (mode !== 'v7') return json({ error: 'unauthorized' }, 401);
    return json({
      quoteResponse: {
        result: [
          {
            symbol: 'TEST',
            shortName: 'Test Corp',
            regularMarketPrice: 259.5,
            regularMarketChangePercent: 1.4,
            marketCap: 2.4e12,
            trailingPE: 31.2,
            fiftyTwoWeekHigh: 261,
            fiftyTwoWeekLow: 99,
          },
        ],
        error: null,
      },
    });
  }
  if (req.url.startsWith('/v10/finance/quoteSummary/')) {
    if (mode !== 'summary') return json({ error: 'unauthorized' }, 401);
    return json({
      quoteSummary: {
        result: [
          {
            price: {
              shortName: 'Test Corp',
              regularMarketPrice: { raw: 259.5 },
              regularMarketChangePercent: { raw: 0.014 },
              marketCap: { raw: 2.4e12 },
            },
            summaryDetail: { trailingPE: { raw: 31.2 }, fiftyTwoWeekHigh: { raw: 261 } },
            defaultKeyStatistics: { priceToBook: { raw: 44.1 } },
            financialData: { recommendationKey: 'buy', targetMeanPrice: { raw: 290 } },
            assetProfile: { sector: 'Technology', industry: 'Consumer Electronics' },
          },
        ],
      },
    });
  }
  return json({ error: 'not found' }, 404);
});

upstream.listen(0);
await new Promise((r) => upstream.once('listening', r));
process.env.YAHOO_BASE = `http://127.0.0.1:${upstream.address().port}`;

const { config } = await import('../src/config.js');
const market = await import('../src/market/yahoo.js');
const { computeIndicators, localSignal } = await import('../src/lib/indicators.js');

test.after(() => upstream.close());

test('the chart survives holiday gaps and stays aligned', async () => {
  market.clearMarketCache();
  const series = market.parseChart(await market.fetchChart('TEST'));

  assert.equal(series.closes.length, bars - 2, 'null bars are dropped');
  assert.equal(series.highs.length, series.closes.length);
  assert.equal(series.lows.length, series.closes.length);
  assert.equal(series.dates.length, series.closes.length);
  assert.ok(series.closes.every((c) => typeof c === 'number' && !Number.isNaN(c)));
});

test('indicators computed from a real-shaped payload are plausible', async () => {
  market.clearMarketCache();
  const ind = computeIndicators(market.parseChart(await market.fetchChart('TEST')));

  assert.ok(ind.last > 0 && ind.last < 1e7);
  assert.ok(ind.rsi >= 0 && ind.rsi <= 100);
  assert.ok(ind.vol >= 0 && ind.vol < 500);
  assert.ok(ind.s50 / ind.last > 0.3 && ind.s50 / ind.last < 3, 'moving averages share the scale');
  assert.equal(ind.trend, 'BULL');
  // 52-week levels come from Yahoo's meta rather than being recomputed.
  assert.ok(ind.hi52 >= ind.last);

  const signal = localSignal(ind);
  assert.ok(['BUY', 'HOLD', 'SELL'].includes(signal.label));
  assert.ok(signal.reasons.length >= 4);
  assert.ok(signal.stop < signal.entry && signal.target > signal.entry);
});

test('quote uses the v7 endpoint when it answers', async () => {
  market.clearMarketCache();
  mode = 'v7';
  const quote = await market.fetchQuote('TEST');
  const q = quote.quoteResponse.result[0];

  assert.equal(q.shortName, 'Test Corp');
  assert.equal(q.marketCap, 2.4e12);
  assert.equal(quote.partial, undefined);
});

test('quote falls back to quoteSummary, remapped into the v7 shape', async () => {
  market.clearMarketCache();
  mode = 'summary';
  const quote = await market.fetchQuote('TEST');
  const q = quote.quoteResponse.result[0];

  assert.equal(quote.source, 'quoteSummary');
  assert.equal(q.regularMarketPrice, 259.5);
  // quoteSummary reports the change as a fraction; the v7 shape is a percent.
  assert.equal(q.regularMarketChangePercent, 1.4000000000000001);
  assert.equal(q.marketCap, 2.4e12);
  assert.equal(q.sector, 'Technology');
  assert.equal(q.recommendationKey, 'buy');
});

test('quote falls back to chart metadata and flags the gap honestly', async () => {
  market.clearMarketCache();
  mode = 'none';
  const quote = await market.fetchQuote('TEST');
  const q = quote.quoteResponse.result[0];

  assert.equal(quote.source, 'chartMeta');
  assert.equal(quote.partial, true);
  assert.ok(q.regularMarketPrice > 0);
  assert.equal(q.shortName, 'TEST Inc.');
  // The fundamentals genuinely are not in this payload, so they must read as
  // absent rather than as zero — the desk prints UNVERIFIED for null.
  assert.equal(q.marketCap, null);
  assert.equal(q.trailingPE, null);
  assert.equal(q.sector, null);
});

test('snapshot returns what the autonomy loop needs in one call', async () => {
  market.clearMarketCache();
  mode = 'v7';
  const snap = await market.snapshot('test');

  assert.equal(snap.symbol, 'TEST');
  assert.ok(snap.indicators.last > 0);
  assert.ok(snap.quote.regularMarketPrice > 0);
  assert.ok(Array.isArray(snap.closes) && snap.closes.length > 200);
});

test('the configured base is what actually gets called', () => {
  assert.equal(config.market.base, process.env.YAHOO_BASE);
});
