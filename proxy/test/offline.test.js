"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { boot, seedUsers, call, login, tmpDir, openStream, until } = require("./helpers");
const { NO_MODEL } = require("../src/offline");

/** With no OPENAI_API_KEY and no injected upstream, the server is offline. */
async function offlineServer(t) {
  const dir = tmpDir();
  seedUsers(dir, [{ user: "ada", pass: "ada-password" }, { user: "lin", pass: "lin-password" }]);
  const srv = await boot({ DATA_DIR: dir });
  t.after(() => srv.close());
  const ada = await login(srv.base, "ada", "ada-password");
  const lin = await login(srv.base, "lin", "lin-password");
  const say = (input, who = ada) =>
    call(srv.base, "/api/agent", { method: "POST", token: who.token, body: { input } });
  return { srv, ada, lin, say };
}

test("a blank model key gives a working brain, not a 502", async (t) => {
  const { say } = await offlineServer(t);
  const r = await say("remember the launch is Oct 3");
  assert.equal(r.status, 200, "the draft returned 502 here");
  assert.equal(r.body.offline, true);
  assert.deepEqual(r.body.used, ["remember"]);
});

test("offline memory, tasks and compute round-trip", async (t) => {
  const { say, srv, ada } = await offlineServer(t);

  await say("remember the launch is Oct 3");
  assert.match((await say("recall launch")).body.answer, /launch: Oct 3/);

  await say("add task book the room for ada");
  assert.match((await say("list tasks")).body.answer, /book the room/);

  const brain = await call(srv.base, "/api/brain", { token: ada.token });
  const id = brain.body.tasks[0].id;
  await say("complete " + id);
  assert.equal((await say("list tasks")).body.answer, "none");

  assert.equal((await say("18450 * 1.07")).body.answer, "19,741.5");
  assert.equal((await say("5 km to mi")).body.answer, "3.1069 mi");
});

test("offline reminders arm and fire, still scoped per tenant", async (t) => {
  const { srv, ada, lin, say } = await offlineServer(t);

  const { startSchedulers } = require("../src/app");
  const stop = startSchedulers(srv, { tickMs: 25, statsMs: 100000, sweepMs: 100000 });
  t.after(() => stop());

  const adaStream = await openStream(srv.base, ada.token);
  const linStream = await openStream(srv.base, lin.token);
  t.after(() => Promise.all([adaStream.stop(), linStream.stop()]));
  await until(() => adaStream.events.length && linStream.events.length);

  const armed = await say("remind me to check the deck in 1 second");
  assert.deepEqual(armed.body.used, ["schedule_reminder"]);

  await until(() => adaStream.events.some((e) => e.type === "reminder" && /check the deck/.test(e.text)), 4000);
  assert.ok(!linStream.events.some((e) => e.type === "reminder"));
});

test("unrecognised input says so instead of pretending", async (t) => {
  const { say } = await offlineServer(t);
  const r = await say("write me a haiku about orbital mechanics");
  assert.equal(r.body.answer, NO_MODEL);
  assert.deepEqual(r.body.used, []);
});

test("offline mode still refuses unauthenticated callers", async (t) => {
  const { srv } = await offlineServer(t);
  assert.equal((await call(srv.base, "/api/agent", { method: "POST", body: { input: "list tasks" } })).status, 401);
});
