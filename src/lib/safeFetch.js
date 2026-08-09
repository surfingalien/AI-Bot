// Outbound HTTP with the guards a public-facing proxy needs: scheme and
// address allowlisting (anti-SSRF), manual redirect following so every hop is
// re-checked, a hard timeout, and a streamed byte cap.

import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from '../config.js';

export class FetchError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
  }
}

function ipv4Blocked(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function ipv6Blocked(ip) {
  const v = ip.toLowerCase().split('%')[0];
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(v)) return true; // unique local
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  return false;
}

export function addressBlocked(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4Blocked(ip);
  if (kind === 6) return ipv6Blocked(ip);
  return true;
}

/**
 * Resolve a URL's host and reject it if any resolved address is private.
 * Returns the parsed URL on success.
 */
export async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new FetchError('malformed url', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError('only http(s) urls are allowed', 400);
  }
  if (config.fetch.allowPrivateEgress) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      const records = await dns.lookup(host, { all: true, verbatim: true });
      addresses = records.map((r) => r.address);
    } catch {
      throw new FetchError('dns lookup failed', 400);
    }
  }
  if (!addresses.length) throw new FetchError('host did not resolve', 400);
  for (const address of addresses) {
    if (addressBlocked(address)) {
      throw new FetchError('target resolves to a non-public address', 403);
    }
  }
  return url;
}

async function readCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    throw new FetchError(`response too large (${declared} bytes)`, 413);
  }
  if (!response.body) return '';

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new FetchError(`response exceeded ${maxBytes} bytes`, 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetch a URL as text, following redirects manually so each hop is validated.
 */
export async function fetchText(rawUrl, options = {}) {
  const {
    headers = {},
    timeoutMs = config.fetch.timeoutMs,
    maxBytes = config.fetch.maxBytes,
    maxRedirects = config.fetch.maxRedirects,
    method = 'GET',
  } = options;

  let current = String(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicUrl(current);
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { 'User-Agent': config.fetch.userAgent, ...headers },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err && err.name === 'TimeoutError') throw new FetchError('upstream timeout', 504);
      throw new FetchError(`upstream request failed: ${err?.message || err}`, 502);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new FetchError(`redirect ${response.status} without location`, 502);
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) throw new FetchError(`HTTP ${response.status}`, response.status);

    const body = await readCapped(response, maxBytes);
    return { url: url.toString(), status: response.status, headers: response.headers, body };
  }
  throw new FetchError('too many redirects', 502);
}

/**
 * POST JSON to a URL (used for outbound webhooks). Response body is ignored
 * beyond its status.
 */
export async function postJson(rawUrl, payload, options = {}) {
  const url = await assertPublicUrl(rawUrl);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs || config.fetch.timeoutMs),
    });
  } catch (err) {
    if (err && err.name === 'TimeoutError') throw new FetchError('webhook timeout', 504);
    throw new FetchError(`webhook request failed: ${err?.message || err}`, 502);
  }
  if (!response.ok) throw new FetchError(`webhook returned HTTP ${response.status}`, 502);
  return { status: response.status };
}
