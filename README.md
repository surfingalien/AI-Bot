# AI-Bot — SurfingAlien AI

A multi-tenant assistant backend: one isolated brain per principal, an
OpenAI-compatible tool loop, scoped server-sent events, and server-pushed
reminders that survive a restart.

The model key only ever lives on the server.

```
AI-Bot/
├── docker-compose.yml     # proxy + nginx (serves the UIs, reverse-proxies /api)
├── nginx.conf
├── proxy/                 # the backend
│   ├── server.js          # boot: sweep tenants, start timers, listen
│   ├── src/
│   │   ├── config.js      # env -> config (pure, so tests can inject)
│   │   ├── ids.js         # username -> collision-free tenant id
│   │   ├── store.js       # per-tenant brains, atomic writes, bounded cache
│   │   ├── users.js       # users.json, scrypt hashing, hot reload
│   │   ├── hub.js         # per-tenant SSE fan-out + audit ring
│   │   ├── util.js        # calc / convert / natural-language time
│   │   ├── tools.js       # the tool definitions, all tenant-bound
│   │   ├── agent.js       # the tool loop
│   │   ├── offline.js     # intent rules for when no model key is set
│   │   └── app.js         # express app, auth, routes, schedulers
│   └── test/              # 39 tests, incl. the isolation guarantees
├── web/                   # static UIs on :8080 (launcher + your hud/deck/manifest)
└── docs/REVIEW.md         # findings from reviewing the original single-file draft
```

## Quick start

```bash
cp proxy/.env.example proxy/.env     # edit: provider, model key, auth mode
docker compose up -d --build
open http://localhost:8080           # UIs; the API is same-origin at /api/*
```

Without Docker:

```bash
cd proxy && npm install && npm start          # API on :8787
cd .. && npx --yes serve -l 8080 web          # UIs on :8080
```

## The offline brain

With no `OPENAI_API_KEY` the server is still useful. There is no model to plan
tool calls, so a small set of intent rules drives the same tools directly:

```
remember the launch is Oct 3        recall launch
add task book the room for ada      list tasks        complete <id>
remind me to check the deck in 10 minutes             5 km to mi
remind me to ship tomorrow at 3pm                     18450 * 1.07
search orbital mechanics            schedule demo tomorrow at 3pm
```

Memory persists, reminders arm and fire over SSE, and everything survives a
restart. Anything it does not recognise gets an honest "no model key is
configured" rather than an invented answer. Set a key and the model takes over
tool selection; the tools themselves are identical.

## Per-user brains

Each principal gets `data/users/<tenantId>/brain.json`, lazy-loaded into a
bounded cache and written atomically. Identity comes from auth:

| Auth                        | Tenant                            | Use it for    |
|-----------------------------|-----------------------------------|---------------|
| credential login            | `<name>-<digest>`, one per person | actual humans |
| static `API_TOKEN`          | `service` (one shared brain)      | machines, CI  |
| nothing set (open box)      | `anon` (one shared brain)         | your laptop   |

The tenant id is a readable slug plus an 8-hex digest of the *original*
username. The digest is not decoration: `a.b`, `a/b` and `a_b` all slugify to
`a_b`, and without it two different people would silently share one brain.

Every route — `/api/agent`, `/api/brain`, `/api/reminders`, `/api/audit`,
`/api/me`, `/api/presence` and the `/api/events` stream — is scoped to the
caller. A boot sweep loads every tenant directory so pending reminders are
re-armed before the scheduler starts ticking.

**Open mode is not multi-user.** With no token and no users, every caller is
`anon` and shares one brain. The server says so loudly at boot.

## Managing users

`data/users.json` is hot-reloaded on mtime change. Bootstrap it once with
`ADMIN_USER`/`ADMIN_PASS` (hashed on the way in), then:

```bash
TOKEN=...        # an admin session token, or API_TOKEN

curl -X POST localhost:8080/api/users -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"user":"nova","pass":"a-real-password","role":"user"}'

curl            localhost:8080/api/users        -H "Authorization: Bearer $TOKEN"
curl -X DELETE  localhost:8080/api/users/nova   -H "Authorization: Bearer $TOKEN"
```

Passwords are stored as salted scrypt hashes. Legacy plaintext `pass` records —
including a hand-written `users.json` copied from `users.example.json` — still
authenticate, and are rewritten as hashes on the first successful login.

Deleting a user revokes their live sessions immediately. Their brain is left on
disk unless `PURGE_BRAIN_ON_USER_DELETE=1`.

## API

| Method | Route                | Notes                                      |
|--------|----------------------|--------------------------------------------|
| GET    | `/api/health`        | public                                     |
| POST   | `/api/login`         | public, separately rate limited            |
| POST   | `/api/logout`        |                                            |
| GET    | `/api/me`            | principal + presence + stats               |
| GET    | `/api/brain`         | the caller's brain                         |
| DELETE | `/api/brain`         | wipe the caller's brain                    |
| GET    | `/api/reminders`     | the caller's pending reminders             |
| GET    | `/api/audit`         | the caller's last 100 audit entries        |
| POST   | `/api/agent`         | run the tool loop as the caller            |
| GET    | `/api/events`        | SSE, scoped; accepts `?token=` (see below) |
| GET    | `/api/users`         | admin / service token                      |
| POST   | `/api/users`         | admin / service token                      |
| DELETE | `/api/users/:user`   | admin / service token                      |

Bearer tokens are read from the `Authorization` header. `/api/events` is the one
exception that accepts `?token=` — `EventSource` cannot set headers — and query
tokens are rejected everywhere else, because they end up in access logs and
`Referer` headers.

`POST /v1/chat/completions` is a raw passthrough that hands the server's model
key to any authenticated caller. It is **off** unless `ENABLE_RAW_PASSTHROUGH=1`.

## Verify

```bash
curl -s localhost:8080/api/health
curl -N "localhost:8080/api/events?token=$TOKEN"
curl -X POST localhost:8080/api/agent -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"input":"remember the launch is Oct 3, then arm a 15 second reminder"}'
```

## Tests

```bash
cd proxy && npm test
```

39 tests covering tenant-id collisions, per-route isolation, SSE scoping,
multi-device delivery, boot-sweep re-arming, auth modes, session revocation,
password hashing and migration, atomic/corrupt-brain handling, and the tools.

## Deploying beyond localhost

Not done for you, and worth doing before this faces a network:

- **TLS + a real reverse proxy.** Session tokens are bearer tokens in JS; over
  plain HTTP they are readable in transit.
- **`ALLOWED_ORIGINS`** — set it to your actual UI origin. The nginx setup here
  already makes the UIs same-origin, so this can just be your own host.
- **`TRUST_PROXY=1`** behind a proxy, or per-IP rate limiting sees only the
  proxy's address and becomes one shared global bucket.
- **Sessions are in memory.** A restart logs everyone out; that is a deliberate
  trade, not an oversight. Persist them (or move to httpOnly cookies) if it
  matters.
