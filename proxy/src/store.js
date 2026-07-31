"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { isSafeTenantId } = require("./ids");

const emptyBrain = () => ({ memory: [], tasks: [], reminders: [] });
const rid = () => crypto.randomBytes(3).toString("hex");

/**
 * One isolated brain per principal at <usersDir>/<tenantId>/brain.json.
 *
 * Brains are lazy-loaded into a bounded cache and written atomically
 * (tmp file + rename) so a crash mid-write cannot truncate a brain.
 */
class BrainStore {
  constructor({ usersDir, maxTenants = 500 }) {
    this.usersDir = usersDir;
    this.maxTenants = maxTenants;
    this.cache = new Map(); // tenantId -> brain  (Map keeps insertion order => LRU base)
  }

  brainPath(id) {
    if (!isSafeTenantId(id)) throw new Error("unsafe tenant id: " + id);
    return path.join(this.usersDir, id, "brain.json");
  }

  /** Normalize whatever was on disk into a complete brain shape. */
  static #coerce(raw) {
    const db = emptyBrain();
    if (raw && typeof raw === "object") {
      if (Array.isArray(raw.memory)) db.memory = raw.memory;
      if (Array.isArray(raw.tasks)) db.tasks = raw.tasks;
      if (Array.isArray(raw.reminders)) db.reminders = raw.reminders;
    }
    return db;
  }

  load(id) {
    if (this.cache.has(id)) {
      const db = this.cache.get(id); // touch for LRU
      this.cache.delete(id);
      this.cache.set(id, db);
      return db;
    }
    let db;
    try {
      db = BrainStore.#coerce(JSON.parse(fs.readFileSync(this.brainPath(id), "utf8")));
    } catch (e) {
      if (e && e.code !== "ENOENT" && !/unsafe tenant id/.test(e.message)) {
        // A corrupt brain must not be silently replaced by an empty one on the
        // next write; park it so the operator can recover it by hand.
        this.#quarantine(id, e);
      }
      if (/unsafe tenant id/.test(e.message || "")) throw e;
      db = emptyBrain();
    }
    this.cache.set(id, db);
    this.#evict();
    return db;
  }

  #quarantine(id, err) {
    try {
      const p = this.brainPath(id);
      fs.renameSync(p, p + ".corrupt-" + Date.now());
      console.error("[store] quarantined unreadable brain for %s: %s", id, err.message);
    } catch {
      /* best effort */
    }
  }

  save(id) {
    const db = this.cache.get(id);
    if (!db) return;
    const file = this.brainPath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp-" + rid();
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file); // atomic within the same filesystem
  }

  wipe(id) {
    this.cache.set(id, emptyBrain());
    this.save(id);
    return this.cache.get(id);
  }

  /** Remove a tenant's brain from cache and disk (used when a user is deleted). */
  purge(id) {
    this.cache.delete(id);
    try {
      fs.rmSync(path.join(this.usersDir, id), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  /** Load every tenant that exists on disk, so their reminders are re-armed. */
  sweep() {
    let names = [];
    try {
      names = fs.readdirSync(this.usersDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names) {
      if (!isSafeTenantId(name)) continue;
      try {
        this.load(name);
        n++;
      } catch {
        /* skip unreadable tenant */
      }
    }
    return n;
  }

  entries() {
    return [...this.cache.entries()];
  }

  get size() {
    return this.cache.size;
  }

  /**
   * Bound the cache. A tenant with pending reminders is never evicted — the
   * scheduler only walks loaded brains, so dropping one would silently disarm it.
   */
  #evict() {
    if (this.cache.size <= this.maxTenants) return;
    for (const [id, db] of this.cache) {
      if (this.cache.size <= this.maxTenants) break;
      const pending = (db.reminders || []).some((r) => !r.done);
      if (!pending) this.cache.delete(id);
    }
  }
}

/* ---- brain sub-APIs, bound to a single tenant's db ---- */

const memoryOf = (db) => ({
  add(k, v) {
    const m = { k: String(k).trim(), v: String(v || "").trim() || "(noted)", t: Date.now() };
    db.memory.push(m);
    return m;
  },
  recall(q) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return db.memory
      .filter((m) => {
        const hay = (m.k + " " + m.v).toLowerCase();
        return words.some((w) => hay.includes(w));
      })
      .slice(-10);
  },
});

const tasksOf = (db) => ({
  add(text, owner) {
    const t = { id: rid(), text: String(text).trim(), owner: String(owner || "ops"), done: false, t: Date.now() };
    db.tasks.push(t);
    return t;
  },
  open() {
    return db.tasks.filter((t) => !t.done);
  },
  toggle(id) {
    const t = db.tasks.find((x) => String(x.id) === String(id));
    if (t) t.done = !t.done;
    return t;
  },
});

module.exports = { BrainStore, emptyBrain, memoryOf, tasksOf, rid };
