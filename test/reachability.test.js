import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseFailure } from '../src/lib/reachability.js';

test('a fast 403 is read as a policy block, not a rejected credential', () => {
  // The pair is the tell: a refusal cannot arrive in 40ms from a host on the
  // other side of the internet.
  const d = diagnoseFailure('HTTP 403', 40, 'api.resend.com');
  assert.equal(d.kind, 'policy');
  assert.match(d.advice, /before the request left your network/);
  assert.match(d.advice, /api\.resend\.com/);
  assert.match(d.advice, /not the service rejecting your credentials/);
});

test('a 407 is the same story', () => {
  assert.equal(diagnoseFailure('HTTP 407 proxy auth required', 12, 'x.com').kind, 'policy');
});

test('a slow 403 is taken at face value — the service really did refuse', () => {
  const d = diagnoseFailure('HTTP 403 forbidden', 1400, 'api.resend.com');
  assert.equal(d.kind, 'service');
  assert.equal(d.advice, null);
});

test('transport errors are named as routing problems', () => {
  for (const message of [
    'upstream timeout',
    'getaddrinfo ENOTFOUND api.example.com',
    'connect ECONNREFUSED 127.0.0.1:443',
    'ETIMEDOUT',
  ]) {
    const d = diagnoseFailure(message, 5000, 'api.example.com');
    assert.equal(d.kind, 'network', message);
    assert.match(d.advice, /DNS or routing/);
  }
});

test('an ordinary API error is left alone rather than explained away', () => {
  const d = diagnoseFailure('Resend HTTP 422: invalid from address', 320, 'api.resend.com');
  assert.equal(d.kind, 'service');
  assert.equal(d.advice, null);
  assert.match(d.message, /invalid from address/);
});

test('an unauthorized key is not mistaken for a policy block', () => {
  // 401 is the service talking; only 403/407 carry the proxy ambiguity.
  const d = diagnoseFailure('HTTP 401 unauthorized', 30, 'api.resend.com');
  assert.equal(d.kind, 'service');
});
