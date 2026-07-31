"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { tenantId } = require("./ids");

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** "scrypt$N$r$p$<salt-b64>$<hash-b64>" */
function hashPassword(pass, params = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pass), salt, params.keylen, { N: params.N, r: params.r, p: params.p });
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64"), dk.toString("base64")].join("$");
}

function verifyPassword(pass, stored) {
  if (typeof stored !== "string" || !stored.startsWith("scrypt$")) return false;
  const [, N, r, p, saltB64, hashB64] = stored.split("$");
  let dk, expected;
  try {
    expected = Buffer.from(hashB64, "base64");
    dk = crypto.scryptSync(String(pass), Buffer.from(saltB64, "base64"), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
  } catch {
    return false;
  }
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

/** Constant-time compare for the legacy plaintext records we migrate away from. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // keep the work roughly constant
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * users.json, hot-reloaded on mtime change.
 *
 * Records are { user, hash, role }. Legacy { user, pass, role } records still
 * authenticate and are upgraded to a hash on the next successful login.
 */
class UserStore {
  constructor({ usersFile, dataDir, adminUser = "", adminPass = "" }) {
    this.usersFile = usersFile;
    this.dataDir = dataDir;
    this.adminUser = adminUser;
    this.adminPass = adminPass;
    this.mtime = -1;
    this.list = [];
    this.bootstrapped = false;
  }

  all() {
    let st;
    try {
      st = fs.statSync(this.usersFile);
    } catch (e) {
      if (e.code === "ENOENT") this.#bootstrap();
      return this.list;
    }
    if (st.mtimeMs !== this.mtime) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.usersFile, "utf8"));
        if (!Array.isArray(parsed)) throw new Error("users.json must contain an array");
        this.list = parsed.filter((u) => u && typeof u.user === "string");
        this.mtime = st.mtimeMs;
      } catch (e) {
        // Keep serving the last good list. Overwriting here would destroy the
        // operator's file because of a stray comma.
        console.error("[users] %s is unreadable (%s) — keeping previous list", this.usersFile, e.message);
        this.mtime = st.mtimeMs;
      }
    }
    return this.list;
  }

  /** Seed the very first admin from ADMIN_USER/ADMIN_PASS when no file exists. */
  #bootstrap() {
    if (this.bootstrapped || !this.adminUser || !this.adminPass) return;
    this.bootstrapped = true;
    this.list = [{ user: this.adminUser, hash: hashPassword(this.adminPass), role: "admin" }];
    try {
      this.save(this.list);
      console.log("[users] bootstrapped admin %j into %s", this.adminUser, this.usersFile);
    } catch (e) {
      console.error("[users] could not write %s: %s", this.usersFile, e.message);
    }
  }

  save(list) {
    fs.mkdirSync(path.dirname(this.usersFile), { recursive: true });
    const tmp = this.usersFile + ".tmp-" + crypto.randomBytes(3).toString("hex");
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, this.usersFile);
    this.list = list;
    try {
      this.mtime = fs.statSync(this.usersFile).mtimeMs;
    } catch {
      this.mtime = -1;
    }
  }

  find(user) {
    return this.all().find((u) => u.user === user);
  }

  /** Returns the user record on success, null otherwise. */
  authenticate(user, pass) {
    const list = this.all();
    const rec = list.find((u) => u.user === user);
    if (!rec || typeof pass !== "string") {
      // Spend comparable time on unknown users so the endpoint does not leak
      // which usernames exist.
      hashPassword("decoy-" + Math.random());
      return null;
    }
    if (rec.hash) return verifyPassword(pass, rec.hash) ? rec : null;
    if (rec.pass != null && safeEqual(pass, rec.pass)) {
      rec.hash = hashPassword(pass); // migrate plaintext on first successful login
      delete rec.pass;
      try {
        this.save(list);
        console.log("[users] upgraded plaintext password for %j to scrypt", user);
      } catch {
        /* non-fatal */
      }
      return rec;
    }
    return null;
  }

  add({ user, pass, role = "user" }) {
    const list = this.all().slice();
    if (list.some((u) => u.user === user)) return { error: "exists" };
    const rec = { user, hash: hashPassword(pass), role };
    list.push(rec);
    this.save(list);
    return { user: rec.user, role: rec.role, userId: tenantId(rec.user) };
  }

  remove(user) {
    const list = this.all();
    const next = list.filter((u) => u.user !== user);
    if (next.length === list.length) return false;
    this.save(next);
    return true;
  }

  publicList() {
    return this.all().map((u) => ({ user: u.user, role: u.role || "user", userId: tenantId(u.user) }));
  }

  get count() {
    return this.all().length;
  }
}

module.exports = { UserStore, hashPassword, verifyPassword };
