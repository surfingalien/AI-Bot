"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

const { loadConfig, envFilePath } = require("./config");
const { UserStore } = require("./users");
const { BrainStore } = require("./store");
const { tenantId } = require("./ids");

const pkg = require("../package.json");

/* ------------------------------------------------------------------ *
 * output
 * ------------------------------------------------------------------ */
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s) => (tty ? `\x1b[36m${s}\x1b[0m` : s),
};
const ok = (m) => console.log(c.green("  ok  ") + m);
const warn = (m) => console.log(c.yellow(" warn ") + m);
const bad = (m) => console.log(c.red(" fail ") + m);
const info = (m) => console.log(c.dim("  ..  ") + m);

class CliError extends Error {}

/* ------------------------------------------------------------------ *
 * arg parsing
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) flags[a.slice(2)] = true;
        else {
          flags[a.slice(2)] = next;
          i++;
        }
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

/** Apply global flags to process.env before any config is read. */
function applyGlobals(flags) {
  // Deliberately not --env-file: node itself consumes that flag even when it
  // appears after the script path, so it never reaches us.
  if (flags.config && flags.config !== true) {
    process.env.SURFINGALIEN_ENV_FILE = path.resolve(String(flags.config));
  }
  const envFile = envFilePath(process.env);
  if (fs.existsSync(envFile)) require("dotenv").config({ path: envFile });

  // Explicit flags beat the .env, which beats the built-in defaults.
  if (flags["data-dir"] && flags["data-dir"] !== true) process.env.DATA_DIR = String(flags["data-dir"]);
  if (flags.port && flags.port !== true) process.env.PORT = String(flags.port);
  return { envFile, config: loadConfig(process.env) };
}

/* ------------------------------------------------------------------ *
 * prompting
 * ------------------------------------------------------------------ */
function ask(question, { silent = false } = {}) {
  if (!process.stdin.isTTY) {
    // Non-interactive: read one line from stdin so the CLI stays scriptable.
    return new Promise((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => (buf += d));
      process.stdin.on("end", () => resolve(buf.split("\n")[0].trim()));
    });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (!silent) return rl.question(question, (a) => (rl.close(), resolve(a.trim())));
    // Mute the echo for secrets.
    const onData = (chunk) => {
      const s = chunk.toString();
      if (s === "\r" || s === "\n" || s === "") process.stdin.removeListener("data", onData);
      else process.stdout.write("\x1b[2K\x1b[200D" + question + "*".repeat(rl.line.length));
    };
    process.stdout.write(question);
    process.stdin.on("data", onData);
    rl.question("", (a) => {
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      rl.close();
      resolve(a.trim());
    });
  });
}

async function resolvePassword(flags, label = "password") {
  if (flags.password && flags.password !== true) return String(flags.password);
  if (flags["password-file"] && flags["password-file"] !== true) {
    return fs.readFileSync(String(flags["password-file"]), "utf8").split("\n")[0].trim();
  }
  if (!process.stdin.isTTY) {
    const piped = await ask("");
    if (!piped) throw new CliError(`no ${label} supplied (use --password, --password-file, or pipe one in)`);
    return piped;
  }
  const a = await ask(`${label}: `, { silent: true });
  const b = await ask(`confirm ${label}: `, { silent: true });
  if (a !== b) throw new CliError("passwords did not match");
  return a;
}

/* ------------------------------------------------------------------ *
 * stores, opened directly against DATA_DIR (no running server needed)
 * ------------------------------------------------------------------ */
function openStores(config) {
  const users = new UserStore({
    usersFile: config.usersFile,
    dataDir: config.dataDir,
    adminUser: config.adminUser,
    adminPass: config.adminPass,
  });
  const brains = new BrainStore({ usersDir: config.usersDir, maxTenants: config.maxTenantsCached });
  return { users, brains };
}

const newToken = () => crypto.randomBytes(24).toString("base64url");

/* ------------------------------------------------------------------ *
 * commands
 * ------------------------------------------------------------------ */

async function cmdInit(config, flags, envFile) {
  const auth = String(flags.auth || "session");
  if (!["open", "token", "session"].includes(auth)) {
    throw new CliError(`--auth must be open, token or session (got ${auth})`);
  }

  fs.mkdirSync(config.usersDir, { recursive: true });
  ok(`data directory ${c.cyan(config.dataDir)}`);

  if (fs.existsSync(envFile) && !flags.force) {
    warn(`${envFile} already exists — leaving it alone (use --force to overwrite)`);
  } else {
    const token = auth === "token" ? newToken() : "";
    const body = [
      "# Generated by `surfingalien init`. Treat this file as a secret.",
      `PORT=${config.port}`,
      `OPENAI_BASE_URL=${config.baseUrl}`,
      `OPENAI_API_KEY=${config.apiKey}`,
      `OPENAI_MODEL=${config.model}`,
      `DATA_DIR=${config.dataDir}`,
      `ALLOWED_ORIGINS=${config.allowedOrigins}`,
      "",
      `# --- access control (${auth} mode) ---`,
      `API_TOKEN=${token}`,
      "ADMIN_USER=",
      "ADMIN_PASS=",
      `SESSION_TTL_MIN=${Math.round(config.sessionTtlMs / 60000)}`,
      "",
      "TRUST_PROXY=0",
      "ENABLE_RAW_PASSTHROUGH=0",
      "PURGE_BRAIN_ON_USER_DELETE=0",
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, body, { mode: 0o600 });
    try {
      fs.chmodSync(envFile, 0o600);
    } catch {
      /* best effort on exotic filesystems */
    }
    ok(`wrote ${c.cyan(envFile)} ${c.dim("(mode 600)")}`);
    if (token) console.log("\n  " + c.bold("API token: ") + c.cyan(token) + "\n");
  }

  if (auth === "session") {
    const stores = openStores(config);
    if (stores.users.count === 0) {
      console.log(c.dim("\n  session mode needs at least one user:"));
      console.log(c.dim("    surfingalien user add <name> --role admin\n"));
    }
  } else if (auth === "open") {
    warn("open mode: every caller shares one 'anon' brain. Local use only.");
  }
  return 0;
}

function cmdDoctor(config, envFile) {
  let problems = 0;
  const fail = (m) => (problems++, bad(m));

  console.log(c.bold("\n  environment\n"));
  const major = Number(process.versions.node.split(".")[0]);
  major >= 18 ? ok(`node ${process.version}`) : fail(`node ${process.version} — 18 or newer is required (global fetch)`);
  ok(`surfingalien ${pkg.version} from ${c.dim(path.join(__dirname, ".."))}`);

  console.log(c.bold("\n  configuration\n"));
  fs.existsSync(envFile) ? ok(`env file ${c.cyan(envFile)}`) : warn(`no env file at ${envFile} — using defaults`);
  if (fs.existsSync(envFile)) {
    const mode = fs.statSync(envFile).mode & 0o777;
    mode & 0o077 ? warn(`${envFile} is mode ${mode.toString(8)} — should be 600, it holds secrets`) : ok("env file permissions");
  }

  console.log(c.bold("\n  storage\n"));
  try {
    fs.mkdirSync(config.usersDir, { recursive: true });
    const probe = path.join(config.dataDir, ".write-probe");
    fs.writeFileSync(probe, "x");
    fs.unlinkSync(probe);
    ok(`${c.cyan(config.dataDir)} exists and is writable`);
  } catch (e) {
    fail(`${config.dataDir} is not writable: ${e.message}`);
  }
  let tenants = 0;
  try {
    tenants = fs.readdirSync(config.usersDir, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch {
    /* already reported above */
  }
  ok(`${tenants} tenant brain${tenants === 1 ? "" : "s"} on disk`);

  console.log(c.bold("\n  access control\n"));
  const { users } = openStores(config);
  const userCount = users.count;
  if (config.apiToken) ok(`token mode: API_TOKEN set (${config.apiToken.length} chars)`);
  if (userCount) ok(`session mode: ${userCount} user${userCount === 1 ? "" : "s"} provisioned`);
  if (!config.apiToken && !userCount) {
    warn("OPEN — no token, no users. Every caller shares one 'anon' brain.");
  }
  const plaintext = users.all().filter((u) => u.pass != null && !u.hash);
  if (plaintext.length) {
    warn(`${plaintext.length} user(s) still have plaintext passwords; they hash on next login`);
  }

  console.log(c.bold("\n  model provider\n"));
  config.apiKey ? ok(`key set, model ${c.cyan(config.model)} at ${config.baseUrl}`) : info("no key — the offline brain will handle recognised commands");

  if (config.rawPassthrough) warn("ENABLE_RAW_PASSTHROUGH=1 — authenticated callers can spend your model key directly");
  if (!config.trustProxy) info("TRUST_PROXY=0 — set it to 1 if a reverse proxy fronts this, or rate limiting sees only its IP");

  console.log(problems ? c.red(`\n  ${problems} problem(s) found\n`) : c.green("\n  no problems found\n"));
  return problems ? 1 : 0;
}

async function cmdHealth(config, flags) {
  const base = String(flags.base || `http://127.0.0.1:${config.port}`).replace(/\/+$/, "");
  const token = flags.token && flags.token !== true ? String(flags.token) : config.apiToken;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(base + "/api/health", {
      headers: token ? { Authorization: "Bearer " + token } : {},
      signal: ctl.signal,
    });
    const body = await res.json();
    if (flags.json) {
      console.log(JSON.stringify(body, null, 2));
      return res.ok ? 0 : 1;
    }
    ok(`${base} is up`);
    console.log(`       model    ${body.model} ${c.dim("@ " + body.base)}`);
    console.log(`       key      ${body.hasKey ? "configured" : c.yellow("none (offline brain)")}`);
    console.log(`       auth     ${body.auth && body.auth.required ? "required" : c.yellow("OPEN")}`);
    console.log(`       tenants  ${body.tenants}   clients ${body.clients}   uptime ${body.uptime}s`);
    return 0;
  } catch (e) {
    bad(`${base} did not answer: ${e.name === "AbortError" ? "timed out after 5s" : e.message}`);
    info("is the service running?  systemctl status surfingalien   /   surfingalien start");
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

async function cmdUser(config, sub, args, flags) {
  const { users, brains } = openStores(config);

  if (!sub || sub === "list") {
    const list = users.publicList();
    // --json must always emit parseable JSON, including the empty case: this
    // output is what scripts (and install.sh) consume.
    if (flags.json) {
      console.log(JSON.stringify(list, null, 2));
      return 0;
    }
    if (!list.length) {
      info("no users yet — surfingalien user add <name> --role admin");
      return 0;
    }
    const w = Math.max(4, ...list.map((u) => u.user.length));
    console.log("\n  " + c.bold("USER".padEnd(w)) + "  " + c.bold("ROLE ") + "  " + c.bold("TENANT"));
    for (const u of list) console.log("  " + u.user.padEnd(w) + "  " + (u.role || "user").padEnd(5) + "  " + c.dim(u.userId));
    console.log("");
    return 0;
  }

  const name = args[0];
  if (!name) throw new CliError(`usage: surfingalien user ${sub} <name>`);

  if (sub === "add") {
    if (users.find(name)) throw new CliError(`user ${name} already exists`);
    const role = String(flags.role || "user");
    if (!["admin", "user"].includes(role)) throw new CliError("--role must be admin or user");
    const pass = await resolvePassword(flags, `password for ${name}`);
    if (pass.length < 8) throw new CliError("password must be at least 8 characters");
    const created = users.add({ user: name, pass, role });
    if (created.error) throw new CliError(created.error);
    ok(`created ${c.cyan(name)} (${role}) — brain at ${c.dim(path.join(config.usersDir, created.userId))}`);
    return 0;
  }

  if (sub === "passwd") {
    const rec = users.find(name);
    if (!rec) throw new CliError(`no such user: ${name}`);
    const pass = await resolvePassword(flags, `new password for ${name}`);
    if (pass.length < 8) throw new CliError("password must be at least 8 characters");
    const list = users.all().slice();
    const { hashPassword } = require("./users");
    const idx = list.findIndex((u) => u.user === name);
    list[idx] = { user: name, hash: hashPassword(pass), role: rec.role || "user" };
    users.save(list);
    ok(`password updated for ${c.cyan(name)}`);
    warn("their existing sessions stay valid until they expire — restart the service to cut them now");
    return 0;
  }

  if (sub === "rm") {
    if (!users.find(name)) throw new CliError(`no such user: ${name}`);
    const tid = tenantId(name);
    users.remove(name);
    ok(`removed user ${c.cyan(name)}`);
    if (flags.purge) {
      brains.purge(tid);
      ok(`purged brain ${c.dim(path.join(config.usersDir, tid))}`);
    } else {
      info(`brain kept at ${c.dim(path.join(config.usersDir, tid))} — pass --purge to delete it`);
    }
    warn("a running service caches sessions in memory; restart it to revoke theirs immediately");
    return 0;
  }

  throw new CliError(`unknown subcommand: user ${sub}`);
}

/* ------------------------------------------------------------------ *
 * help
 * ------------------------------------------------------------------ */
const HELP = `
${c.bold("surfingalien")} ${c.dim("v" + pkg.version)} — multi-tenant assistant proxy

${c.bold("USAGE")}
  surfingalien <command> [options]

${c.bold("COMMANDS")}
  start                     run the server in the foreground
  init                      create the data dir and a .env
  doctor                    check config, permissions and auth posture
  health                    probe a running instance
  token                     print a fresh random API token
  user list                 list users and their tenant ids
  user add <name>           create a user
  user passwd <name>        change a password
  user rm <name>            delete a user (--purge also deletes their brain)
  version                   print the version

${c.bold("GLOBAL OPTIONS")}
  --data-dir <path>         override DATA_DIR
  --config <path>           read this .env instead of <install>/.env
  --port <n>                override PORT

${c.bold("COMMAND OPTIONS")}
  init    --auth open|token|session   --force
  health  --base <url>  --token <t>  --json
  user    --role admin|user  --password <p>  --password-file <f>  --purge  --json

${c.bold("EXAMPLES")}
  surfingalien init --auth session
  surfingalien user add ada --role admin
  surfingalien doctor
  surfingalien health --json

Passwords are read from a TTY prompt, --password-file, or stdin. Prefer those
over --password, which lands in your shell history and in ps output.
`;

/* ------------------------------------------------------------------ *
 * entry
 * ------------------------------------------------------------------ */
async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] || "help";

  if (command === "help" || flags.help || flags.h) {
    console.log(HELP);
    return 0;
  }
  if (command === "version" || flags.version) {
    console.log(pkg.version);
    return 0;
  }

  const { config, envFile } = applyGlobals(flags);

  switch (command) {
    case "start":
      require("../server.js");
      return null; // the server owns the process from here
    case "init":
      return cmdInit(config, flags, envFile);
    case "doctor":
      return cmdDoctor(config, envFile);
    case "health":
      return cmdHealth(config, flags);
    case "token":
      console.log(newToken());
      return 0;
    case "user":
      return cmdUser(config, positional[1], positional.slice(2), flags);
    default:
      throw new CliError(`unknown command: ${command}\nRun \`surfingalien help\` for usage.`);
  }
}

module.exports = { main, parseArgs, CliError, HELP };
