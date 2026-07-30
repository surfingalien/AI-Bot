"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { boot, seedUsers, call, login, toolUpstream, openStream, until, tmpDir } = require("./helpers");
const { tenantId } = require("../src/ids");

test("distinct usernames never share a tenant directory", () => {
  // "a.b" and "a_b" both slugify to "a_b"; only the digest suffix keeps them apart.
  assert.notEqual(tenantId("a.b"), tenantId("a_b"));
  assert.notEqual(tenantId("ada"), tenantId("ada "));
  assert.notEqual(tenantId("x/y"), tenantId("x_y"));
  assert.equal(tenantId("ada"), tenantId("ada")); // stable
  assert.match(tenantId("ada"), /^ada-[0-9a-f]{8}$/);
});

test("two users get separate brains on every route", async (t) => {
  const dir = tmpDir();
  seedUsers(dir, [
    { user: "ada", pass: "ada-password", role: "admin" },
    { user: "lin", pass: "lin-password" },
  ]);
  const srv = await boot(
    { DATA_DIR: dir },
    { upstream: toolUpstream("remember", { k: "launch", v: "Oct 3" }) }
  );
  t.after(() => srv.close());

  const ada = await login(srv.base, "ada", "ada-password");
  const lin = await login(srv.base, "lin", "lin-password");
  assert.notEqual(ada.userId, lin.userId);

  const run = await call(srv.base, "/api/agent", {
    method: "POST",
    token: ada.token,
    body: { input: "remember the launch date" },
  });
  assert.equal(run.status, 200);
  assert.deepEqual(run.body.used, ["remember"]);

  const a = await call(srv.base, "/api/brain", { token: ada.token });
  const l = await call(srv.base, "/api/brain", { token: lin.token });
  assert.equal(a.body.memory.length, 1);
  assert.equal(a.body.memory[0].k, "launch");
  assert.equal(l.body.memory.length, 0, "lin must not see ada's memory");

  // ...and on disk: only ada has a brain file at all.
  assert.ok(fs.existsSync(path.join(dir, "users", ada.userId, "brain.json")));
  assert.ok(!fs.existsSync(path.join(dir, "users", lin.userId, "brain.json")));

  // Wiping ada's brain leaves lin's untouched.
  await call(srv.base, "/api/agent", { method: "POST", token: lin.token, body: { input: "remember mine" } });
  assert.equal((await call(srv.base, "/api/brain", { token: lin.token })).body.memory.length, 1);
  await call(srv.base, "/api/brain", { method: "DELETE", token: ada.token });
  assert.equal((await call(srv.base, "/api/brain", { token: ada.token })).body.memory.length, 0);
  assert.equal((await call(srv.base, "/api/brain", { token: lin.token })).body.memory.length, 1);
});

test("reminders and audit are scoped to the caller", async (t) => {
  const dir = tmpDir();
  seedUsers(dir, [
    { user: "ada", pass: "ada-password" },
    { user: "lin", pass: "lin-password" },
  ]);
  const srv = await boot(
    { DATA_DIR: dir },
    { upstream: toolUpstream("schedule_reminder", { text: "check the deck", seconds: 600 }) }
  );
  t.after(() => srv.close());

  const ada = await login(srv.base, "ada", "ada-password");
  const lin = await login(srv.base, "lin", "lin-password");

  await call(srv.base, "/api/agent", { method: "POST", token: ada.token, body: { input: "remind me" } });

  const adaRem = await call(srv.base, "/api/reminders", { token: ada.token });
  const linRem = await call(srv.base, "/api/reminders", { token: lin.token });
  assert.equal(adaRem.body.length, 1);
  assert.equal(linRem.body.length, 0);

  const adaAudit = await call(srv.base, "/api/audit", { token: ada.token });
  const linAudit = await call(srv.base, "/api/audit", { token: lin.token });
  assert.ok(adaAudit.body.some((e) => /reminder armed/.test(e.text)));
  assert.ok(!linAudit.body.some((e) => /reminder armed/.test(e.text)));
});

test("SSE never crosses tenants", async (t) => {
  const dir = tmpDir();
  seedUsers(dir, [
    { user: "ada", pass: "ada-password" },
    { user: "lin", pass: "lin-password" },
  ]);
  const srv = await boot(
    { DATA_DIR: dir },
    { upstream: toolUpstream("remember", { k: "secret", v: "ada only" }) }
  );
  t.after(() => srv.close());

  const ada = await login(srv.base, "ada", "ada-password");
  const lin = await login(srv.base, "lin", "lin-password");

  const adaStream = await openStream(srv.base, ada.token);
  const linStream = await openStream(srv.base, lin.token);
  t.after(() => Promise.all([adaStream.stop(), linStream.stop()]));

  await until(() => adaStream.events.length > 0 && linStream.events.length > 0);
  const linBaseline = linStream.events.length;

  await call(srv.base, "/api/agent", { method: "POST", token: ada.token, body: { input: "remember" } });

  await until(() => adaStream.events.some((e) => e.type === "memory"));
  const adaMem = adaStream.events.find((e) => e.type === "memory");
  assert.equal(adaMem.k, "secret");

  // Lin may still receive their own presence frames, but never ada's payloads.
  assert.ok(!linStream.events.some((e) => e.type === "memory"));
  assert.ok(!linStream.events.some((e) => JSON.stringify(e).includes("ada only")));
  assert.ok(linStream.events.length >= linBaseline);
});

test("a fired reminder reaches every client of that tenant and nobody else", async (t) => {
  const dir = tmpDir();
  seedUsers(dir, [
    { user: "ada", pass: "ada-password" },
    { user: "lin", pass: "lin-password" },
  ]);
  const srv = await boot(
    { DATA_DIR: dir },
    { upstream: toolUpstream("schedule_reminder", { text: "ping", seconds: 0 }) }
  );
  t.after(() => srv.close());

  const { startSchedulers } = require("../src/app");
  const stop = startSchedulers(srv, { tickMs: 25, statsMs: 100000, sweepMs: 100000 });
  t.after(() => stop());

  const ada = await login(srv.base, "ada", "ada-password");
  const lin = await login(srv.base, "lin", "lin-password");

  const adaA = await openStream(srv.base, ada.token);
  const adaB = await openStream(srv.base, ada.token); // same user, second device
  const linS = await openStream(srv.base, lin.token);
  t.after(() => Promise.all([adaA.stop(), adaB.stop(), linS.stop()]));

  await until(() => adaA.events.length && adaB.events.length && linS.events.length);
  await call(srv.base, "/api/agent", { method: "POST", token: ada.token, body: { input: "remind me now" } });

  await until(() => adaA.events.some((e) => e.type === "reminder"));
  await until(() => adaB.events.some((e) => e.type === "reminder"));
  assert.ok(!linS.events.some((e) => e.type === "reminder"), "lin must not receive ada's reminder");
});

test("boot sweep re-arms reminders for tenants nothing has touched this run", async (t) => {
  const dir = tmpDir();
  seedUsers(dir, [{ user: "ada", pass: "ada-password" }, { user: "lin", pass: "lin-password" }]);
  const adaId = tenantId("ada");
  const linId = tenantId("lin");
  const brain = (text) => JSON.stringify({ memory: [], tasks: [], reminders: [{ id: "r1", text, fireAt: 0, done: false }] });
  for (const [id, text] of [[adaId, "ada from a previous boot"], [linId, "lin from a previous boot"]]) {
    fs.mkdirSync(path.join(dir, "users", id), { recursive: true });
    fs.writeFileSync(path.join(dir, "users", id, "brain.json"), brain(text));
  }

  const srv = await boot({ DATA_DIR: dir });
  t.after(() => srv.close());

  assert.equal(srv.store.size, 0, "nothing is loaded before the sweep");
  assert.equal(srv.store.sweep(), 2, "the sweep loads every tenant directory");

  const { startSchedulers } = require("../src/app");
  const stop = startSchedulers(srv, { tickMs: 25, statsMs: 100000, sweepMs: 100000 });
  t.after(() => stop());

  // No client is connected: the proof of re-arming is that the scheduler fires
  // and persists both reminders on its own.
  await until(() => {
    const read = (id) => JSON.parse(fs.readFileSync(path.join(dir, "users", id, "brain.json"), "utf8"));
    return read(adaId).reminders[0].done && read(linId).reminders[0].done;
  }, 3000);

  assert.ok(srv.hub.auditRing(adaId).some((e) => /ada from a previous boot/.test(e.text)));
  assert.ok(!srv.hub.auditRing(adaId).some((e) => /lin from a previous boot/.test(e.text)));
});
