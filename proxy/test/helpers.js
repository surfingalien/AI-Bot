"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const { loadConfig } = require("../src/config");
const { createApp } = require("../src/app");
const { hashPassword } = require("../src/users");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-"));
}

/** Seed a data dir with users.json before the app boots. */
function seedUsers(dir, users) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "users.json"),
    JSON.stringify(
      users.map((u) => ({ user: u.user, hash: hashPassword(u.pass), role: u.role || "user" })),
      null,
      2
    )
  );
}

/** Boot the app on an ephemeral port with an isolated data dir. */
async function boot(env = {}, deps = {}) {
  const dir = env.DATA_DIR || tmpDir();
  const config = loadConfig({ DATA_DIR: dir, ...env });
  const ctx = createApp(config, deps);
  const server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    ...ctx,
    config,
    server,
    base,
    dir,
    async close() {
      ctx.hub.closeAll();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Minimal fetch wrapper that always returns { status, body }. */
async function call(base, pathname, { method = "GET", token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(base + pathname, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

async function login(base, user, pass) {
  const r = await call(base, "/api/login", { method: "POST", body: { user, pass } });
  if (r.status !== 200) throw new Error("login failed for " + user + ": " + JSON.stringify(r.body));
  return r.body;
}

/**
 * An upstream stub. `script` is a list of assistant messages; anything past the
 * end resolves to a plain text answer so the loop always terminates.
 */
function scriptedUpstream(script = []) {
  let i = 0;
  const calls = [];
  const fn = async (messages) => {
    calls.push(messages.map((m) => ({ role: m.role, content: m.content })));
    const msg = script[i++] || { content: "done" };
    return { choices: [{ message: msg }] };
  };
  fn.calls = calls;
  return fn;
}

/** Build an assistant message that invokes one tool. */
function toolCall(name, args, id = "call_" + name) {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

/**
 * An upstream that calls one tool then answers — for *every* agent run, not
 * just the first, since each run starts from a fresh message list.
 */
function toolUpstream(name, args, answer = "done") {
  return async (messages) => {
    const alreadyRan = messages.some((m) => m.role === "tool");
    return {
      choices: [{ message: alreadyRan ? { role: "assistant", content: answer } : toolCall(name, args) }],
    };
  };
}

/**
 * Open an SSE connection and collect events until `stop()` is called.
 * Returns { events, stop }.
 */
async function openStream(base, token) {
  const ctl = new AbortController();
  const url = base + "/api/events" + (token ? "?token=" + encodeURIComponent(token) : "");
  const res = await fetch(url, { signal: ctl.signal });
  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (line) {
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    events,
    status: res.status,
    async stop() {
      ctl.abort();
      await pump;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `fn()` is truthy, or throw after `timeout` ms. */
async function until(fn, timeout = 2000, step = 20) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(step);
  }
}

module.exports = {
  tmpDir, seedUsers, boot, call, login,
  scriptedUpstream, toolCall, toolUpstream,
  openStream, sleep, until,
};
