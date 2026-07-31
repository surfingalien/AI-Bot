"use strict";
const crypto = require("crypto");

/** Tenant ids reserved for non-credential principals. */
const SERVICE_TENANT = "service";
const ANON_TENANT = "anon";
const RESERVED = new Set([SERVICE_TENANT, ANON_TENANT]);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Map a username to a filesystem-safe tenant id.
 *
 * The slug alone is NOT injective — "a.b", "a/b" and "a_b" all slugify to
 * "a_b", which would silently merge two people's brains. A short digest of the
 * *original* name is appended so distinct usernames always get distinct
 * directories, while the readable prefix is kept for humans browsing data/.
 */
function tenantId(username) {
  const raw = String(username);
  const slug =
    raw
      .normalize("NFKC")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/^[^A-Za-z0-9]+/, "")
      .slice(0, 48) || "user";
  const digest = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${slug}-${digest}`;
}

/**
 * Guard for ids that come from outside the process (directory names read
 * during the boot sweep, ids embedded in tokens, ...). Rejects traversal and
 * anything that is not a plain path segment.
 */
function isSafeTenantId(id) {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 128 &&
    id !== "." &&
    id !== ".." &&
    SAFE_ID.test(id)
  );
}

module.exports = { tenantId, isSafeTenantId, SERVICE_TENANT, ANON_TENANT, RESERVED };
