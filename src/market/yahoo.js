// Yahoo Finance access. The browser cannot call Yahoo directly (CORS), so the
// server does it and hands back the *exact* JSON shapes the engine's
// parseChart()/parseQuote() expect: `chart.result[0]` and
// `quoteResponse.result[0]`.
//
// Yahoo's quote endpoint is unofficial and now crumb-gated. The chain is:
//   1. v7/finance/quote with a cookie+crumb
//   2. v10/finance/quoteSummary, mapped into the v7 shape
//   3. chart metadata only, mapped into the v7 shape and flagged `partial`
// Whatever a caller gets, the shape is stable.

import { config } from '../config.js';
import { FetchError, fetchText, assertPublicUrl } from '../lib/safeFetch.js';
import { computeIndicators } from '../lib/indicators.js';
import { log } from '../lib/log.js';

const CRUMB_TTL_MS = 30 * 60 * 1000;
const CRUMB_RETRY_MS = 10 * 60 * 1000;
// How long to trust that a symbol's working quote source is still the working
// one. Short enough that a recovered endpoint gets picked back up quickly.
const QUOTE_ROUTE_TTL_MS = 10 * 60 * 1000;

// Read through config so a mirror or a test stub can stand in for Yahoo.
function base() {
  return config.market.base;
}

let crumbCache = { cookie: '', crumb: '', ts: 0 };
let crumbFailedUntil = 0;
const responseCache = new Map(); // key -> { ts, value }
// Which rung of the quote ladder last worked. Without this every quote pays
// for every failing rung above the one that actually answers.
const quoteRoute = new Map(); // symbol -> { source, ts }
// A symbol whose whole ladder just failed will almost certainly fail again in
// the next few seconds. Remembering that is the difference between a dossier
// on three tickers costing one timeout or nine.
const quoteFailure = new Map(); // symbol -> { until, message }

export function normalizeSymbol(input) {
  const sym = String(input || '')
    .trim()
    .toUpperCase()
    .replace(/^\$/, '');
  // Covers equities, classes (BRK-B), FX pairs (EURUSD=X) and indices (^GSPC).
  if (!/^\^?[A-Z0-9][A-Z0-9.\-=^]{0,14}$/.test(sym)) return null;
  return sym;
}

function cached(key) {
  const hit = responseCache.get(key);
  if (hit && Date.now() - hit.ts < config.market.cacheMs) return hit.value;
  return null;
}

function store(key, value) {
  responseCache.set(key, { ts: Date.now(), value });
  if (responseCache.size > 500) {
    const oldest = [...responseCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) responseCache.delete(oldest[0]);
  }
  return value;
}

export function clearMarketCache() {
  responseCache.clear();
  quoteRoute.clear();
  quoteFailure.clear();
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
  crumbCache = { cookie: '', crumb: '', ts: 0 };
  crumbFailedUntil = 0;
}

// When several symbols fail in a row it is the upstream that is down, not the
// symbols. Without this, every new ticker in a dossier pays the full timeout
// again to rediscover the same outage.
let consecutiveFailures = 0;
let breakerOpenUntil = 0;

function breakerOpen() {
  if (Date.now() < breakerOpenUntil) return true;
  if (breakerOpenUntil) {
    // Window elapsed: let the next call through to see if Yahoo is back.
    breakerOpenUntil = 0;
    consecutiveFailures = 0;
  }
  return false;
}

function noteFailure() {
  consecutiveFailures += 1;
  if (consecutiveFailures >= config.market.breakerThreshold) {
    breakerOpenUntil = Date.now() + config.market.breakerMs;
    log.warn(
      `market feed looks down (${consecutiveFailures} failures) — failing fast for ${
        config.market.breakerMs / 1000
      }s`,
    );
  }
}

function noteSuccess() {
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
}

export function marketHealth() {
  return {
    breakerOpen: Date.now() < breakerOpenUntil,
    consecutiveFailures,
    reopensInSec: breakerOpenUntil ? Math.max(0, Math.ceil((breakerOpenUntil - Date.now()) / 1000)) : 0,
    cachedSymbols: [...quoteRoute.keys()],
    crumb: Boolean(crumbCache.crumb),
  };
}

function recentFailure(symbol) {
  const hit = quoteFailure.get(symbol);
  if (!hit) return null;
  if (Date.now() > hit.until) {
    quoteFailure.delete(symbol);
    return null;
  }
  return hit;
}

function rememberFailure(symbol, message) {
  quoteFailure.set(symbol, { until: Date.now() + config.market.failureTtlMs, message });
  noteFailure();
}

function knownRoute(symbol) {
  const hit = quoteRoute.get(symbol);
  if (!hit) return null;
  if (Date.now() - hit.ts > QUOTE_ROUTE_TTL_MS) {
    quoteRoute.delete(symbol);
    return null;
  }
  return hit.source;
}

/**
 * Fold a response's Set-Cookie headers into a jar.
 *
 * A jar rather than a single string because the cookies the crumb is bound to
 * are not all set by one response: the consent flow sets some on the way out
 * and some on the way back, and a later hop may reissue one an earlier hop
 * already set. Last write wins, which is what a browser does.
 */
function absorbCookies(jar, headers) {
  const lines = headers?.getSetCookie?.() || [];
  for (const line of lines) {
    const pair = String(line).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return jar;
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Walk a redirect chain by hand, keeping every cookie set along the way.
 *
 * `fetchText` cannot do this: it follows redirects internally and hands back
 * only the last response's headers, so anything the consent interstitial set
 * on an intermediate hop is gone by the time it returns — which is exactly the
 * cookie the crumb is bound to. Each hop is still validated through
 * `assertPublicUrl`, so this keeps the SSRF guard the shared helper provides.
 */
async function seedCookieJar(startUrl, jar) {
  let current = String(startUrl);
  for (let hop = 0; hop <= config.market.crumbMaxHops; hop++) {
    const url = await assertPublicUrl(current);
    const response = await fetch(url, {
      headers: {
        'User-Agent': config.fetch.userAgent,
        // Without an HTML Accept, Yahoo answers without a Set-Cookie at all.
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(jar.size ? { Cookie: cookieHeader(jar) } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(config.market.timeoutMs),
    });
    absorbCookies(jar, response.headers);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return jar;
      current = new URL(location, url).toString();
      continue;
    }
    return jar;
  }
  // Out of hops. Whatever was collected still stands a chance of working.
  return jar;
}

// Yahoo returns the crumb inside an HTML-escaped payload often enough that a
// raw copy is rejected as malformed.
function decodeEntities(text) {
  return String(text).replace(/&#x([0-9a-f]{1,4});/gi, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

async function getCrumb() {
  if (crumbCache.crumb && Date.now() - crumbCache.ts < CRUMB_TTL_MS) return crumbCache;
  // Extra round trips that fail together when Yahoo is gating us. Retrying
  // them on every quote is what turns one slow call into a very slow one.
  if (Date.now() < crumbFailedUntil) return crumbCache;
  try {
    // A real quote page, following the consent interstitial where one is
    // served. `fc.yahoo.com` is the older trick — it still answers, but in
    // consent regions it hands back no usable session at all, which reads
    // downstream as "Yahoo is rejecting us" rather than "we never logged in".
    const jar = new Map();
    await seedCookieJar(config.market.crumbSeedUrl, jar).catch((err) => {
      log.debug(`yahoo crumb seed failed: ${err?.message || err}`);
      return jar;
    });

    // The old seed, kept as a fallback rather than deleted: it is one cheap
    // request, and where the quote page gives nothing it sometimes still does.
    if (!jar.size) {
      await fetchText('https://fc.yahoo.com/', { maxRedirects: 2 })
        .then((seed) => absorbCookies(jar, seed?.headers))
        // fc.yahoo.com answers 404 but sets the cookie anyway, so a 404 here
        // is a normal outcome and not worth surfacing.
        .catch(() => jar);
    }

    const cookie = cookieHeader(jar);
    const crumbRes = await fetchText(`${base()}/v1/test/getcrumb`, {
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        Accept: '*/*',
      },
      maxRedirects: 1,
    });
    const crumb = decodeEntities((crumbRes.body || '').trim());
    // A crumb is a short opaque token. An HTML error page is not, and storing
    // one would append megabytes of markup to every quote URL.
    if (crumb && crumb.length < 40 && !/[<>\s]/.test(crumb)) {
      crumbCache = { cookie, crumb, ts: Date.now() };
    } else {
      crumbFailedUntil = Date.now() + CRUMB_RETRY_MS;
      log.debug('yahoo returned no usable crumb; quotes will fall back down the ladder');
    }
  } catch (err) {
    crumbFailedUntil = Date.now() + CRUMB_RETRY_MS;
    log.debug(`yahoo crumb unavailable, skipping it for a while: ${err?.message || err}`);
  }
  return crumbCache;
}

async function getJson(url, { withCrumb = false } = {}) {
  const auth = withCrumb ? await getCrumb() : null;
  const target = withCrumb && auth?.crumb ? `${url}&crumb=${encodeURIComponent(auth.crumb)}` : url;
  const res = await fetchText(target, {
    timeoutMs: config.market.timeoutMs,
    headers: {
      Accept: 'application/json',
      ...(auth?.cookie ? { Cookie: auth.cookie } : {}),
    },
  });
  try {
    return JSON.parse(res.body);
  } catch {
    throw new FetchError('upstream returned non-JSON', 502);
  }
}

/** Raw Yahoo chart JSON, unmodified — the client parses it itself. */
export async function fetchChart(symbol, opts = {}) {
  const sym = normalizeSymbol(symbol);
  if (!sym) throw new FetchError('invalid symbol', 400);
  const range = opts.range || config.market.chartRange;
  const interval = opts.interval || config.market.chartInterval;
  const key = `chart:${sym}:${range}:${interval}`;
  const hit = cached(key);
  if (hit) return hit;

  // The chart is the request every indicator depends on, so it gets the same
  // fail-fast treatment as the quote. Without this a snapshot still pays a
  // full timeout per symbol even with the quote ladder short-circuited.
  const failed = recentFailure(sym);
  if (failed) throw new FetchError(`${failed.message} (cached failure)`, 502);
  if (breakerOpen()) {
    throw new FetchError('market feed unavailable (failing fast after repeated errors)', 503);
  }

  const url = `${base()}/v8/finance/chart/${encodeURIComponent(sym)}?range=${encodeURIComponent(
    range,
  )}&interval=${encodeURIComponent(interval)}&includePrePost=false&events=div%2Csplit`;
  try {
    const json = store(key, await getJson(url));
    noteSuccess();
    return json;
  } catch (err) {
    rememberFailure(sym, err?.message || String(err));
    throw err;
  }
}

function summaryToQuote(sym, summary) {
  const r = summary?.quoteSummary?.result?.[0];
  if (!r) return null;
  const price = r.price || {};
  const detail = r.summaryDetail || {};
  const stats = r.defaultKeyStatistics || {};
  const fin = r.financialData || {};
  const profile = r.assetProfile || {};
  const raw = (v) => (v && typeof v === 'object' ? (v.raw ?? null) : (v ?? null));

  return {
    symbol: sym,
    shortName: price.shortName || price.longName || sym,
    longName: price.longName || null,
    regularMarketPrice: raw(price.regularMarketPrice),
    regularMarketChange: raw(price.regularMarketChange),
    regularMarketChangePercent:
      raw(price.regularMarketChangePercent) != null
        ? raw(price.regularMarketChangePercent) * 100
        : null,
    regularMarketVolume: raw(price.regularMarketVolume),
    marketCap: raw(price.marketCap) ?? raw(detail.marketCap),
    currency: price.currency || null,
    fiftyTwoWeekHigh: raw(detail.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: raw(detail.fiftyTwoWeekLow),
    trailingPE: raw(detail.trailingPE),
    forwardPE: raw(detail.forwardPE) ?? raw(stats.forwardPE),
    priceToBook: raw(stats.priceToBook),
    trailingEps: raw(stats.trailingEps),
    dividendYield: raw(detail.dividendYield),
    beta: raw(detail.beta) ?? raw(stats.beta),
    sector: profile.sector || null,
    industry: profile.industry || null,
    recommendationKey: fin.recommendationKey || null,
    targetMeanPrice: raw(fin.targetMeanPrice),
    targetHighPrice: raw(fin.targetHighPrice),
    targetLowPrice: raw(fin.targetLowPrice),
    numberOfAnalystOpinions: raw(fin.numberOfAnalystOpinions),
  };
}

function chartToQuote(sym, chart) {
  const meta = chart?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const price = meta.regularMarketPrice ?? null;
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? null;
  return {
    symbol: sym,
    shortName: meta.longName || meta.shortName || sym,
    regularMarketPrice: price,
    regularMarketChange: price != null && prev != null ? price - prev : null,
    regularMarketChangePercent:
      price != null && prev ? ((price - prev) / prev) * 100 : null,
    regularMarketVolume: meta.regularMarketVolume ?? null,
    currency: meta.currency || null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
    // Fundamentals genuinely are not in this payload. Leaving them null makes
    // the UI print UNVERIFIED, which is the honest outcome.
    marketCap: null,
    trailingPE: null,
    forwardPE: null,
    priceToBook: null,
    trailingEps: null,
    dividendYield: null,
    beta: null,
    sector: null,
    industry: null,
    recommendationKey: null,
    targetMeanPrice: null,
    targetHighPrice: null,
    targetLowPrice: null,
    numberOfAnalystOpinions: null,
  };
}

/** Yahoo v7-shaped quote payload, synthesized from fallbacks when needed. */
export async function fetchQuote(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym) throw new FetchError('invalid symbol', 400);
  const key = `quote:${sym}`;
  const hit = cached(key);
  if (hit) return hit;

  // Fail fast on a symbol that just failed, rather than making the next caller
  // wait out the same dead ladder.
  const failed = recentFailure(sym);
  if (failed) throw new FetchError(`${failed.message} (cached failure)`, 502);
  if (breakerOpen()) {
    throw new FetchError('market feed unavailable (failing fast after repeated errors)', 503);
  }

  // Once a rung is known to answer for this symbol, start there. Re-walking a
  // failing ladder on every call is what makes a dossier feel like it hangs:
  // each dead rung costs a full timeout, and three tickers pay it three times.
  const route = knownRoute(sym);
  // The ladder as a whole gets a budget, so a first call cannot stack three
  // timeouts back to back.
  const deadline = Date.now() + config.market.quoteBudgetMs;
  const spent = () => Date.now() > deadline;

  // 1. Native v7 quote.
  if ((!route || route === 'v7') && !spent()) {
    try {
      const j = await getJson(
        `${base()}/v7/finance/quote?symbols=${encodeURIComponent(sym)}`,
        { withCrumb: true },
      );
      if (j?.quoteResponse?.result?.length) {
        quoteRoute.set(sym, { source: 'v7', ts: Date.now() });
        noteSuccess();
        return store(key, j);
      }
    } catch (err) {
      log.debug(`yahoo v7 quote failed for ${sym}: ${err?.message || err}`);
    }
  }

  // 2. quoteSummary, remapped.
  if ((!route || route === 'quoteSummary') && !spent()) {
    try {
      const modules = 'price,summaryDetail,defaultKeyStatistics,financialData,assetProfile';
      const j = await getJson(
        `${base()}/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${modules}`,
        { withCrumb: true },
      );
      const mapped = summaryToQuote(sym, j);
      if (mapped) {
        quoteRoute.set(sym, { source: 'quoteSummary', ts: Date.now() });
        noteSuccess();
        return store(key, {
          quoteResponse: { result: [mapped], error: null },
          source: 'quoteSummary',
        });
      }
    } catch (err) {
      log.debug(`yahoo quoteSummary failed for ${sym}: ${err?.message || err}`);
    }
  }

  // 3. Chart metadata only.
  let mapped = null;
  try {
    mapped = chartToQuote(sym, await fetchChart(sym));
  } catch (err) {
    rememberFailure(sym, err?.message || String(err));
    throw err;
  }
  if (!mapped) {
    rememberFailure(sym, 'no quote data available');
    throw new FetchError('no quote data available', 502);
  }
  quoteRoute.set(sym, { source: 'chartMeta', ts: Date.now() });
  noteSuccess();
  return store(key, {
    quoteResponse: { result: [mapped], error: null },
    source: 'chartMeta',
    partial: true,
  });
}

/** Chart JSON -> aligned close/high/low arrays, mirroring the client parser. */
export function parseChart(json) {
  const r = json?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r || !q) return null;
  const ts = r.timestamp || [];
  const closes = [];
  const highs = [];
  const lows = [];
  const dates = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close[i];
    if (c == null) continue;
    closes.push(c);
    highs.push(q.high[i] != null ? q.high[i] : c);
    lows.push(q.low[i] != null ? q.low[i] : c);
    dates.push(ts[i]);
  }
  if (closes.length < 30) return null;
  return { closes, highs, lows, dates, meta: r.meta || {} };
}

/**
 * One-call snapshot used by the autonomy engine: quote + computed indicators.
 */
export async function snapshot(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym) throw new FetchError('invalid symbol', 400);
  const [chart, quote] = await Promise.all([
    fetchChart(sym).catch(() => null),
    fetchQuote(sym).catch(() => null),
  ]);
  const series = chart ? parseChart(chart) : null;
  const ind = series ? computeIndicators(series) : null;
  return {
    symbol: sym,
    ts: Date.now(),
    quote: quote?.quoteResponse?.result?.[0] || null,
    indicators: ind,
    closes: series?.closes || null,
  };
}
