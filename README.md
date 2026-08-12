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
│  + desk-server.js — SERVER panel         │
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
│  /api/voice/brief    speech, not recital │
│  /api/intent         English in, cmds out│
│  /api/portfolio      positions priced now│
│  /api/diagnostics    where the time goes │
│  /api/predictions    was it right?       │
│  /api/kelly          how much to risk    │
│  /api/email          reports to an inbox │
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
npm test                  # 185 tests, no network required
npm run validate          # boot a real server, walk every route
npm run dev               # restart on change
```

`npm test` proves the units; `npm run validate` proves the assembled app. It
boots `src/server.js` the way a host does, points every outbound dependency at
a stub, and walks all of it — so the run is identical on a laptop, in CI, and
in a sandbox where the real upstreams are blocked. Add `-- --browser` to drive
the desk in a real Chromium as well (needs `playwright-core`; without it the
pass is skipped out loud, never counted as green).

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
never reaches the browser. `POST /api/v1/embeddings` is proxied too, so the
desk's semantic recall embeds through the real model instead of falling back to
its local approximation. `GET /api/brain/probe` answers whether the upstream is
actually reachable.

### Alerts — `POST /api/notify`

Forwards `{ text }` to `NOTIFY_WEBHOOK` in a body shaped for both Slack
(`text`) and Discord (`content`). Caller-supplied webhooks are refused unless
`NOTIFY_ALLOW_REQUEST_WEBHOOK=true`, since accepting them turns the server into
an open relay.

Alerts are rewritten before they are sent, because an alert is read on a phone,
away from any screen, where a metric dump is wasted:

```
fired:  "ALERT: price(NVDA) > 140 | last=142.6234 | rsi=68.3129 | chg=+4.0121%"
sent:   "NVDA broke 140, up about 4 percent since the open."
```

One sentence, under 25 words, the one number that matters. The activity log
records what was actually sent rather than what was configured, so the log and
the phone agree. `NOTIFY_VOICE=false` sends the raw text instead.

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
| `price(NVDA) > 140` | live price is above the level |
| `rsi(AAPL) < 30` | RSI(14) below the level |
| `chg(MSFT) <= -3` | 1-day change at/below the level |
| `memory contains earnings` | durable memory matches |
| `tasks open` | any imported task is still undone |
| `price(NVDA) crosses above 140` | the level is crossed, not merely exceeded |
| `rsi(AAPL) crosses below 30` | same, downward |

A condition needing a symbol with no feed evaluates to *undecidable*, not
false — the loop logs it and moves on instead of firing on missing data.

**Firing on the edge.** A level condition stays true for as long as the price
stays there, so `price(NVDA) > 140` would alert every tick for a week. Goals
therefore fire on the transition into true and re-arm when it goes false again;
pass `"edge": false` to get the old level-triggered behaviour. A crossing is a
transition by definition — it compares this reading against the previous one,
so the first sample after arming only establishes the baseline, and touching
the level exactly is not yet a crossing.

**Actions:**

| Action | Effect |
|---|---|
| `notify <text>` | push to the webhook + activity log |
| `alert <text>` | same, flagged as an alert |
| `remember k = v` | write durable memory |
| `scan watchlist` | refresh every watched symbol, emit a signal table |
| `research <topic>` | run deep research, emit the cited brief |
| `portfolio` | value every position and report P&L |
| `score` | resolve past calls and report the scorecard |
| `email <report>` | mail the scorecard, portfolio, scan or digest |
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

### The SERVER panel

`public/desk-server.js` adds a **SERVER** button to the desk (bottom-left, clear
of the drawer) that opens a panel onto the runtime: loop status, the goals armed
server-side with toggle/run-now/disarm, a live activity feed, a form for arming
new goals, and one-click genome sync in both directions.

It lives outside `index.html` on purpose. The desk is authored elsewhere and
re-uploaded whole, so anything written into it would be overwritten on the next
revision — a companion file survives that. It also stays inert: if `/api/config`
does not answer, the button never appears, so opening the HTML straight from
disk behaves exactly as before.

Arming a goal from the panel goes through the same validation as the API, so a
condition the server cannot evaluate is refused inline with the reason rather
than accepted and silently never fired.

### Voice that briefs instead of reciting — `POST /api/voice/brief`

The desk hands its raw markdown to the browser's speech synthesiser, so a
dossier gets read out as pipes, asterisks and four-decimal figures. Nothing
about a table is speakable: it is a layout, and layout is what voice cannot
carry.

This endpoint answers with a spoken script instead. With a brain configured the
model writes it under hard constraints — two to four sentences, the decision
first, at most three numbers rounded the way people say them, no markup, name
the caveat. Without one, a deterministic shaper strips the layout, humanizes the
figures and keeps the opening claim. Either way the caller gets something
speakable and never an error mid-sentence.

```
before:  "## NVDA — Dossier | Metric | Value | |---|---| | Last | $142.6234 |
          | RSI(14) | 68.3129 | … 12.4531% … **VERDICT:** BUY (M) [1]"

after:   "The call is buy, medium conviction. Momentum is constructive with
          price 12.5 percent above the 200-day average."
```

The desk's own `speak()` lives inside its engine closure and cannot be replaced
from outside, so `desk-server.js` intercepts `speechSynthesis.speak` — the
boundary both sides share. Every existing call site is covered: dossiers,
mission summaries, reminders. Text that is already speech (a reminder, a
one-liner) skips the round trip entirely, results are cached for ten minutes so
a repeat costs nothing, and a stale rewrite is dropped rather than spoken after
a newer answer. **VOICE: BRIEFING / VERBATIM** in the SERVER panel switches
between the brief and the desk's original behaviour.

### Speaking to it in English — `POST /api/intent`

The desk routes spoken commands by keyword, so "how's my portfolio doing" hits
nothing while "positions" works. Rather than teach the operator the syntax,
translate: the model maps a transcript onto the command vocabulary the desk
already has.

```
heard:  "how's my portfolio doing"     ran:  positions
heard:  "tell me about nvidia data centers"
                                       ran:  deep research the NVDA data-center market
heard:  "what a lovely morning"        ran:  (passed through, unchanged)
```

Passing through is the important default — a wrong rewrite silently runs the
wrong command, which is worse than no rewrite. So a transcript is only replaced
when the model lands on a known verb; anything else, including an answer outside
the vocabulary, goes through exactly as spoken. Text that is already a desk
command is never sent to the model at all.

The desk's recogniser accumulates its transcript in `onresult` and runs it in
`onend`, both closure-scoped, so `desk-server.js` wraps the `SpeechRecognition`
constructor: it holds the desk's own handlers, translates on the way through,
and hands the result back in the shape the handler already expects. **INTENT
ON/OFF** in the panel controls it, and the panel shows both what was heard and
what was run.

### Access control — `API_TOKEN`

Off by default, because on loopback it buys nothing. Set it before this binds
anywhere routable; the server warns at boot if it is listening off-loopback
without one.

`PROXY_TOKEN` is read as an alias, because that is the name the desk's own
settings panel tells the operator to set. `API_TOKEN` wins when both are
present. This is not decoration: reading only `API_TOKEN` meant that following
the UI's instructions produced a server with no authentication and nothing but
a boot-time warning to say so.

```bash
API_TOKEN=$(openssl rand -hex 24) npm start
# then open the desk once:
open "http://localhost:8787/?token=YOUR_TOKEN"
```

The desk is a page, not an API client, so a header alone would lock the operator
out of their own UI. The token can arrive once in the URL, which is exchanged
for an httpOnly cookie and stripped from the address bar — after that the
browser authenticates itself and the token is not in the page source. API
clients use `Authorization: Bearer` or `X-SA-Token`. `/api/health` stays open so
a load balancer never needs the secret.

### Portfolio — `GET /api/portfolio`

The desk holds positions but can only price them while a tab is open. Valuing
them here means the number survives the browser, the loop can report P&L on a
schedule (`portfolio` action), and "how's my portfolio doing" has a real answer.

```bash
curl -X PUT localhost:8787/api/portfolio -H 'Content-Type: application/json' \
  -d '{"positions":[{"sym":"NVDA","shares":10,"cost":118.40}]}'
curl 'localhost:8787/api/portfolio?markdown=1'
```

Each position is priced independently, so one unreachable symbol costs that row
rather than the whole valuation. Anything that could not be priced is listed in
`incomplete` and **excluded from the totals** rather than silently counted as
zero — a partial valuation that looks complete is worse than no valuation.

### Being scored — `GET /api/predictions`

Until now the signal engine emitted calls into the void: a BUY with a
conviction letter, and nothing that ever went back to check. The ledger closes
that loop. The approach is adapted from the
[FinSurfing](https://github.com/surfingalien/FinSurfing) brain's learning cycle,
whose discipline is the valuable part:

- **Resolve at the exact horizon.** The bar closest to +7 and +30 days from the
  call, not whatever the price happens to be when the job runs.
- **A fill that never happened is not a win.** If price never traded into the
  entry zone, the call is excluded from the win rate however well the symbol did
  afterwards — and the fill rate is reported separately, because a strategy
  whose entries rarely fill can look accurate while being untradeable.
- **Measure against a benchmark.** Up 4% in a week the index rose 6% is not
  skill, and the card says so.
- **Compute the statistics in code.** A model may read the scorecard aloud; it
  may not produce it.

```bash
curl 'localhost:8787/api/predictions?markdown=1'
curl -X POST localhost:8787/api/predictions/resolve
```

Every actionable call from `scan watchlist` is logged automatically, and a
`score` goal action resolves and reports on a schedule. Direction is respected —
a SELL that fell is a win.

The headline number is **calibration**: if high-conviction calls do not beat
low-conviction ones, the conviction letter is decoration, and the card states
that in plain language rather than burying it.

### Analysis borrowed from FinSurfing

- **Wilder's smoothed RSI** (`rsiWilder`) alongside the desk's simple-average
  `rsi`. They genuinely disagree, so both are reported — a server number that
  silently contradicts the number on screen is worse than either definition.
- **ADX** for trend *strength*, which the score previously had no way to
  express. It now caps conviction: a weak trend is exactly when this kind of
  score is least worth acting on, and the reason is stated in the drivers.
- **Entry zones instead of point targets.** Quoting an entry to the cent
  implies a precision the rules do not have; the band is roughly half an average
  day's range.
- **Falsifiable thesis assumptions** — the two or three things that would have
  to stop being true for the call to be wrong. These are emitted *in the goal
  condition grammar*, so a thesis can be armed and alerted on when it breaks
  rather than quietly going stale:

  ```
  full equity dossier on NVDA
    → assumptions: price(NVDA) crosses below 131.4
                   rsi(NVDA) crosses above 75
    → arm either as a goal and the desk tells you when the thesis breaks
  ```

### Position sizing from measured edge — `POST /api/kelly`

Kelly sizing, ported from FinSurfing, including the point its comments are
emphatic about: **the win probability must come from measured calibration, never
from a confidence letter the same engine invented.** Feeding a model's
self-reported confidence into Kelly as a probability is the common mistake, and
it sizes positions on nothing.

That input now exists here, because the ledger measures it:

```bash
curl -X POST localhost:8787/api/kelly -H 'Content-Type: application/json' \
  -d '{"symbol":"NVDA"}'          # uses the rules engine's own target and stop
```

Two guardrails, both deliberate: half Kelly by default (full Kelly assumes the
probability is exactly right) and a hard 20% cap, because a tight stop makes
full Kelly ask for leverage. A short swaps the payoff legs rather than sizing
backwards. Until enough calls have resolved it says so — a size built on the
default probability is labelled a placeholder rather than presented as evidence.
A measured win rate of zero sizes to nothing, which is the correct answer.

Nothing here places an order.

### Personas — `GET /api/personas`

Framing that changes what the analysis looks for, not what the data says:
`neutral`, `buffett`, `burry`, `wood`, `marks`, `lynch`. Set `ANALYSIS_PERSONA`
or pass `persona` to `/api/research`.

The honesty rules are appended *after* the persona framing so they outrank it —
use only the sourced figures, mark the rest UNVERIFIED, never invent a number to
fit the style. A test asserts that ordering, because a persona that could talk
its way past the sourcing rules would be worse than no persona.

### Email — `POST /api/email`

Reports to an inbox, following FinSurfing's ladder: Resend's HTTP API first
(no dependency, so it always works here), SMTP second (`npm install nodemailer`),
and an honest dry-run log line when neither is configured — never a silent
success.

```bash
curl -X POST localhost:8787/api/email -H 'Content-Type: application/json' \
  -d '{"report":"scorecard"}'
```

An `email scorecard|portfolio|scan|digest` action mails on a schedule, so the
morning scan or the weekly scorecard arrives without asking. Reports are
generated by the same code path that serves them over HTTP, so what lands in the
inbox is what the API would have returned, rendered to HTML with everything
escaped.

### Voice booking — `POST /api/book`

The desk's `book_restaurant` tool posts here and polls
`GET /api/book/status/:sid`, and degrades to a "here is what to say, call them
yourself" script when the call cannot be placed. That degradation is right; what
was wrong is that an unimplemented route 404s, which the desk cannot tell apart
from a typo, a proxy eating the path, or a server older than the client.

So the route exists and refuses honestly, and it distinguishes three different
situations that a single `400` used to flatten together.

**Incomplete** is not malformed. A booking missing the party size is not a
client bug — it is a question nobody has asked the user yet, so the server
answers `422` with the one thing to ask next rather than a list of empty
fields:

```json
{ "stage": "incomplete", "needs": ["partySize", "when"],
  "question": "For how many people?",
  "booking": { "venue": "Nobu", "phone": "+13232970100" } }
```

One question at a time, in the order a person would ask them, with what is
already known echoed back so the caller never re-derives it. A phone number
that is present but unusable stays a `400` — no question to the user fixes
`555-CALL`.

**Complete, and the server can dial.** Placing a call to a real business is not
undoable: the restaurant's phone rings whether or not the operator meant it. So
the booking is read back and nothing happens until the same request returns
with `confirm: true`. The gate is stateless — no server-side session to expire,
to leak between users, or to disagree with itself when a second replica exists
— and only the boolean opens it, because `confirm: "yes"` is a client bug
rather than consent.

**Complete, and it cannot dial.** Answers `501` naming the three variables that
are unset, and returns the booking with a ready-to-read script:

```json
{ "ok": false, "configured": false,
  "reason": "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are unset",
  "fallback": { "venue": "Osteria Mozza", "phone": "+13232970100",
                "script": "Hi — I'd like to book a table for 4 Friday at 8pm…" } }
```

Placing the call for real is left off deliberately, and not only because it
needs credentials and a public callback URL: automated and synthetic-voice
calls to businesses are regulated differently depending on where the caller and
the callee are. `/api/config` advertises `booking.configured` so the desk knows
before it asks.

The desk drives this through a `book_restaurant` tool the server adds to the
engine (see below). Asking it to book a table produces a `Booking` message
carrying the venue, the number, a one-tap `tel:` link and the exact words to
say — posted as its own turn rather than left to the model's summary, because
the model paraphrases and the point of the fallback is the *exact* words.

### Tools the server adds to the desk

`public/index.html` stays byte-for-byte as authored, so a newer desk build can
be dropped in without a merge. The server's own tools live in
`src/desk/engine-extensions.js` and are spliced onto the end of the `#engineSrc`
block at serve time.

They go *inside* that block rather than in a script tag of their own because
the desk evaluates its engine with `new Function(src)` — the tool registry is
closure-scoped, and a separate script can only see the window. Appending to the
same source is the only way in. Registration is guarded by name, so a desk build
that already ships one of these tools keeps its own version and nothing
conflicts. If the block cannot be found, the file is served untouched rather
than spliced on a guess.

### Why it used to feel slow

The honest answer was the market feed, and it was bad: **a single quote cost
about nine seconds whenever Yahoo was gating us, and nothing remembered that**.
Every call re-walked the crumb handshake, then v7, then quoteSummary, then the
chart — each one waiting out a full timeout — so a three-ticker dossier paid it
three times over.

Four fixes, measured against an unresponsive upstream:

| | before | after |
|---|---|---|
| first quote | 9.1s | 9.1s |
| same symbol again | 9.0s | 0.0s |
| a second symbol | 9.0s | 0.0s |
| a third symbol | 9.0s | 0.0s |

- **A shorter timeout for market calls** (6s, not the generic 15s) and a budget
  for the whole fallback ladder, so one call cannot stack three timeouts.
- **Remembering which rung answered** per symbol, so a working quote does not
  pay for the failing rungs above it.
- **Remembering failures** for 30s, so the next caller does not wait out the
  same dead endpoints.
- **A circuit breaker**: several symbols failing in a row means the upstream is
  down, not the symbols, so everything fails fast until it recovers. The panel's
  FEED tile shows this, with the countdown to the next attempt.

Two more things that were on the critical path:

- **Spoken commands** no longer wait on a model for everyday phrasings.
  "how's my portfolio doing", "scan the watchlist", "tell me about nvidia" and
  friends resolve from local patterns in microseconds; the model is consulted
  only for what those cannot place.
- **Speech has a deadline** (`VOICE_DEADLINE_MS`, 2.5s). Past it the plainer
  rules script is spoken rather than leaving a silence, and the model's version
  still lands in the cache for next time.

Finally, slowness is now *attributable* rather than a feeling:

```bash
curl localhost:8787/api/diagnostics    # times each hop separately
```

Every response also carries a `Server-Timing` header, and anything past
`SLOW_REQUEST_MS` is logged with the path that caused it. The SERVER panel has a
**DIAGNOSE** button that shows the same breakdown.

If the feed is simply unreachable from where you run this, the first call still
costs one timeout — that is the price of finding out — but only the first.

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

The format is genome **v5**. Fields the server does not act on — `portfolio`
positions and the `consensus` toggle — are stored verbatim and handed back
unchanged, so a push followed by a pull never quietly loses them.

## Indicators

`src/lib/indicators.js` reimplements the engine's `computeInd` and
`localSignal` numerically identically: SMA 20/50/200, RSI(14), MACD(12,26,9),
Bollinger(20,2), ATR(14), annualized volatility, trailing returns, and the
rules-based BUY/HOLD/SELL score with its named drivers. A server-side scan and
a UI dossier therefore never disagree about the same symbol.

None of this is financial advice — it is a transparent scoring rule, and the UI
says so on every dossier.

## Deploying

What this needs is unusual enough to rule out a whole class of hosting, so the
requirements come first:

| Requirement | Why |
|---|---|
| A process that stays alive | The autonomy loop only fires while something is running. A host that sleeps means goals silently do not fire. |
| A persistent disk | Goals, memory and the prediction ledger live in `data/`. An ephemeral filesystem resets the scorecard on every deploy. |
| Exactly one replica | Two instances means two loops firing the same goals — duplicate alerts, duplicate ledger entries. |
| Outbound HTTPS | Yahoo, your model provider, Resend, your webhook. |
| Node 20+ | One runtime dependency, no build step. |

| Platform | Verdict |
|---|---|
| **Railway** | Recommended, and `railway.toml` + `Dockerfile` are included. Always-on, volumes, and what FinSurfing already deploys to. |
| **Fly.io** | Good — persistent volumes and a long-lived process. |
| **Render** | Works on a paid instance. The free tier sleeps, which stops the loop, and disks need a paid plan. |
| **A small VPS / any Docker host** | Fine. `Dockerfile` included; mount a volume at `/data`. |
| **Vercel · Netlify · Cloudflare Workers** | **No.** Serverless has no long-lived process and no writable disk, so the autonomy loop and the ledger cannot work. The desk is static enough to host there, but the agent behind it is the point. |

### Railway, start to finish

```bash
# 1. Deploy from the repo — railway.toml selects the Dockerfile build.
# 2. Add a volume mounted at /data, then set:
STATE_FILE=/data/state.json
PREDICTIONS_FILE=/data/predictions.jsonl
# 3. Set the secrets you actually want:
API_TOKEN=$(openssl rand -hex 24)   # required once it is public
BRAIN_BASE=...  BRAIN_KEY=...
RESEND_API_KEY=...  EMAIL_TO=...
NOTIFY_WEBHOOK=...
# 4. Confirm from the deployed shell:
npm run preflight -- --send
```

**Do not add a `VOLUME` instruction to the Dockerfile.** Railway's builder
rejects the whole Dockerfile if it finds one (`dockerfile invalid: docker
VOLUME at Line …`), and it buys nothing — Railway mounts the volume you attach
in its UI, and `docker run -v host:/data` works the same without it. The repo
ships exactly one build definition for the same reason: a `Dockerfile` at the
root takes precedence on Railway regardless of what `builder` says, so
`railway.toml` names `DOCKERFILE` rather than quietly disagreeing with the
build that actually runs.

**The volume is the part people skip.** Without it every deploy starts from an
empty `data/`, so armed goals vanish and the prediction ledger restarts — which
does not look like data loss, it looks like the scorecard mysteriously refusing
to accumulate.

`/api/health` sits outside the auth check so a platform probe never needs the
token. Everything else is closed once `API_TOKEN` is set, and the server warns
at boot if it is listening off-loopback without one.

### Verifying a deployment — `npm run preflight`

Everything in this server that can fail without being broken fails for one of
two reasons: a host it cannot reach, or a credential it does not have. One
command separates them:

```bash
npm run preflight            # check every configured dependency
npm run preflight -- --send  # also deliver a real test email and alert
```

```
✓ Market feed · chart      320 bars · last 227.60 · RSI 62.1 · BULL
✓ Market feed · quote      via v7 · Apple Inc. 227.60
○ Model brain              — not configured
✓ Email                    test message delivered to you@example.com via resend
✓ Alert webhook            test alert delivered
```

Two distinctions it makes on purpose:

- **Not configured is not broken.** An unset provider is reported as skipped
  with the variable that would enable it. Only things that are set up *and*
  failing count against the exit code, so this can gate a deploy.
- **A blocked host is not a rejected credential.** A network policy in front of
  an allowlist answers `403` from somewhere that is not the destination, and it
  answers instantly. Read literally that looks like the API refusing your key,
  so the natural response is to regenerate keys for a request that never left
  the building. When a refusal arrives faster than a real round trip could
  complete, preflight says so:

  ```
  ✗ Market feed · chart
        HTTP 403
        This looks like a network policy refusing query1.finance.yahoo.com before
        the request left your network — not the service rejecting your credentials.
  ```

  `/api/diagnostics` applies the same reading, so the SERVER panel's DIAGNOSE
  button gives the same answer.

### Verifying the feed for real

Yahoo's endpoints are unofficial: they rate-limit, gate on crumbs, and change
shape without notice. The test suite pins everything on this side of that
boundary — the parser against holiday gaps, the indicators for scale, and all
three quote fallbacks — using a stub. What it cannot answer is whether Yahoo
still replies the way it used to.

```bash
node scripts/verify-feed.js NVDA AAPL
```

That runs the real chain against the live endpoints and checks the results are
plausible rather than merely present: RSI within 0–100, moving averages on the
same scale as price, the quote agreeing with the last chart bar, and a signal
carrying its reasons. It exits non-zero on failure, so it can gate a deploy.
Run it on a machine with open egress before trusting a dossier's numbers.

## Configuration

Every knob lives in `.env.example` with a comment. The ones that matter:

| Variable | Default | Why you would change it |
|---|---|---|
| `PORT` | `8787` | the port the desk's Settings panel suggests |
| `BRAIN_BASE` / `BRAIN_KEY` / `BRAIN_MODEL` | empty / empty / `gpt-4o-mini` | enables the brain proxy and server-side synthesis |
| `NOTIFY_WEBHOOK` | empty | where alerts go |
| `AUTONOMY_ENABLED` / `AUTONOMY_TICK_MS` | `true` / `30000` | loop on/off and how often it wakes |
| `ALLOW_PRIVATE_EGRESS` | `false` | local dev against a private host |
| `API_TOKEN` / `PROXY_TOKEN` | empty | required before this binds anywhere routable; the desk's panel uses the second name |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | empty | all three set means voice booking is possible at all |
| `NOTIFY_VOICE` | `true` | rewrite alerts into one readable line |
| `YAHOO_BASE` | Yahoo | a mirror, a replay, or a stub |
| `CORS_ORIGINS` | empty | serving the HTML from another origin |

## Layout

```
public/index.html      the desk, exactly as authored
public/desk-server.js  SERVER panel: runtime status, goals, activity, sync
src/server.js          boot, graceful shutdown
src/app.js             routes, CORS, error handling
src/ui.js              serves the desk with defaults and server tools injected
src/desk/              tools spliced into the desk engine's own scope
src/config.js          env-driven configuration
src/routes/            fetch · notify · yahoo · brain · autonomy · genome · voice
                       portfolio · predictions · analysis · book
src/market/yahoo.js    feed with crumb handling and fallbacks
src/autonomy/          store · conditions · actions · engine · research
src/lib/               safeFetch · auth · indicators · predictions · kelly · personas
                       email · speech · voiceBrief · portfolio · intent · notify
scripts/validate.js    boot a real server against stubs and walk every route
scripts/verify-feed.js check the live Yahoo chain end to end
test/                  185 tests, no network required
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
