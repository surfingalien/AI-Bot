"use strict";
const path = require("path");

const int = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v == null || v === "" ? d : /^(1|true|yes|on)$/i.test(String(v)));

/**
 * Build the runtime config from an environment bag. Kept as a pure function so
 * tests can construct isolated servers without touching process.env.
 */
function loadConfig(env = process.env) {
  const dataDir = env.DATA_DIR || "./data";
  return {
    port: int(env.PORT, 8787),
    baseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: env.OPENAI_API_KEY || "",
    model: env.OPENAI_MODEL || "gpt-4o-mini",
    allowedOrigins: env.ALLOWED_ORIGINS || "*",

    dataDir,
    usersDir: path.join(dataDir, "users"),
    usersFile: path.join(dataDir, "users.json"),

    apiToken: env.API_TOKEN || "",
    adminUser: env.ADMIN_USER || "",
    adminPass: env.ADMIN_PASS || "",
    sessionTtlMs: int(env.SESSION_TTL_MIN, 720) * 60000,

    // Behind nginx/Caddy set TRUST_PROXY=1 so rate limiting sees real client IPs.
    trustProxy: bool(env.TRUST_PROXY, false),
    // Deleting a user leaves their brain on disk unless this is set.
    purgeBrainOnUserDelete: bool(env.PURGE_BRAIN_ON_USER_DELETE, false),
    // The raw /v1/chat/completions passthrough hands the server's model key to
    // any caller that gets past auth. Off unless explicitly enabled.
    rawPassthrough: bool(env.ENABLE_RAW_PASSTHROUGH, false),

    rateLimit: { windowMs: 60000, max: int(env.RATE_LIMIT_MAX, 120) },
    loginRateLimit: { windowMs: 300000, max: int(env.LOGIN_RATE_LIMIT_MAX, 10) },

    maxTenantsCached: int(env.MAX_TENANTS_CACHED, 500),
    maxAuditPerTenant: int(env.MAX_AUDIT_PER_TENANT, 300),
    agentMaxTurns: int(env.AGENT_MAX_TURNS, 8),
    upstreamTimeoutMs: int(env.UPSTREAM_TIMEOUT_MS, 60000),
    maxReminderSeconds: int(env.MAX_REMINDER_SECONDS, 60 * 60 * 24 * 365),
  };
}

module.exports = { loadConfig };
