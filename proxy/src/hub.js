"use strict";
const { rid } = require("./store");

/**
 * Per-tenant SSE fan-out and audit ring.
 *
 * Every write path takes an explicit tenantId; there is no "broadcast to
 * everyone" call, which is what keeps one operator's reminders off another
 * operator's deck.
 */
class Hub {
  constructor({ maxAuditPerTenant = 300 } = {}) {
    this.maxAudit = maxAuditPerTenant;
    this.clients = new Map(); // connId -> { id, res, tenantId, connectedAt, hb }
    this.audit = new Map(); // tenantId -> entries[]
  }

  auditRing(tenantId) {
    let ring = this.audit.get(tenantId);
    if (!ring) {
      ring = [];
      this.audit.set(tenantId, ring);
    }
    return ring;
  }

  pushAudit(tenantId, text, kind = "system") {
    const entry = { text: String(text), kind, ts: Date.now() };
    const ring = this.auditRing(tenantId);
    ring.push(entry);
    if (ring.length > this.maxAudit) ring.splice(0, ring.length - this.maxAudit);
    return entry;
  }

  broadcast(tenantId, type, payload) {
    const data = JSON.stringify({ type, ts: Date.now(), ...(payload || {}) });
    let sent = 0;
    for (const [id, c] of this.clients) {
      if (c.tenantId !== tenantId) continue;
      try {
        c.res.write("data: " + data + "\n\n");
        sent++;
      } catch {
        this.drop(id);
      }
    }
    return sent;
  }

  presence(tenantId) {
    const list = [...this.clients.values()].filter((c) => c.tenantId === tenantId);
    return {
      count: list.length,
      clients: list.map((c) => ({ id: c.id, age: Math.floor((Date.now() - c.connectedAt) / 1000) })),
    };
  }

  /** Tenants that currently have at least one live listener. */
  activeTenants() {
    return new Set([...this.clients.values()].map((c) => c.tenantId));
  }

  add(tenantId, res, heartbeatMs = 15000) {
    const id = rid();
    const c = { id, res, tenantId, connectedAt: Date.now() };
    c.hb = setInterval(() => {
      try {
        res.write(": ping " + Date.now() + "\n\n");
      } catch {
        this.drop(id);
      }
    }, heartbeatMs);
    if (typeof c.hb.unref === "function") c.hb.unref();
    this.clients.set(id, c);
    return id;
  }

  drop(id) {
    const c = this.clients.get(id);
    if (!c) return null;
    clearInterval(c.hb);
    this.clients.delete(id);
    return c;
  }

  closeAll() {
    for (const id of [...this.clients.keys()]) {
      const c = this.drop(id);
      try {
        c.res.end();
      } catch {
        /* already gone */
      }
    }
  }

  get size() {
    return this.clients.size;
  }
}

module.exports = { Hub };
