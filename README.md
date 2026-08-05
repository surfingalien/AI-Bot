# SurfingAlien AI

A deep-research desk with an agent behind it. The browser holds a single-file
UI — routing, tool calls, dossiers, a self-extending sandbox — and this server
gives it the three things a page cannot do for itself: reach the open web,
reach a model without shipping an API key to the client, and keep working when
the tab is closed.

```
┌──────────────────────────────────────────┐
│  public/index.html — the desk            │
│  agents · tools · sandbox · dossiers     │
└───────────────┬──────────────────────────┘
                │ fetch()
┌───────────────▼──────────────────────────┐
│  src/ — this server                      │
│                                          │
│  /api/fetch          page reader (CORS)  │
│  /api/yahoo/*        live market feed    │
│  /api/notify         out-of-tab alerts   │
│  /api/v1/*           model brain proxy   │
│  /api/autonomy/*     goals that fire     │
│  /api/genome         brain transfer      │
└───────────────┬──────────────────────────┘
                │
      web · Yahoo Finance · your LLM · Slack/Discord
```

## Quick start

```bash
npm install
cp .env.example .env      # optional — the desk runs without it
npm start                 # http://localhost:8787
```

Open the page. The server injects its own origin as the data-proxy base on
first load, so deep research and the live feed work immediately — no trip to
the Settings panel. Add `BRAIN_BASE`/`BRAIN_KEY` to `.env` and the model brain
is wired up too, with the key staying on the server.

```bash
npm test                  # 45 tests, no network required
npm run dev               # restart on change
```

## What the server provides

### Deep research — `GET /api/fetch?url=…`

Fetches a page and returns `{ ok, title, text }`. The browser's `deep_research`
tool proposes sources, pulls each one through here, and synthesizes a brief
where every claim carries an `[n]` citation.

The reader is guarded, because a naive version of this endpoint is an SSRF
hole: schemes are limited to http/https, every hostname is resolved and
rejected if it lands on a private, loopback, link-local or CGNAT address
(including `169.254.169.254`, the cloud metadata endpoint), redirects are
followed manually so each hop is re-checked, and the body is capped and timed
out. `ALLOW_PRIVATE_EGRESS=true` lifts the address check for local development
only.

### Live market feed — `GET /api/yahoo/chart/:symbol`, `GET /api/yahoo/quote/:symbol`

Yahoo Finance, proxied. Responses keep Yahoo's own envelope
(`chart.result[0]`, `quoteResponse.result[0]`) so the engine's existing parsers
work untouched.

Yahoo's quote endpoint is unofficial and crumb-gated, so the server tries three
sources in order — `v7/finance/quote` with a cookie+crumb, then
`v10/finance/quoteSummary` remapped into the v7 shape, then chart metadata
alone. The last fallback genuinely has no fundamentals, so those fields come
back `null` and the UI prints `UNVERIFIED` rather than inventing a number.

`GET /api/market/snapshot/:symbol` returns the quote plus every computed
indicator in one call.

### Model brain — `POST /api/v1/chat/completions`

An OpenAI-compatible pass-through to whatever you configure in `BRAIN_BASE`
(OpenRouter, OpenAI, Groq, a local Ollama). Streaming and tool-calling pass
through untouched, so point the desk's BASE URL at
`http://localhost:8787/api/v1`, leave its API-key box empty, and the credential
never reaches the browser. `GET /api/brain/probe` answers whether the upstream
is actually reachable.

### Alerts — `POST /api/notify`

Forwards `{ text }` to `NOTIFY_WEBHOOK` in a body shaped for both Slack
(`text`) and Discord (`content`). Caller-supplied webhooks are refused unless
`NOTIFY_ALLOW_REQUEST_WEBHOOK=true`, since accepting them turns the server into
an open relay.

## The autonomy loop

The browser's goals stop the moment the tab closes. The server runs the same
kind of loop with no tab at all: every tick it walks the armed goals, refreshes
the market data their conditions reference, evaluates them, and runs the action
of the ones that fire. Every firing lands in an activity log, so there is always
an answer to "what has it been doing?".

A goal is a condition, an action, and a cadence:

```bash
curl -X POST localhost:8787/api/autonomy/goals -H 'Content-Type: application/json' -d '{
  "name": "opening bell",
  "condText": "at 09:30",
  "actionText": "scan watchlist",
  "cadenceSec": 300
}'
```

**Conditions** — the same dialect the browser engine understands, so goals read
identically in either runtime:

| Condition | Fires when |
|---|---|
| `always` | every cadence |
| `at 09:30` | first tick at/after that local time, once per day |
| `price(NVDA) > 140` | live price crosses the level |
| `rsi(AAPL) < 30` | RSI(14) below the level |
| `chg(MSFT) <= -3` | 1-day change at/below the level |
| `memory contains earnings` | durable memory matches |
| `tasks open` | any imported task is still undone |

A condition needing a symbol with no feed evaluates to *undecidable*, not
false — the loop logs it and moves on instead of firing on missing data.

**Actions:**

| Action | Effect |
|---|---|
| `notify <text>` | push to the webhook + activity log |
| `alert <text>` | same, flagged as an alert |
| `remember k = v` | write durable memory |
| `scan watchlist` | refresh every watched symbol, emit a signal table |
| `research <topic>` | run deep research, emit the cited brief |
| `digest` | summarize armed goals and recent activity |
| `log <text>` | activity log only, no outbound push |

Anything else is refused at arm time rather than at 3am. In `notify`/`alert`
text, `$NVDA` expands to the live price.

Goals are validated on the way in, persisted to `data/state.json` through an
atomic swap, and reloaded on boot.

```
GET    /api/autonomy                  status, goals, watchlist, memory, tasks, feed
GET    /api/autonomy/activity?limit=  what fired, newest first
POST   /api/autonomy/goals            arm a goal
PATCH  /api/autonomy/goals/:id        edit or enable/disable
DELETE /api/autonomy/goals/:id        disarm
POST   /api/autonomy/goals/:id/run    fire now, skipping the condition
POST   /api/autonomy/tick             force a loop iteration
PUT    /api/autonomy/watchlist        {"symbols":["NVDA","AAPL"]}
POST   /api/research                  ad-hoc research, no goal needed
```

### Moving a brain between runtimes

The desk exports its whole state as a genome (`REPLICATE` in the UI). The
server speaks the same format, so a brain moves either direction:

```bash
curl -X POST localhost:8787/api/genome --data-binary @surfingalien-genome.json \
  -H 'Content-Type: application/json'        # ?mode=replace to overwrite
curl localhost:8787/api/genome > genome.json # server state, importable by the UI
```

Goals the server cannot run — browser-only actions like opening a tab — come
back in `skipped` with a reason rather than disappearing.

## Indicators

`src/lib/indicators.js` reimplements the engine's `computeInd` and
`localSignal` numerically identically: SMA 20/50/200, RSI(14), MACD(12,26,9),
Bollinger(20,2), ATR(14), annualized volatility, trailing returns, and the
rules-based BUY/HOLD/SELL score with its named drivers. A server-side scan and
a UI dossier therefore never disagree about the same symbol.

None of this is financial advice — it is a transparent scoring rule, and the UI
says so on every dossier.

## Configuration

Every knob lives in `.env.example` with a comment. The ones that matter:

| Variable | Default | Why you would change it |
|---|---|---|
| `PORT` | `8787` | the port the desk's Settings panel suggests |
| `BRAIN_BASE` / `BRAIN_KEY` / `BRAIN_MODEL` | empty / empty / `gpt-4o-mini` | enables the brain proxy and server-side synthesis |
| `NOTIFY_WEBHOOK` | empty | where alerts go |
| `AUTONOMY_ENABLED` / `AUTONOMY_TICK_MS` | `true` / `30000` | loop on/off and how often it wakes |
| `ALLOW_PRIVATE_EGRESS` | `false` | local dev against a private host |
| `CORS_ORIGINS` | empty | serving the HTML from another origin |

## Layout

```
public/index.html      the desk, exactly as authored
src/server.js          boot, graceful shutdown
src/app.js             routes, CORS, error handling
src/ui.js              serves the desk with first-run defaults injected
src/config.js          env-driven configuration
src/routes/            fetch · notify · yahoo · brain · autonomy · genome
src/market/yahoo.js    feed with crumb handling and fallbacks
src/autonomy/          store · conditions · actions · engine · research
src/lib/               safeFetch · htmlText · indicators · notify · rateLimit
test/                  45 tests, no network required
```

## Notes on behaviour

- **Error responses use real status codes.** The engine only checks
  `response.ok` and degrades gracefully, so nothing in the UI depends on the
  older always-200 convention.
- **Rate limiting is in-process** and fixed-window — enough to stop a runaway
  loop, not a substitute for a gateway in front of a public deployment.
- **`/api/config` reports capabilities as booleans only.** No key or webhook URL
  is ever serialized to a client.
- **Yahoo endpoints are unofficial.** They rate-limit and change shape without
  notice; that is why the quote path has fallbacks and why missing fundamentals
  surface as `UNVERIFIED` rather than as estimates.
