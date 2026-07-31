"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const { parseArgs } = require("../src/cli");
const { tenantId } = require("../src/ids");
const { tmpDir } = require("./helpers");

const BIN = path.join(__dirname, "..", "bin", "surfingalien.js");

/** Run the CLI as a real subprocess, the way an operator would. */
function cli(args, { input, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [BIN, ...args],
      { env: { ...process.env, NO_COLOR: "1", ...env } },
      (err, stdout, stderr) => resolve({ code: err ? err.code || 1 : 0, stdout, stderr })
    );
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

/** A fresh install: its own data dir and env file. */
function sandbox() {
  const dir = tmpDir();
  return { dir, data: path.join(dir, "data"), env: path.join(dir, ".env") };
}
const scoped = (s, ...args) => [...args, "--data-dir", s.data, "--config", s.env];

test("parseArgs handles --flag value, --flag=value, bare flags and --", () => {
  assert.deepEqual(parseArgs(["user", "add", "ada", "--role", "admin"]), {
    positional: ["user", "add", "ada"],
    flags: { role: "admin" },
  });
  assert.deepEqual(parseArgs(["--port=9000", "--json"]), {
    positional: [],
    flags: { port: "9000", json: true },
  });
  // A flag followed by another flag is a boolean, not a value.
  assert.deepEqual(parseArgs(["--purge", "--role", "admin"]).flags, { purge: true, role: "admin" });
  assert.deepEqual(parseArgs(["--", "--not-a-flag"]), { positional: ["--not-a-flag"], flags: {} });
});

test("help and version work without any configuration", async () => {
  const h = await cli(["help"]);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /USAGE/);
  assert.match(h.stdout, /user add <name>/);

  const v = await cli(["version"]);
  assert.equal(v.code, 0);
  assert.equal(v.stdout.trim(), require("../package.json").version);
});

test("an unknown command exits 2 with a usable message", async () => {
  const r = await cli(["frobnicate"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command: frobnicate/);
});

test("token prints a fresh high-entropy token each time", async () => {
  const a = (await cli(["token"])).stdout.trim();
  const b = (await cli(["token"])).stdout.trim();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32, "token is at least 32 chars");
});

test("init creates the data dir and a 0600 env file", async () => {
  const s = sandbox();
  const r = await cli(scoped(s, "init", "--auth", "session"));
  assert.equal(r.code, 0);

  assert.ok(fs.existsSync(path.join(s.data, "users")));
  assert.ok(fs.existsSync(s.env));
  assert.equal(fs.statSync(s.env).mode & 0o777, 0o600, "the env file holds secrets");

  const body = fs.readFileSync(s.env, "utf8");
  assert.match(body, /^DATA_DIR=/m);
  assert.match(body, /^API_TOKEN=$/m, "session mode leaves the static token empty");
});

test("init --auth token mints a real token into the env file", async () => {
  const s = sandbox();
  const r = await cli(scoped(s, "init", "--auth", "token"));
  assert.equal(r.code, 0);
  const token = (fs.readFileSync(s.env, "utf8").match(/^API_TOKEN=(.+)$/m) || [])[1];
  assert.ok(token && token.length >= 32);
  assert.match(r.stdout, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "printed once for the operator");
});

test("init refuses to clobber an existing env file without --force", async () => {
  const s = sandbox();
  await cli(scoped(s, "init", "--auth", "token"));
  const first = fs.readFileSync(s.env, "utf8");

  const again = await cli(scoped(s, "init", "--auth", "token"));
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already exists/);
  assert.equal(fs.readFileSync(s.env, "utf8"), first, "the token was not silently rotated");

  await cli(scoped(s, "init", "--auth", "token", "--force"));
  assert.notEqual(fs.readFileSync(s.env, "utf8"), first, "--force does rewrite it");
});

test("init rejects a bogus auth mode", async () => {
  const s = sandbox();
  const r = await cli(scoped(s, "init", "--auth", "banana"));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--auth must be open, token or session/);
});

test("user add/list/rm round-trip with the password piped in", async () => {
  const s = sandbox();
  await cli(scoped(s, "init"));

  const add = await cli(scoped(s, "user", "add", "ada", "--role", "admin"), { input: "ada-password\n" });
  assert.equal(add.code, 0);
  assert.match(add.stdout, /created ada \(admin\)/);

  const list = await cli(scoped(s, "user", "list", "--json"));
  const users = JSON.parse(list.stdout);
  assert.deepEqual(users, [{ user: "ada", role: "admin", userId: tenantId("ada") }]);

  // The password is hashed on disk, never stored as given.
  const raw = fs.readFileSync(path.join(s.data, "users.json"), "utf8");
  assert.ok(!raw.includes("ada-password"));
  assert.match(raw, /scrypt\$/);

  const rm = await cli(scoped(s, "user", "rm", "ada"));
  assert.equal(rm.code, 0);
  assert.deepEqual(JSON.parse((await cli(scoped(s, "user", "list", "--json"))).stdout || "[]"), []);
});

test("user add refuses duplicates, bad roles and short passwords", async () => {
  const s = sandbox();
  await cli(scoped(s, "init"));
  await cli(scoped(s, "user", "add", "ada"), { input: "ada-password\n" });

  const dup = await cli(scoped(s, "user", "add", "ada"), { input: "other-password\n" });
  assert.equal(dup.code, 2);
  assert.match(dup.stderr, /already exists/);

  const role = await cli(scoped(s, "user", "add", "bob", "--role", "root"), { input: "bob-password\n" });
  assert.equal(role.code, 2);
  assert.match(role.stderr, /--role must be admin or user/);

  const short = await cli(scoped(s, "user", "add", "eve"), { input: "short\n" });
  assert.equal(short.code, 2);
  assert.match(short.stderr, /at least 8 characters/);
});

test("user rm --purge deletes the brain, plain rm keeps it", async () => {
  const s = sandbox();
  await cli(scoped(s, "init"));
  await cli(scoped(s, "user", "add", "ada"), { input: "ada-password\n" });
  await cli(scoped(s, "user", "add", "lin"), { input: "lin-password\n" });

  // Give both a brain on disk.
  for (const name of ["ada", "lin"]) {
    const dir = path.join(s.data, "users", tenantId(name));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "brain.json"), JSON.stringify({ memory: [], tasks: [], reminders: [] }));
  }

  await cli(scoped(s, "user", "rm", "ada", "--purge"));
  assert.ok(!fs.existsSync(path.join(s.data, "users", tenantId("ada"))), "purged");

  await cli(scoped(s, "user", "rm", "lin"));
  assert.ok(fs.existsSync(path.join(s.data, "users", tenantId("lin"))), "kept by default");
});

test("user passwd changes the hash and rejects unknown users", async () => {
  const s = sandbox();
  await cli(scoped(s, "init"));
  await cli(scoped(s, "user", "add", "ada"), { input: "ada-password\n" });
  const before = fs.readFileSync(path.join(s.data, "users.json"), "utf8");

  const r = await cli(scoped(s, "user", "passwd", "ada"), { input: "a-new-password\n" });
  assert.equal(r.code, 0);
  const after = fs.readFileSync(path.join(s.data, "users.json"), "utf8");
  assert.notEqual(before, after);
  assert.ok(!after.includes("a-new-password"));

  const missing = await cli(scoped(s, "user", "passwd", "ghost"), { input: "whatever-pass\n" });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no such user/);
});

test("doctor reports OPEN when nothing is locked down, and exits 0", async () => {
  const s = sandbox();
  await cli(scoped(s, "init", "--auth", "open"));
  const r = await cli(scoped(s, "doctor"));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /OPEN/);
  assert.match(r.stdout, /no problems found/);
});

test("doctor sees users once they exist", async () => {
  const s = sandbox();
  await cli(scoped(s, "init"));
  await cli(scoped(s, "user", "add", "ada", "--role", "admin"), { input: "ada-password\n" });
  const r = await cli(scoped(s, "doctor"));
  assert.match(r.stdout, /session mode: 1 user provisioned/);
  assert.doesNotMatch(r.stdout, /OPEN —/);
});

test("doctor flags a world-readable env file", async () => {
  const s = sandbox();
  await cli(scoped(s, "init"));
  fs.chmodSync(s.env, 0o644);
  const r = await cli(scoped(s, "doctor"));
  assert.match(r.stdout, /should be 600/);
});

test("health exits non-zero when nothing is listening", async () => {
  const s = sandbox();
  await cli(scoped(s, "init"));
  const r = await cli(scoped(s, "health", "--base", "http://127.0.0.1:1"));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /did not answer/);
});

test("the CLI finds its own env file with no flags at all", async () => {
  // This is what the installed binary does: no --config, no --data-dir. The
  // path comes from SURFINGALIEN_ENV_FILE, which the service unit sets.
  const s = sandbox();
  await cli(scoped(s, "init"));
  await cli(scoped(s, "user", "add", "ada"), { input: "ada-password\n" });

  const r = await cli(["user", "list", "--json"], { env: { SURFINGALIEN_ENV_FILE: s.env } });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), [{ user: "ada", role: "user", userId: tenantId("ada") }]);
});

test("a relative DATA_DIR is resolved once, not re-resolved per cwd", async () => {
  // A service unit has no meaningful cwd; a relative DATA_DIR that follows the
  // process around would silently create a second, empty brain store.
  const { loadConfig } = require("../src/config");
  const cfg = loadConfig({ DATA_DIR: "./data" });
  assert.ok(path.isAbsolute(cfg.dataDir));
  assert.ok(path.isAbsolute(cfg.usersDir));
  assert.ok(path.isAbsolute(cfg.usersFile));
});
