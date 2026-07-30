# web/

Static UIs, served by the `web` nginx service on **:8080**.

`index.html` is the launcher and is the only file tracked here. Drop your three
saved single-file UIs alongside it:

| File            | What it is                                          |
|-----------------|-----------------------------------------------------|
| `hud.html`      | the Orbital OS assistant (works with nothing running) |
| `deck.html`     | the live control room (login gate + SSE feed)        |
| `manifest.html` | the install runbook with the preflight probe         |

They are not committed here — they are large generated single-file artifacts and
the backend does not depend on any of them. Commit them yourself if you want
them versioned; nothing ignores them.

Check `../docs/REVIEW.md` before you drop them in: `manifest.html` has a
one-character bug that freezes its boot log, and `forge.html` has one that
disables its whole script.

## Pointing the UIs at the API

nginx reverse-proxies `/api/*` to the proxy container (see `../nginx.conf`), so
the UIs are **same-origin** with the API:

- base URL: `http://localhost:8080` (not `:8787`)
- CORS never comes into play, so `ALLOWED_ORIGINS` can stay tight
- SSE works through nginx because `proxy_buffering` is off for `/api/`

If you run the proxy directly with `npm start` and serve these files from some
other static server, use `http://localhost:8787` as the base instead and keep
`ALLOWED_ORIGINS=*` (or list that origin explicitly).

## Auth, from the UI side

- **session mode** (one brain per person): the deck's *use credentials* path posts
  to `/api/login` and stores the returned session token.
- **token mode**: paste `API_TOKEN` into the deck's token field, and into the HUD's
  key field when the HUD is in proxy mode. It is the bearer token, not the model key.
- **open mode**: everyone shares the single `anon` brain. Local use only.
