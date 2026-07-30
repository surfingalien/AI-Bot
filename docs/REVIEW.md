# Review of the single-file draft

Findings from reading the `proxy/server.js` you pasted (and the two HTML
artifacts), and what this repo does instead. Ordered by severity.

Nothing here is a criticism of the design — the architecture is sound and this
repo keeps it. These are the places where the implementation did not deliver
what the design promised.

---

## Isolation bugs — the ones that undercut the whole feature

### 1. Two different users could share one brain

```js
const sanitize = id => (String(id).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "anon");
```

`sanitize` is not injective. `a.b` survives unchanged, but `a/b`, `a b` and
`a+b` all become `a_b` — so a user literally named `a_b` and a user named `a b`
resolve to the same `data/users/a_b/brain.json`. Both read and write each
other's memory, tasks and reminders. That is the exact failure the feature
exists to prevent, and it is silent.

The `.slice(0, 64)` truncation is a second collision source: two long usernames
sharing a 64-character prefix collide too.

**Now:** `ids.js` appends an 8-hex SHA-256 digest of the *original* username, so
the id is `ada-1f4c9b02`. The slug stays readable; the digest guarantees
distinctness. Covered by `test/isolation.test.js`.

### 2. Deleting a user did not log them out

`DELETE /api/users/:user` rewrote `users.json`, but sessions live in a separate
in-memory map keyed by token. A deleted user kept full access to their brain and
every route until their session TTL expired — by default **12 hours**.

**Now:** deletion calls `sessions.revokeUser(name)` and reports how many were
killed. Covered by a test that asserts the deleted user's token 401s on the next
request.

### 3. Query-string tokens were accepted everywhere

```js
const extractToken = req => { ... return b || (req.query && req.query.token) || ""; };
```

Only `EventSource` needs this, because it cannot set headers. Accepting
`?token=` on every route puts session tokens into nginx access logs, browser
history, and the `Referer` header of any outbound link.

**Now:** the query fallback is scoped to `/api/events` alone; a token in the
query anywhere else is ignored and the request 401s.

---

## Data-integrity bugs

### 4. A malformed `users.json` deleted every user

```js
try { ...JSON.parse(fs.readFileSync(USERS_FILE)) }
catch {
  if (ADMIN_USER && ADMIN_PASS && usersCache.list.length === 0) {
    usersCache.list = [{ user: ADMIN_USER, ... }];
    fs.writeFileSync(USERS_FILE, ...);   // overwrites the file you just broke
  }
}
```

The catch does not distinguish "file missing" from "file has a trailing comma".
Since `getUsers()` is called on every request through `authRequired()`, a stray
character in `users.json` after a restart wipes it and replaces it with the
single bootstrap admin. The hot-reload feature is what makes this reachable —
you are *expected* to hand-edit that file.

**Now:** only `ENOENT` triggers the bootstrap. A parse failure logs and keeps
serving the last good list, and never writes. Covered by a test that asserts the
broken file is left byte-for-byte intact.

### 5. Brain writes were not atomic

`fs.writeFileSync(brain.json, ...)` truncates first. A crash, an OOM kill or a
full disk mid-write leaves a truncated file; on the next boot the `catch` in
`loadUser` swallows the parse error and hands back an **empty brain** — silent
total data loss for that tenant.

**Now:** write to `brain.json.tmp-xxxx` then `rename()` (atomic on the same
filesystem). And an unreadable brain is renamed to `brain.json.corrupt-<ts>`
rather than being overwritten on the next save, so it stays recoverable.

### 6. Cache eviction vs. the reminder scheduler

The draft's `cache` grew without bound — every tenant that ever logged in stayed
in memory forever, along with their `audit` ring. Adding a plain LRU is the
obvious fix, and it is a trap: the scheduler only walks *loaded* brains, so
evicting a tenant silently disarms their pending reminders.

**Now:** the cache is bounded (`MAX_TENANTS_CACHED`) and eviction skips any
tenant holding a pending reminder. Covered by a test.

---

## Auth weaknesses

### 7. Passwords were stored and compared in plaintext

```js
const findUser = (u, p) => getUsers().find(x => x.user === u && x.pass === p);
```

`users.json` sat next to `brain.json` in the same Docker volume with every
password in the clear, and `===` on a secret is a timing oracle.

**Now:** salted scrypt (`scrypt$N$r$p$salt$hash`) with `timingSafeEqual`.
Plaintext records still authenticate and are **upgraded to a hash in place on
the first successful login**, so an existing `users.json` keeps working. Unknown
usernames still pay the hashing cost, so the endpoint does not leak which
accounts exist.

### 8. No brute-force protection on `/api/login`

`/api/login` was in the `SKIP` set and only saw the shared 120-req/min bucket,
which a password-guessing loop barely notices.

**Now:** a separate 10-per-5-minutes limiter (`LOGIN_RATE_LIMIT_MAX`) on top of
the global one.

### 9. Rate limiting counted the wrong IP behind a proxy

`req.ip` without `app.set("trust proxy", …)` returns the *nginx* address for
every request. All users share one 120/min bucket, so one noisy client
rate-limits everyone.

**Now:** `TRUST_PROXY` config, set to `1` for the compose stack, and nginx
forwards `X-Forwarded-For`.

### 10. The raw `/v1/chat/completions` passthrough

It forwards an arbitrary body upstream with the server's key attached. In open
mode — the default — anyone who can reach the port gets free use of your API
key, with no tool loop and no audit trail.

**Now:** off unless `ENABLE_RAW_PASSTHROUGH=1`, and documented as what it is.

---

## Correctness nits

### 11. `convert` crossed unit families

`UNITS` mixes length, mass and volume in one table with no family check, so
`5 kg to mi` returned `0.0000031 mi` instead of refusing. Confidently wrong
beats an error message only if it is right.

**Now:** a `FAMILY` map gates the conversion.

### 12. `calc` accepted unbalanced parentheses

`"(1 + 2"` popped an empty operator stack and returned `3`. Now returns `null`.

### 13. `schedule_reminder` armed anything

`+a.seconds` on `"abc"` gives `NaN`, and `fireAt: NaN` compares false against
every `<=`, so the reminder is stored, never fires, and is never cleaned up. A
negative value fires instantly; `1e15` arms something for the year 33658.

**Now:** finite, non-negative, and bounded by `MAX_REMINDER_SECONDS`; invalid
input returns an error string and persists nothing.

### 14. Client history was forwarded to the model unfiltered

`history.slice(-6)` passed whatever the client sent, including `role: "system"`
and forged `role: "tool"` messages — a free prompt-injection channel from the
browser.

**Now:** `sanitizeHistory` keeps only `user`/`assistant` string content, capped
at 8000 characters each.

### 15. Failed tools were counted as used

`used.push(tool.name)` ran before the result was checked, so a tool that threw
still showed up in the "Done. …" summary. Now only successful calls are counted.

### 16. Upstream calls had no timeout

A hung provider held the request, the express connection and the tool loop
indefinitely. Now `UPSTREAM_TIMEOUT_MS` (60s default) via `AbortController`.

### 17. The "offline brain" did not exist

Both the README and the manifest state that a blank `OPENAI_API_KEY` leaves a
working server — "memory, tasks, reminders and compute still work; only
free-form model answers are skipped". The code does not do that:

```js
async function callUpstream(messages) {
  if (!KEY) throw new Error("OPENAI_API_KEY not configured");
```

`runAgentLoop` calls `callUpstream` first, and it is the only path that reaches
any tool. With no key, `POST /api/agent` returns **502 on every request** and
nothing can be stored. There are no REST endpoints that write memory, tasks or
reminders either — the agent is the only writer — so the advertised offline
server can do precisely nothing. Only the HUD is genuinely offline-capable,
because it keeps its own brain in `localStorage`.

This is the one finding where the fix was to build the missing thing rather than
correct the claim, since the claim shapes the whole "try it before you sort out
billing" onboarding path.

**Now:** `src/offline.js` matches a small set of intents (remember / recall /
add task / list tasks / complete / remind me in N / bare arithmetic and unit
conversions) and drives the same tools directly when no key is set. Unmatched
input says so plainly instead of inventing an answer. Verified end-to-end: with
`OPENAI_API_KEY` blank, memory persists, reminders arm, fire over SSE, and
survive a restart.

### 18. Smaller things

- No `SIGTERM` handler: `docker compose down` killed in-flight writes. Added.
- SSE heartbeat intervals were never `unref`'d, and `closeAll` did not exist, so
  the process would not exit cleanly.
- The stats pulse iterated every cached tenant every 10s including tenants with
  no listeners. Now only tenants that actually have a client.
- `/api/health` reported `stats` that the manifest's probe reads but the draft
  never sent (`j.stats.memory` etc. were always `undefined`). Health is now
  global-only and the probe's per-tenant numbers come from `/api/me`.

---

## Bugs in the two HTML artifacts

Both are worth patching in your saved copies — each one kills the entire inline
script, not just its own feature.

### `forge.html` — the drop-zone has a syntax error

```js
function addFiles(list){[...list].forEach(f=>{ ... const r=new FileReader();
  r.onload=()=>{ dropped.set(f.name,r.result); renderDrop(); toast(...) }};r.readAsText(f)})}
//                                                                       ^ extra brace
```

The `}` after the `onload` assignment closes the `forEach` callback early, so
`r.readAsText(f)` lands outside it and the file no longer parses. A parse error
takes down the whole `<script>`: no tree, no reader, no copy buttons, no
**FORGE .ZIP** — the page renders and does nothing. Delete that one brace.

### `forge.html` — invalid CSS

```css
.tnode .gi.ht{ ... border:1px solid rgba(154,167,ff,.4)}
```

`rgba(154,167,ff,.4)` is not a colour: three numbers expected, `ff` is not one.
The whole declaration is dropped, so HTML files in the tree lose their border.
Use `rgba(154,167,255,.4)`.

### `manifest.html` — assignment to a `const`

```js
const line=document.createElement('div'); ...
else{ ... line=nl; setTimeout(step,260)}     // TypeError: Assignment to constant variable
```

The typed boot log throws on the **first line break**, so the header terminal
freezes after one line — and because the throw happens inside a `setTimeout`
callback it does not stop the rest of the page, which is why it looks like a
cosmetic glitch rather than a bug. Change `const line` to `let line`.

---

## What this repo did not change

Deliberate, and worth knowing:

- **Sessions are in memory.** A restart logs everyone out. Fine for a single
  instance; not fine for more than one, and not fine if you want durability.
- **Open mode still exists** and is still the default with an empty `.env`. It
  is one shared `anon` brain, not multi-tenancy — the boot log now says so.
- **No TLS and no httpOnly cookies.** Tokens still live in JavaScript. That was
  the offered "genuine last mile" and it is still the right next step.
- **`users.json` is still a flat file.** Hot-reloading a JSON file is a fine fit
  for tens of users and the wrong one for thousands.
