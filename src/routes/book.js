// POST /api/book            — place a booking call on the operator's behalf
// GET  /api/book/status/:sid — how that call is going
//
// The desk's `book_restaurant` tool calls these and degrades to a "here is what
// to say, call them yourself" script when they fail. That degradation is the
// right behaviour; what was wrong is that an unimplemented route 404s, which
// the desk cannot tell apart from a typo, a proxy stripping the path, or a
// server that is simply older than the client. So the route exists, validates
// the request, and answers 501 with the reason — the capability is absent, not
// the endpoint.
//
// Placing automated calls is also not a thing to switch on by accident:
// recorded and synthetic-voice calls to businesses are regulated differently
// depending on where the caller and callee are, so this stays off until three
// Twilio variables are set deliberately.

import { Router } from 'express';
import { config, bookingConfigured } from '../config.js';
import { rateLimit } from '../lib/rateLimit.js';

export const bookRouter = Router();

const str = (v) => (v == null ? '' : String(v).trim());

// Accept the desk's spelling and the obvious alternatives: the tool schema has
// changed once already, and a rename should not read as a missing field.
function readBooking(body) {
  const b = body || {};
  return {
    venue: str(b.venue || b.restaurant || b.name || b.place),
    phone: str(b.phone || b.number || b.tel),
    partySize: parseInt(b.partySize ?? b.party ?? b.people ?? b.seats, 10) || 0,
    when: str(b.when || b.time || b.datetime || b.date),
    onBehalfOf: str(b.onBehalfOf || b.guest || b.contact),
    notes: str(b.notes || b.request || b.special),
  };
}

// E.164-ish. Deliberately loose about separators and strict about what is left
// once they are removed, so a phone number the desk scraped off a page is
// rejected here rather than by Twilio a second later.
function phoneUsable(phone) {
  const digits = phone.replace(/[\s().-]/g, '');
  return /^\+?[0-9]{7,15}$/.test(digits);
}

/** What to say if a human ends up making this call. */
export function callScript(booking) {
  const parts = [
    `Hi — I'd like to book a table${booking.partySize ? ` for ${booking.partySize}` : ''}`,
    booking.when ? ` ${booking.when}` : '',
    booking.onBehalfOf ? `, under the name ${booking.onBehalfOf}` : '',
    '.',
  ];
  const ask = parts.join('');
  return booking.notes ? `${ask} ${booking.notes}` : ask;
}

bookRouter.post('/book', rateLimit({ name: 'book', max: 10 }), (req, res) => {
  const booking = readBooking(req.body);

  // Validated before the capability check on purpose: a malformed request is a
  // client bug whether or not Twilio is wired up, and the answer should not
  // change the day it is.
  const missing = [];
  if (!booking.venue) missing.push('venue');
  if (!booking.phone) missing.push('phone');
  if (missing.length) {
    return res.status(400).json({ ok: false, error: `missing: ${missing.join(', ')}` });
  }
  if (!phoneUsable(booking.phone)) {
    return res.status(400).json({ ok: false, error: `unusable phone number: ${booking.phone}` });
  }

  if (!bookingConfigured()) {
    return res.status(501).json({
      ok: false,
      configured: false,
      provider: config.booking.provider,
      error: 'voice booking is not configured on this server',
      reason: 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are unset',
      // Everything the desk needs to hand the operator a usable fallback
      // without asking them to retype what they already said.
      fallback: { ...booking, script: callScript(booking) },
    });
  }

  // Reached only once the three variables are set. Left unimplemented rather
  // than half-implemented: a call that dials and then cannot be supervised is
  // worse than no call.
  return res.status(501).json({
    ok: false,
    configured: true,
    provider: config.booking.provider,
    error: 'voice booking is configured but not implemented in this build',
    fallback: { ...booking, script: callScript(booking) },
  });
});

bookRouter.get('/book/status/:sid', (req, res) => {
  const sid = str(req.params.sid);
  return res.status(501).json({
    ok: false,
    sid,
    configured: bookingConfigured(),
    provider: config.booking.provider,
    error: 'voice booking is not available on this server, so no call has this id',
  });
});
