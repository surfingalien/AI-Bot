// The confirmation gate, which only exists once the server can actually dial.
//
// Placing a call to a real business is not undoable — the restaurant's phone
// rings whether or not the operator meant it — so a complete booking is read
// back and nothing happens until it is confirmed. Its own file because config
// reads the environment once, at import.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-book-confirm-'));
process.env.STATE_FILE = path.join(stateDir, 'state.json');
process.env.AUTONOMY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
process.env.TWILIO_ACCOUNT_SID = 'AC-stub';
process.env.TWILIO_AUTH_TOKEN = 'stub-token';
process.env.TWILIO_FROM_NUMBER = '+15550001111';

const { createApp } = await import('../src/app.js');
const { bookingConfigured } = await import('../src/config.js');
const { resetRateLimits } = await import('../src/lib/rateLimit.js');

test.beforeEach(() => resetRateLimits());

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const post = (body) =>
  fetch(`${base}/api/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const complete = {
  venue: 'Osteria Mozza',
  phone: '+1 323 297 0100',
  partySize: 4,
  when: 'Friday at 8pm',
  onBehalfOf: 'Suhas',
};

test('all three Twilio variables switch the capability on', () => {
  assert.equal(bookingConfigured(), true);
});

test('a complete booking is read back rather than dialled', async () => {
  const res = await post(complete);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.stage, 'confirm');
  assert.equal(j.configured, true);
  assert.equal(j.booking.venue, 'Osteria Mozza');
  assert.match(j.question, /Call Osteria Mozza/);
  assert.match(j.question, /confirm/i, 'says how to proceed');
});

test('the gate is not opened by a truthy-looking value', async () => {
  // `confirm: "yes"` is a client bug, not consent. Anything but the boolean
  // must land back on the read-back, never on the dial.
  for (const confirm of ['true', 'yes', 1, {}, null]) {
    const j = await (await post({ ...complete, confirm })).json();
    assert.equal(j.stage, 'confirm', `confirm: ${JSON.stringify(confirm)} must not dial`);
  }
});

test('confirming reaches the dial path', async () => {
  const res = await post({ ...complete, confirm: true });
  // Still 501 in this build — the point is that it got past the gate rather
  // than being read back a second time.
  assert.equal(res.status, 501);
  const j = await res.json();
  assert.equal(j.configured, true);
  assert.match(j.error, /not implemented/);
  assert.match(j.fallback.script, /table for 4/);
});

test('an incomplete booking is still asked about, confirmed or not', async () => {
  const res = await post({ venue: 'Nobu', confirm: true });
  assert.equal(res.status, 422, 'confirmation cannot substitute for missing details');
  const j = await res.json();
  assert.ok(j.needs.includes('phone'));
});
