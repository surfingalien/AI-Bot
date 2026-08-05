import test from 'node:test';
import assert from 'node:assert/strict';
import { addressBlocked, assertPublicUrl, FetchError } from '../src/lib/safeFetch.js';

test('blocks loopback, private, link-local and CGNAT ranges', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(addressBlocked(ip), true, `${ip} should be blocked`);
  }
});

test('allows ordinary public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700::1111']) {
    assert.equal(addressBlocked(ip), false, `${ip} should be allowed`);
  }
});

test('rejects anything that is not a valid IP literal', () => {
  assert.equal(addressBlocked('not-an-ip'), true);
  assert.equal(addressBlocked(''), true);
});

test('assertPublicUrl rejects non-http schemes', async () => {
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), FetchError);
  await assert.rejects(() => assertPublicUrl('gopher://example.com'), FetchError);
});

test('assertPublicUrl rejects malformed urls', async () => {
  await assert.rejects(() => assertPublicUrl('not a url'), FetchError);
});

test('assertPublicUrl rejects a literal private target', async () => {
  await assert.rejects(
    () => assertPublicUrl('http://169.254.169.254/latest/meta-data/'),
    (err) => err instanceof FetchError && err.status === 403,
  );
});
