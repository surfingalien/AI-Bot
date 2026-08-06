#!/usr/bin/env node
//
// Verifies the market feed against the real Yahoo endpoints, end to end:
// chart -> parser -> indicators -> signal, plus the quote fallback chain. Run
// it on a machine with open egress before trusting a dossier's numbers.
//
//   node scripts/verify-feed.js            # AAPL
//   node scripts/verify-feed.js NVDA MSFT
//
// Exits non-zero if any symbol fails, so it can gate a deploy.

import { fetchChart, fetchQuote, parseChart, snapshot } from '../src/market/yahoo.js';
import { computeIndicators, localSignal } from '../src/lib/indicators.js';

const symbols = process.argv.slice(2).length ? process.argv.slice(2) : ['AAPL'];

const pass = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    \x1b[2m${m}\x1b[0m`);

function checkPlausible(label, value, { min, max }) {
  if (value == null || Number.isNaN(value)) return `${label} missing`;
  if (value < min || value > max) return `${label} out of range: ${value}`;
  return null;
}

async function verify(symbol) {
  console.log(`\n\x1b[1m${symbol}\x1b[0m`);
  const problems = [];

  // 1. Chart shape — the thing every indicator is built on.
  let chart;
  try {
    chart = await fetchChart(symbol);
    const result = chart?.chart?.result?.[0];
    if (!result) throw new Error('no chart.result[0] in payload');
    pass(`chart fetched (${result.timestamp?.length || 0} bars)`);
  } catch (err) {
    fail(`chart fetch: ${err.message}`);
    return [`${symbol}: chart unavailable`];
  }

  // 2. Parser — must survive real data, which has null bars and holidays.
  const series = parseChart(chart);
  if (!series) {
    fail('parseChart returned null (fewer than 30 usable bars?)');
    return [`${symbol}: chart unparseable`];
  }
  const aligned =
    series.closes.length === series.highs.length &&
    series.closes.length === series.lows.length &&
    series.closes.length === series.dates.length;
  if (aligned) pass(`parsed ${series.closes.length} bars, arrays aligned`);
  else {
    fail('parsed arrays are not aligned');
    problems.push(`${symbol}: misaligned series`);
  }
  if (series.closes.some((c) => c == null || Number.isNaN(c))) {
    fail('null or NaN survived into closes');
    problems.push(`${symbol}: dirty closes`);
  }

  // 3. Indicators — sanity, not exactness. A wrong scale shows up here.
  const ind = computeIndicators(series);
  const checks = [
    checkPlausible('last', ind.last, { min: 0.0001, max: 1e7 }),
    checkPlausible('RSI', ind.rsi, { min: 0, max: 100 }),
    checkPlausible('annualised vol %', ind.vol, { min: 0, max: 500 }),
  ].filter(Boolean);
  if (!checks.length) {
    pass(`indicators plausible (last ${ind.last.toFixed(2)}, RSI ${ind.rsi?.toFixed(1)}, ${ind.trend})`);
  } else {
    checks.forEach((c) => fail(c));
    problems.push(...checks.map((c) => `${symbol}: ${c}`));
  }
  if (ind.s50 != null && ind.s200 != null && ind.last > 0) {
    const ratio = ind.s50 / ind.last;
    if (ratio < 0.3 || ratio > 3) {
      fail(`SMA50 (${ind.s50.toFixed(2)}) implausible against last (${ind.last.toFixed(2)})`);
      problems.push(`${symbol}: SMA scale`);
    } else pass('moving averages sit in the right scale');
  }

  // 4. Signal — must produce a decision with reasons attached.
  const signal = localSignal(ind);
  if (['BUY', 'HOLD', 'SELL'].includes(signal.label) && signal.reasons.length) {
    pass(`signal ${signal.label} (${signal.conv}) — ${signal.reasons.slice(0, 2).join('; ')}`);
  } else {
    fail(`signal malformed: ${JSON.stringify(signal.label)}`);
    problems.push(`${symbol}: signal`);
  }

  // 5. Quote — the crumb-gated path with fallbacks. Partial is acceptable and
  // is reported as such; silence is not.
  try {
    const quote = await fetchQuote(symbol);
    const q = quote?.quoteResponse?.result?.[0];
    if (!q) throw new Error('no quoteResponse.result[0]');
    const source = quote.source || 'v7';
    pass(`quote via ${source}${quote.partial ? ' (partial — no fundamentals)' : ''}`);
    info(`name=${q.shortName || '?'} price=${q.regularMarketPrice ?? '?'} cap=${q.marketCap ?? 'null'}`);

    if (q.regularMarketPrice != null && ind.last) {
      // The quote and the last chart bar describe the same instrument; a wild
      // divergence means one of them is not the symbol we asked for.
      const drift = Math.abs(q.regularMarketPrice - ind.last) / ind.last;
      if (drift > 0.25) {
        fail(`quote price ${q.regularMarketPrice} disagrees with chart last ${ind.last.toFixed(2)}`);
        problems.push(`${symbol}: quote/chart divergence`);
      } else pass(`quote agrees with chart (${(drift * 100).toFixed(1)}% apart)`);
    }
    if (source === 'chartMeta') {
      info('fundamentals unavailable — the desk will print UNVERIFIED, which is correct');
    }
  } catch (err) {
    fail(`quote: ${err.message}`);
    problems.push(`${symbol}: quote unavailable`);
  }

  // 6. The combined call the autonomy loop actually uses.
  try {
    const snap = await snapshot(symbol);
    if (snap.indicators?.last != null) pass('snapshot() returns a usable reading');
    else {
      fail('snapshot() returned no indicators');
      problems.push(`${symbol}: snapshot`);
    }
  } catch (err) {
    fail(`snapshot: ${err.message}`);
    problems.push(`${symbol}: snapshot threw`);
  }

  return problems;
}

console.log('Verifying the live market feed against Yahoo Finance.');
console.log('This needs open egress to query1.finance.yahoo.com.');

const failures = [];
for (const symbol of symbols) {
  failures.push(...(await verify(symbol)));
}

console.log('');
if (failures.length) {
  console.log(`\x1b[31m${failures.length} problem(s):\x1b[0m`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`\x1b[32mFeed verified for ${symbols.join(', ')}.\x1b[0m`);
