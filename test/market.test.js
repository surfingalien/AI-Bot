import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSymbol, parseChart } from '../src/market/yahoo.js';
import { computeIndicators } from '../src/lib/indicators.js';

test('normalizeSymbol accepts tickers the UI actually produces', () => {
  assert.equal(normalizeSymbol('nvda'), 'NVDA');
  assert.equal(normalizeSymbol('$aapl'), 'AAPL');
  assert.equal(normalizeSymbol(' brk-b '), 'BRK-B');
  assert.equal(normalizeSymbol('^GSPC'), '^GSPC');
  assert.equal(normalizeSymbol('EURUSD=X'), 'EURUSD=X');
});

test('normalizeSymbol rejects anything that is not a ticker', () => {
  for (const bad of ['', null, 'not a ticker', '../../etc/passwd', 'a'.repeat(20), 'AAPL;DROP']) {
    assert.equal(normalizeSymbol(bad), null, `${bad} should be rejected`);
  }
});

function yahooChart(closes, { gapAt = -1 } = {}) {
  return {
    chart: {
      result: [
        {
          meta: { symbol: 'TEST', fiftyTwoWeekHigh: 200, fiftyTwoWeekLow: 50 },
          timestamp: closes.map((_, i) => 1700000000 + i * 86400),
          indicators: {
            quote: [
              {
                close: closes.map((c, i) => (i === gapAt ? null : c)),
                high: closes.map((c) => c + 1),
                low: closes.map((c) => c - 1),
              },
            ],
          },
        },
      ],
    },
  };
}

test('parseChart aligns close/high/low series and keeps meta', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
  const parsed = parseChart(yahooChart(closes));

  assert.equal(parsed.closes.length, 60);
  assert.equal(parsed.highs.length, 60);
  assert.equal(parsed.lows.length, 60);
  assert.equal(parsed.dates.length, 60);
  assert.equal(parsed.meta.fiftyTwoWeekHigh, 200);
});

test('parseChart drops bars with a null close so the arrays stay aligned', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
  const parsed = parseChart(yahooChart(closes, { gapAt: 10 }));

  assert.equal(parsed.closes.length, 59);
  assert.equal(parsed.closes.includes(null), false);
  assert.equal(parsed.highs.length, parsed.closes.length);
  assert.equal(parsed.dates.length, parsed.closes.length);
});

test('parseChart refuses payloads too short to compute anything', () => {
  assert.equal(parseChart(yahooChart([1, 2, 3])), null);
  assert.equal(parseChart(null), null);
  assert.equal(parseChart({ chart: { result: [] } }), null);
  assert.equal(parseChart({ chart: { result: [{ meta: {} }] } }), null);
});

test('a parsed chart feeds straight into the indicator stack', () => {
  const closes = Array.from({ length: 260 }, (_, i) => 100 + i * 0.4);
  const ind = computeIndicators(parseChart(yahooChart(closes)));

  assert.equal(ind.n, 260);
  // 52-week levels come from Yahoo's meta when present, not recomputed.
  assert.equal(ind.hi52, 200);
  assert.equal(ind.lo52, 50);
  assert.ok(ind.s50 != null && ind.s200 != null);
});
