// Crumb acquisition through Yahoo's consent interstitial.
//
// The crumb is bound to a session cookie, and in consent regions Yahoo does not
// hand that cookie over in one response: it bounces the quote page through
// guce.yahoo.com and back, setting a piece of the session on each hop. The
// previous implementation seeded from a single `fc.yahoo.com` request and read
// cookies off one response, so every cookie set on an intermediate hop was
// dropped and the crumb came back unusable — which looks downstream exactly
// like Yahoo rejecting the request.
//
// The stub below is that redirect chain. Yahoo cannot be reached from CI, so
// this pins the mechanics; scripts/verify-feed.js answers whether the real
// endpoints still behave this way.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.ALLOW_PRIVATE_EGRESS = 'true'; // the stub is on loopback
process.env.LOG_LEVEL = 'error';
process.env.MARKET_CACHE_MS = '0';

// Every request the stub saw, so the test can assert on what was actually sent
// rather than only on what came back.
const seen = [];
// How many consent hops to serve before landing on the quote page.
let consentHops = 2;
// Whether the crumb endpoint demands the full session assembled across hops.
let requireFullSession = true;

const upstream = http.createServer((req, res) => {
  seen.push({ url: req.url, cookie: req.headers.cookie || '', accept: req.headers.accept || '' });

  // The quote page: bounces through the consent host, setting one cookie per
  // hop, before finally answering with HTML.
  const consent = req.url.match(/^\/consent\/(\d+)/);
  if (consent) {
    const step = Number(consent[1]);
    if (step < consentHops) {
      res.writeHead(302, {
        'Set-Cookie': `consent${step}=ok${step}; Path=/`,
        Location: `/consent/${step + 1}`,
      });
      return res.end();
    }
    res.writeHead(302, { 'Set-Cookie': 'A3=final; Path=/', Location: '/quote-page' });
    return res.end();
  }

  if (req.url === '/seed') {
    res.writeHead(302, { 'Set-Cookie': 'GUC=start; Path=/', Location: '/consent/0' });
    return res.end();
  }

  if (req.url === '/quote-page') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end('<html><body>quote</body></html>');
  }

  if (req.url.startsWith('/v1/test/getcrumb')) {
    const cookie = req.headers.cookie || '';
    // The real endpoint answers with an error page rather than a crumb when the
    // session is incomplete. Reproducing that is the whole point: a partial
    // session must not silently yield a "crumb".
    if (requireFullSession && !(cookie.includes('GUC=start') && cookie.includes('A3=final'))) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<html>Unauthorized</html>');
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    // Escaped on purpose — Yahoo really does return entity-encoded crumbs.
    return res.end('abc&#x2F;def');
  }

  res.writeHead(404).end();
});

upstream.listen(0);
await new Promise((r) => upstream.once('listening', r));
const port = upstream.address().port;

process.env.YAHOO_BASE = `http://127.0.0.1:${port}`;
process.env.YAHOO_CRUMB_SEED_URL = `http://127.0.0.1:${port}/seed`;

const { clearMarketCache, marketHealth } = await import('../src/market/yahoo.js');
const { config } = await import('../src/config.js');

// The module reads these through config at call time, but config was built from
// env at import; make sure both agree regardless of import order.
config.market.base = `http://127.0.0.1:${port}`;
config.market.crumbSeedUrl = `http://127.0.0.1:${port}/seed`;

test.after(() => {
  upstream.closeAllConnections?.();
  upstream.close();
});

// The crumb is only reachable through the private quote path, so drive it the
// way production does — through a quote — and read the outcome off the health
// report and the requests the stub recorded.
async function runCrumb() {
  clearMarketCache();
  seen.length = 0;
  const { fetchQuote } = await import('../src/market/yahoo.js');
  await fetchQuote('AAPL').catch(() => null); // the ladder's outcome is not what is under test
}

test('cookies set on every consent hop are carried into the crumb request', async () => {
  consentHops = 2;
  requireFullSession = true;
  await runCrumb();

  const crumbReq = seen.find((r) => r.url.startsWith('/v1/test/getcrumb'));
  assert.ok(crumbReq, 'the crumb endpoint should have been called');

  // The cookie from the first hop and the one from the last must both survive.
  // Reading only the final response's headers loses GUC, which is the bug.
  assert.match(crumbReq.cookie, /GUC=start/, 'first-hop cookie must survive the redirect chain');
  assert.match(crumbReq.cookie, /A3=final/, 'last-hop cookie must be present too');
  assert.match(crumbReq.cookie, /consent0=ok0/, 'intermediate hop cookies are kept as well');

  assert.equal(marketHealth().crumb, true, 'a usable crumb should have been stored');
});

test('the seed request asks for HTML, without which Yahoo sets no cookie', async () => {
  consentHops = 1;
  requireFullSession = true;
  await runCrumb();

  const seed = seen.find((r) => r.url === '/seed');
  assert.ok(seed, 'the seed URL should have been fetched');
  assert.match(seed.accept, /text\/html/);
});

test('an entity-encoded crumb is decoded rather than stored raw', async () => {
  consentHops = 2;
  requireFullSession = true;
  await runCrumb();

  const quoteReq = seen.find((r) => r.url.startsWith('/v7/finance/quote'));
  // The stub returns `abc&#x2F;def`, which decodes to `abc/def` and is then
  // URL-encoded into the query string.
  if (quoteReq) {
    assert.doesNotMatch(quoteReq.url, /&#x/, 'a raw entity must never reach the query string');
    assert.match(quoteReq.url, /crumb=abc%2Fdef/);
  }
});

test('an HTML error page is refused rather than stored as a crumb', async () => {
  consentHops = 2;
  // Force the crumb endpoint to answer with its unauthorized page.
  requireFullSession = true;
  clearMarketCache();
  seen.length = 0;
  // Point the seed somewhere that sets no cookies, so the session is incomplete.
  const goodSeed = config.market.crumbSeedUrl;
  config.market.crumbSeedUrl = `http://127.0.0.1:${port}/quote-page`;

  const { fetchQuote } = await import('../src/market/yahoo.js');
  await fetchQuote('MSFT').catch(() => null);

  assert.equal(
    marketHealth().crumb,
    false,
    'an HTML page must not be mistaken for a crumb',
  );
  const quoteReq = seen.find((r) => r.url.startsWith('/v7/finance/quote'));
  if (quoteReq) assert.doesNotMatch(quoteReq.url, /crumb=/, 'no crumb should be appended');

  config.market.crumbSeedUrl = goodSeed;
});

test('a redirect loop is bounded rather than followed forever', async () => {
  // More hops than the configured ceiling: the walk must stop on its own.
  consentHops = 500;
  requireFullSession = false;
  await runCrumb();

  const hops = seen.filter((r) => r.url.startsWith('/consent/')).length;
  assert.ok(
    hops <= config.market.crumbMaxHops + 1,
    `followed ${hops} consent hops, which should be capped at ${config.market.crumbMaxHops + 1}`,
  );
});
