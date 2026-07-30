"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { boot, seedUsers, call, login, tmpDir, openStream, until } = require("./helpers");
const { tenantId } = require("../src/ids");

test("an unlocked box collapses to one shared anon tenant", async (t) => {
  const srv = await boot({ DATA_DIR: tmpDir() });
  t.after(() => srv.close());

  const health = await call(srv.base, "/api/health");
  assert.equal(health.body.auth.required, false);

  const me = await call(srv.base, "/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.who.mode, "open");
  assert.equal(me.body.who.tenantId, "anon");
});

test("with users provisioned, every scoped route requires a token", async (t) => {
  const dir = tmpDir();
  seedUsers(dir, [{ user: "ada", pass: "ada-password" }]);
  const srv = await boot({ DATA_DIR: dir });
  t.after(() => srv.close());

  for (const p of ["/api/me", "/api/brain", "/api/reminders", "/api/audit", "/api/events", "/api/users"]) {
    const r = await call(srv.base, p);
    assert.equal(r.status, 401, p + " must be gated");
  }
  assert.equal((await call(srv.base, "/api/agent", { method: "POST", body: { input: "hi" } })).status, 401);
  assert.equal((await call(srv.base, "/api/health")).status, 200, "health stays public");
});

test("the static API_TOKEN maps to the service tenant", async (t) => {
  const srv = await boot({ DATA_DIR: tmpDir(), API_TOKEN: "s3rvice-token-value" });
  t.after(() => srv.close());

  assert.equal((await call(srv.base, "/api/me")).status, 401);
  const me = await call(srv.base, "/api/me", { token: "s3rvice-token-value" });
  assert.equal(me.status, 200);
  assert.equal(me.body.who.mode, "token");
  assert.equal(me.body.who.tenantId, "service");
  assert.equal((await call(srv.base, "/api/me", { token: "s3rvice-token-valuX" })).status, 401);
});

test("a bearer token is not accepted from the query string outside SSE", async (t) => {
  const dir = tmpDir();
  seedUsers(dir, [{ user: "ada", pass: "ada-password" }]);
  const srv = await boot({ DATA_DIR: dir });
  t.after(() => srv.close());

  const ada = await login(srv.base, "ada", "ada-password");
  const viaQuery = await call(srv.base, "/api/brain?token=" + encodeURIComponent(ada.token));
  assert.equal(viaQuery.status, 401, "query tokens leak into logs; only EventSource may use them");

  const stream = await openStream(srv.base, ada.token);
  t.after(() => stream.stop());
  assert.equal(stream.status, 200, "EventSource cannot set headers, so /api/events accepts ?token=");
});

test("only admins and the service token can manage users", async (t) => {
  const dir = tmpDir();
  seedUsers(dir, [
    { user: "ada", pass: "ada-password", role: "admin" },
    { user: "lin", pass: "lin-password", role: "user" },
  ]);
  const srv = await boot({ DATA_DIR: dir });
  t.after(() => srv.close());

  const ada = await login(srv.base, "ada", "ada-password");
  const lin = await login(srv.base, "lin", "lin-password");

  assert.equal((await call(srv.base, "/api/users", { token: lin.token })).status, 403);
  assert.equal(
    (await call(srv.base, "/api/users", { method: "POST", token: lin.token, body: { user: "x", pass: "12345678" } }))
      .status,
    403
  );
  assert.equal((await call(srv.base, "/api/users", { token: ada.token })).status, 200);

  const created = await call(srv.base, "/api/users", {
    method: "POST",
    token: ada.token,
    body: { user: "nova", pass: "nova-password" },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.userId, tenantId("nova"));

  // The password is never stored in the clear.
  const raw = fs.readFileSync(path.join(dir, "users.json"), "utf8");
  assert.ok(!raw.includes("nova-password"));
  assert.ok(raw.includes("scrypt$"));

  const nova = await login(srv.base, "nova", "nova-password");
  assert.equal(nova.role, "user");

  assert.equal(
    (await call(srv.base, "/api/users", { method: "POST", token: ada.token, body: { user: "nova", pass: "another1" } }))
      .status,
    409
  );
  assert.equal(
    (await call(srv.base, "/api/users", { method: "POST", token: ada.token, body: { user: "tiny", pass: "short" } }))
      .status,
    400,
    "short passwords are rejected"
  );
});

test("deleting a user immediately kills their live sessions", async (t) => {
  const dir = tmpDir();
  seedUsers(dir, [
    { user: "ada", pass: "ada-password", role: "admin" },
    { user: "lin", pass: "lin-password" },
  ]);
  const srv = await boot({ DATA_DIR: dir });
  t.after(() => srv.close());

  const ada = await login(srv.base, "ada", "ada-password");
  const lin = await login(srv.base, "lin", "lin-password");
  assert.equal((await call(srv.base, "/api/me", { token: lin.token })).status, 200);

  const del = await call(srv.base, "/api/users/lin", { method: "DELETE", token: ada.token });
  assert.equal(del.status, 200);
  assert.equal(del.body.sessionsRevoked, 1);

  assert.equal(
    (await call(srv.base, "/api/me", { token: lin.token })).status,
    401,
    "a deleted user must not survive on an unexpired session token"
  );
  assert.equal((await call(srv.base, "/api/me", { token: ada.token })).status, 200);
  assert.equal((await call(srv.base, "/api/users/ghost", { method: "DELETE", token: ada.token })).status, 404);
});

test("brains survive user deletion unless PURGE_BRAIN_ON_USER_DELETE is set", async (t) => {
  const mk = async (purge) => {
    const dir = tmpDir();
    seedUsers(dir, [
      { user: "ada", pass: "ada-password", role: "admin" },
      { user: "lin", pass: "lin-password" },
    ]);
    const srv = await boot(purge ? { DATA_DIR: dir, PURGE_BRAIN_ON_USER_DELETE: "1" } : { DATA_DIR: dir });
    const ada = await login(srv.base, "ada", "ada-password");
    const lin = await login(srv.base, "lin", "lin-password");
    await call(srv.base, "/api/brain", { method: "DELETE", token: lin.token }); // forces a write
    assert.ok(fs.existsSync(path.join(dir, "users", lin.userId, "brain.json")));
    await call(srv.base, "/api/users/lin", { method: "DELETE", token: ada.token });
    const exists = fs.existsSync(path.join(dir, "users", lin.userId, "brain.json"));
    await srv.close();
    return exists;
  };
  assert.equal(await mk(false), true, "default keeps the data");
  assert.equal(await mk(true), false, "opt-in purges it");
});

test("login attempts are rate limited independently of the global limiter", async (t) => {
  const dir = tmpDir();
  seedUsers(dir, [{ user: "ada", pass: "ada-password" }]);
  const srv = await boot({ DATA_DIR: dir, LOGIN_RATE_LIMIT_MAX: "3" });
  t.after(() => srv.close());

  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const r = await call(srv.base, "/api/login", { method: "POST", body: { user: "ada", pass: "wrong" } });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
  assert.deepEqual(statuses.slice(3), [429, 429], "brute force is throttled");
});

test("the raw /v1 passthrough is off unless explicitly enabled", async (t) => {
  const off = await boot({ DATA_DIR: tmpDir() });
  t.after(() => off.close());
  const r = await call(off.base, "/v1/chat/completions", { method: "POST", body: { model: "x", messages: [] } });
  assert.equal(r.status, 404, "the key-bearing passthrough must be opt-in");
});

test("expired sessions stop working", async (t) => {
  const dir = tmpDir();
  seedUsers(dir, [{ user: "ada", pass: "ada-password" }]);
  const srv = await boot({ DATA_DIR: dir, SESSION_TTL_MIN: "0" });
  t.after(() => srv.close());

  const ada = await login(srv.base, "ada", "ada-password");
  await until(async () => (await call(srv.base, "/api/me", { token: ada.token })).status === 401, 1000);
});
