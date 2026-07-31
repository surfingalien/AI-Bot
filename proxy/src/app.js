"use strict";
const crypto = require("crypto");
const express = require("express");

const { BrainStore, emptyBrain } = require("./store");
const { UserStore } = require("./users");
const { Hub } = require("./hub");
const { tenantId, SERVICE_TENANT, ANON_TENANT } = require("./ids");
const { runAgentLoop, createUpstream } = require("./agent");

const newToken = () => crypto.randomBytes(24).toString("base64url");
const startedAt = Date.now();

/* ------------------------------------------------------------------ *
 * sessions
 * ------------------------------------------------------------------ */
class SessionStore {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.map = new Map(); // token -> { user, tenantId, role, exp }
  }
  issue({ user, tenantId: tid, role }) {
    const token = newToken();
    this.map.set(token, { user, tenantId: tid, role, exp: Date.now() + this.ttlMs });
    return token;
  }
  get(token) {
    const s = this.map.get(token);
    if (!s) return null;
    if (s.exp <= Date.now()) {
      this.map.delete(token);
      return null;
    }
    return s;
  }
  revoke(token) {
    return this.map.delete(token);
  }
  /** Kill every live session belonging to a user (used on delete). */
  revokeUser(user) {
    let n = 0;
    for (const [t, s] of this.map) if (s.user === user) { this.map.delete(t); n++; }
    return n;
  }
  sweep() {
    const now = Date.now();
    for (const [t, s] of this.map) if (s.exp <= now) this.map.delete(t);
  }
}

/* ------------------------------------------------------------------ *
 * fixed-window rate limiter
 * ------------------------------------------------------------------ */
function limiter({ windowMs, max }) {
  const buckets = new Map();
  return function check(key) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) {
      b = { n: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    if (buckets.size > 10000) {
      for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
    }
    b.n++;
    return { ok: b.n <= max, retryAfter: Math.ceil((b.reset - now) / 1000) };
  };
}

/* ------------------------------------------------------------------ *
 * app
 * ------------------------------------------------------------------ */
function createApp(config, deps = {}) {
  const store = deps.store || new BrainStore({ usersDir: config.usersDir, maxTenants: config.maxTenantsCached });
  const users =
    deps.users ||
    new UserStore({
      usersFile: config.usersFile,
      dataDir: config.dataDir,
      adminUser: config.adminUser,
      adminPass: config.adminPass,
    });
  const hub = deps.hub || new Hub({ maxAuditPerTenant: config.maxAuditPerTenant });
  const sessions = deps.sessions || new SessionStore(config.sessionTtlMs);
  // null upstream => the offline brain. Injectable so tests never need a provider.
  const upstream = deps.upstream || (config.apiKey ? createUpstream(config) : null);

  const rateCheck = limiter(config.rateLimit);
  const loginCheck = limiter(config.loginRateLimit);

  const app = express();
  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");

  /* ---- CORS (before body parsing so preflights are cheap) ---- */
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (config.allowedOrigins === "*") {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && config.allowedOrigins.split(",").map((s) => s.trim()).includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    const { ok, retryAfter } = rateCheck(req.ip || "unknown");
    if (!ok) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "rate limited" });
    }
    next();
  });

  /* ---- auth ---- */
  const PUBLIC = new Set(["/api/health", "/api/login"]);

  // Tokens in query strings leak into logs and Referer headers, so the query
  // fallback exists only for EventSource, which cannot set headers.
  function extractToken(req) {
    const h = req.headers.authorization || "";
    if (h.startsWith("Bearer ")) return h.slice(7).trim();
    if (req.path === "/api/events" && req.query && typeof req.query.token === "string") return req.query.token;
    return "";
  }

  function principalFor(token) {
    if (!token) return null;
    if (config.apiToken && token.length === config.apiToken.length) {
      const a = Buffer.from(token);
      const b = Buffer.from(config.apiToken);
      if (crypto.timingSafeEqual(a, b)) {
        return { mode: "token", user: "service", tenantId: SERVICE_TENANT, role: "service" };
      }
    }
    const s = sessions.get(token);
    if (s) return { mode: "session", user: s.user, tenantId: s.tenantId, role: s.role };
    return null;
  }

  const authRequired = () => !!(config.apiToken || users.count > 0);

  app.use((req, res, next) => {
    if (req.method === "OPTIONS" || PUBLIC.has(req.path)) return next();
    if (!authRequired()) {
      // Unlocked box: one shared anon tenant. Not multi-user, and honest about it.
      req.who = { mode: "open", user: "anon", tenantId: ANON_TENANT, role: "anon" };
      req.tenantId = ANON_TENANT;
      return next();
    }
    const who = principalFor(extractToken(req));
    if (!who) return res.status(401).json({ error: "unauthorized" });
    req.who = who;
    req.tenantId = who.tenantId;
    next();
  });

  const isAdmin = (req) => req.who && (req.who.role === "admin" || req.who.mode === "token");

  const statsFor = (tid) => {
    const db = store.load(tid);
    return {
      memory: db.memory.length,
      tasks: db.tasks.length,
      reminders: (db.reminders || []).filter((r) => !r.done).length,
      clients: hub.presence(tid).count,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    };
  };

  /* ---- public ---- */
  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      model: config.model,
      base: config.baseUrl,
      hasKey: !!config.apiKey,
      tenants: store.size,
      clients: hub.size,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      auth: { required: authRequired(), modes: ["token", "session", "open"] },
    });
  });

  app.post("/api/login", (req, res) => {
    const { ok, retryAfter } = loginCheck(req.ip || "unknown");
    if (!ok) {
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "too many login attempts" });
    }
    const { user, pass } = req.body || {};
    const rec = typeof user === "string" ? users.authenticate(user, pass) : null;
    if (!rec) {
      hub.pushAudit(ANON_TENANT, "failed login " + (typeof user === "string" ? user.slice(0, 40) : "?"), "auth");
      return res.status(401).json({ error: "bad credentials" });
    }
    const tid = tenantId(rec.user);
    const role = rec.role || "user";
    const token = sessions.issue({ user: rec.user, tenantId: tid, role });
    hub.pushAudit(tid, "login " + rec.user, "auth");
    hub.broadcast(tid, "audit", { text: "login " + rec.user, kind: "auth" });
    res.json({ token, expiresIn: config.sessionTtlMs, user: rec.user, userId: tid, role });
  });

  app.post("/api/logout", (req, res) => {
    const tok = extractToken(req);
    const s = sessions.get(tok);
    if (s) {
      hub.pushAudit(s.tenantId, "logout " + s.user, "auth");
      sessions.revoke(tok);
    }
    res.json({ ok: true });
  });

  /* ---- caller-scoped reads ---- */
  app.get("/api/me", (req, res) =>
    res.json({ who: req.who, presence: hub.presence(req.tenantId), stats: statsFor(req.tenantId) })
  );
  app.get("/api/presence", (req, res) => res.json(hub.presence(req.tenantId)));
  app.get("/api/audit", (req, res) => res.json(hub.auditRing(req.tenantId).slice(-100)));
  app.get("/api/reminders", (req, res) =>
    res.json((store.load(req.tenantId).reminders || []).filter((r) => !r.done))
  );
  app.get("/api/brain", (req, res) => res.json(store.load(req.tenantId)));
  app.delete("/api/brain", (req, res) => {
    store.wipe(req.tenantId);
    hub.pushAudit(req.tenantId, "brain wiped", "system");
    hub.broadcast(req.tenantId, "system", { text: "brain wiped" });
    res.json({ ok: true });
  });

  /* ---- user management (admin session or service token) ---- */
  app.get("/api/users", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
    res.json(users.publicList());
  });

  app.post("/api/users", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const { user, pass, role } = req.body || {};
    if (typeof user !== "string" || typeof pass !== "string" || !user.trim() || !pass) {
      return res.status(400).json({ error: "user + pass required" });
    }
    if (pass.length < 8) return res.status(400).json({ error: "pass must be at least 8 characters" });
    if (role != null && !["admin", "user"].includes(role)) return res.status(400).json({ error: "bad role" });

    const created = users.add({ user: user.trim(), pass, role: role || "user" });
    if (created.error) return res.status(409).json({ error: created.error });
    hub.pushAudit(req.tenantId, "provisioned user " + created.user, "auth");
    res.json({ ok: true, ...created });
  });

  app.delete("/api/users/:user", (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "forbidden" });
    const name = req.params.user;
    if (!users.remove(name)) return res.status(404).json({ error: "no such user" });

    // A deleted user must not keep working until their session TTL expires.
    const revoked = sessions.revokeUser(name);
    const tid = tenantId(name);
    if (config.purgeBrainOnUserDelete) store.purge(tid);
    hub.pushAudit(req.tenantId, "removed user " + name, "auth");
    res.json({ ok: true, sessionsRevoked: revoked, brainPurged: !!config.purgeBrainOnUserDelete, userId: tid });
  });

  /* ---- the agent ---- */
  app.post("/api/agent", async (req, res) => {
    const input = String((req.body && req.body.input) || "").trim();
    if (!input) return res.status(400).json({ error: "input required" });
    if (input.length > 8000) return res.status(413).json({ error: "input too long" });

    hub.pushAudit(req.tenantId, "agent run: " + input.slice(0, 60), "agent");
    try {
      const out = await runAgentLoop({
        input,
        history: req.body.history,
        tenantId: req.tenantId,
        store,
        hub,
        config,
        upstream,
      });
      res.json(out);
    } catch (e) {
      res.status(502).json({ error: String((e && e.message) || e) });
    }
  });

  /* ---- scoped SSE ---- */
  app.get("/api/events", (req, res) => {
    const tid = req.tenantId;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const id = hub.add(tid, res);
    const db = store.load(tid);
    res.write(
      "data: " +
        JSON.stringify({
          type: "hello",
          ts: Date.now(),
          who: req.who,
          pending: (db.reminders || []).filter((r) => !r.done),
          audit: hub.auditRing(tid).slice(-30),
          presence: hub.presence(tid),
          stats: statsFor(tid),
        }) +
        "\n\n"
    );
    hub.broadcast(tid, "presence", hub.presence(tid));
    hub.pushAudit(tid, "client connected", "presence");

    req.on("close", () => {
      hub.drop(id);
      hub.broadcast(tid, "presence", hub.presence(tid));
      hub.pushAudit(tid, "client disconnected", "presence");
    });
  });

  /* ---- optional raw passthrough ---- */
  if (config.rawPassthrough) {
    app.post("/v1/chat/completions", async (req, res) => {
      try {
        const r = await fetch(config.baseUrl + "/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
          body: JSON.stringify(req.body || {}),
        });
        res.status(r.status).type("application/json").send(await r.text());
      } catch (e) {
        res.status(502).json({ error: String((e && e.message) || e) });
      }
    });
  }

  app.use((req, res) => res.status(404).json({ error: "not found" }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error("[error]", err && err.message);
    res.status(err && err.status === 400 ? 400 : 500).json({ error: "server error" });
  });

  return { app, store, users, hub, sessions, statsFor };
}

/* ------------------------------------------------------------------ *
 * timers
 * ------------------------------------------------------------------ */
function startSchedulers({ store, hub, sessions }, { tickMs = 1000, statsMs = 10000, sweepMs = 300000 } = {}) {
  const reminders = setInterval(() => {
    const now = Date.now();
    for (const [tid, db] of store.entries()) {
      let changed = false;
      for (const r of db.reminders || []) {
        if (!r.done && r.fireAt <= now) {
          r.done = true;
          changed = true;
          hub.broadcast(tid, "reminder", { id: r.id, text: r.text });
          hub.pushAudit(tid, "reminder fired: " + r.text, "reminder");
        }
      }
      if (changed) {
        try {
          store.save(tid);
        } catch (e) {
          console.error("[scheduler] save failed for %s: %s", tid, e.message);
        }
      }
    }
  }, tickMs);

  // Only pulse stats at tenants that are actually watching.
  const stats = setInterval(() => {
    for (const tid of hub.activeTenants()) {
      const db = store.load(tid);
      hub.broadcast(tid, "stats", {
        memory: db.memory.length,
        tasks: db.tasks.length,
        reminders: (db.reminders || []).filter((r) => !r.done).length,
        clients: hub.presence(tid).count,
      });
    }
  }, statsMs);

  const sweep = setInterval(() => sessions.sweep(), sweepMs);

  for (const t of [reminders, stats, sweep]) if (typeof t.unref === "function") t.unref();
  return () => [reminders, stats, sweep].forEach(clearInterval);
}

module.exports = { createApp, startSchedulers, SessionStore, emptyBrain };
