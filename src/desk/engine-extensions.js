/* eslint-disable */
// Tools the server adds to the desk's engine.
//
// This file is never imported. It is read as text and spliced into the end of
// the `#engineSrc` block, so it runs inside the engine's own closure and can
// see `TOOLS`, `TOOL_BY_NAME`, `TOOL_SCHEMAS` and `S`. Those are not reachable
// any other way: the engine is evaluated with `new Function(src)`, so none of
// its state is global, and a separate <script> tag can only see the window.
//
// Written in the engine's own dialect — ES5, var, no arrow functions — because
// it becomes part of that source and shares its parse.
//
// Everything here is additive and guarded by name. When a newer desk build
// arrives already carrying one of these tools, its version wins and this file
// registers nothing, so dropping in a new index.html never conflicts.

(function () {
  if (typeof TOOLS === 'undefined' || typeof TOOL_BY_NAME === 'undefined') return;

  function proxy(path, opts) {
    if (!S.dataBase) return Promise.reject(new Error('no DATA PROXY configured'));
    // Same-origin, so the httpOnly token cookie authenticates this by itself —
    // the desk never holds the secret.
    return fetch(S.dataBase.replace(/\/$/, '') + path, opts);
  }

  function readJson(res) {
    return res
      .json()
      .catch(function () {
        return {};
      })
      .then(function (body) {
        return { status: res.status, body: body || {} };
      });
  }

  function register(tool) {
    // A newer desk build that already ships this tool keeps its own version.
    if (TOOL_BY_NAME[tool.name]) return;
    TOOLS.push(tool);
    TOOL_BY_NAME[tool.name] = tool;
    var props = {};
    for (var k in tool.p) props[k] = { type: tool.p[k] };
    TOOL_SCHEMAS.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.desc,
        parameters: { type: 'object', properties: props, required: [] },
      },
    });
  }

  function dialable(phone) {
    return String(phone || '').replace(/[^0-9+]/g, '');
  }

  // A phone number is the slowest way to get a table and the only one that
  // needs a human. Where the desk can name a venue it can also hand over the
  // two booking sites and a calendar hold, so the fallback is a set of choices
  // rather than an instruction to go and make a phone call.
  function fallbackLinks(booking) {
    var venue = booking.venue || '';
    if (!venue) return [];
    var links = [
      { t: 'open', label: 'OpenTable', url: 'https://www.opentable.com/s?term=' + encodeURIComponent(venue) },
      { t: 'open', label: 'Resy', url: 'https://resy.com/?query=' + encodeURIComponent(venue) },
    ];
    // Only offer to hold the slot when the time actually parsed — a calendar
    // entry at a guessed hour is worse than none.
    var when = booking.when ? new Date(booking.when) : null;
    if (when && !isNaN(when.getTime()) && typeof gcalFmt === 'function') {
      links.push({
        t: 'open',
        label: 'hold the evening',
        url:
          'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' +
          encodeURIComponent('Dinner: ' + venue) +
          '&dates=' +
          gcalFmt(when) +
          '/' +
          gcalFmt(new Date(when.getTime() + 7200000)),
      });
    }
    return links;
  }

  // Reads back as one line in the transcript, so the operator can see what was
  // asked for without opening anything.
  function summarise(b) {
    var bits = [b.venue || 'somewhere'];
    if (b.partySize) bits.push('party of ' + b.partySize);
    if (b.when) bits.push(b.when);
    return bits.join(' · ');
  }

  register({
    name: 'book_restaurant',
    desc:
      'BOOK A TABLE by having the server phone the venue. Needs venue, phone, partySize and when. ' +
      'If any are missing the server replies with the single next question to ask — ask the user ' +
      'that one question, do not invent the answer. When everything is known the server reads the ' +
      'booking back for approval; call again with confirm=true only after the user agrees. If the ' +
      'server cannot place calls it returns a script to read out, which you should show verbatim.',
    p: {
      venue: 'string',
      phone: 'string',
      partySize: 'number',
      when: 'string',
      onBehalfOf: 'string',
      notes: 'string',
      confirm: 'boolean',
    },
    exec: function (a, ctx) {
      if (!S.dataBase) return 'booking needs the DATA PROXY';
      var booking = {
        venue: String(a.venue || ''),
        phone: String(a.phone || ''),
        partySize: parseInt(a.partySize, 10) || 0,
        when: String(a.when || ''),
        onBehalfOf: String(a.onBehalfOf || ''),
        notes: String(a.notes || ''),
        confirm: a.confirm === true,
      };

      return proxy('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(booking),
      })
        .then(readJson)
        .then(function (res) {
          var j = res.body;

          if (res.status === 400) {
            ctx.actions.push({ t: 'stat', label: 'booking incomplete' });
            return '**I need more before I can call.** ' + (j.error || 'the booking is incomplete') + '.';
          }

          // Incomplete, not wrong. The server names the one thing to ask for
          // next, so the desk asks that instead of listing every empty field —
          // a person collecting a booking asks one question at a time.
          if (res.status === 422) {
            // The chip carries the question itself, not the field names behind
            // it. `still need: partySize, when` is the same developer-speak the
            // server stopped emitting, and it is the one line guaranteed to
            // reach the screen — the tool's return value only gets there if the
            // model chooses to relay it.
            ctx.actions.push({ t: 'stat', label: j.question || 'more detail needed' });
            return j.question || 'What else should I know before I call?';
          }

          // Complete and dialable, so nothing happens until the operator says
          // so. Returned as a question rather than performed as an action.
          if (res.status === 200 && j.stage === 'confirm') {
            ctx.actions.push({ t: 'stat', label: 'waiting on confirmation' });
            var b = j.booking || booking;
            return [
              '**Ready to call ' + b.venue + '.**',
              '',
              '- ' + (b.phone || 'no number'),
              '- ' + (b.partySize ? b.partySize + ' people' : 'party size unknown') + ', ' + (b.when || 'time unknown'),
              b.onBehalfOf ? '- under ' + b.onBehalfOf : '',
              '',
              'Say **confirm** and I will place the call.',
            ]
              .filter(Boolean)
              .join('\n');
          }

          // The server has no voice line. This is the path that matters: say so
          // plainly, then hand over everything needed to do it by hand.
          if (res.status === 501) {
            var f = j.fallback || booking;
            ctx.actions.push({
              t: 'stat',
              label: 'booking: ' + (j.configured ? 'not implemented' : 'not configured') + ' — call it yourself',
            });

            // The script is the whole value of this path, and handing it back to
            // the model is not enough: the model paraphrases, and the exact
            // words are what the operator needs in their mouth on the call. The
            // desk's copy chip copies a whole turn rather than a payload, so the
            // script gets a turn of its own — the same channel reminders use.
            // Nothing between here and the screen can reword it.
            // Quoted rather than a blockquote: the desk's markdown renders bold,
            // code and lists, but prints a leading `>` literally.
            var card = ['**' + (f.venue || 'the venue') + '** — ' + (f.phone || 'no number given')];
            if (f.script) card.push('', 'Read this out:', '', '**“' + f.script + '”**');
            if (j.reason) card.push('', '`' + j.reason + '`');
            pushTurn({
              user: '(call script for ' + (f.venue || 'the venue') + ')',
              agentId: 'ops',
              agentName: 'Booking',
              color: 'amber',
              // `md` renders; `text` is escaped and shown raw. The script is
              // formatted, so it has to go through the markdown branch.
              md: card.join('\n'),
              text: card.join('\n'),
              pre: null,
              actions: (dialable(f.phone)
                ? [{ t: 'open', label: 'call ' + (f.venue || 'the venue'), url: 'tel:' + dialable(f.phone) }]
                : []
              )
                .concat([{ t: 'copy', label: 'copy call script' }])
                .concat(fallbackLinks(f)),
              t: Date.now(),
            });

            var lines = ['**I cannot place the call from here.** ' + (j.error || 'voice booking is unavailable') + '.'];
            if (j.reason) lines.push('', j.reason + '.');
            lines.push('', 'The call script is posted above — read it to the venue verbatim.');
            return lines.join('\n');
          }

          if (res.status >= 200 && res.status < 300 && j.sid) {
            ctx.actions.push({ t: 'stat', label: 'calling ' + summarise(booking) });
            return followCall(j.sid, booking, 0);
          }

          return 'booking failed: ' + (j.error || 'HTTP ' + res.status);
        })
        .catch(function (e) {
          return 'booking failed: ' + ((e && e.message) || e);
        });
    },
  });

  // Terminal states end the wait; anything else is still in progress. Capped so
  // a call that never resolves does not hold the turn open forever — the sid is
  // handed back instead, and call_status picks it up later.
  var DONE = /^(completed|booked|confirmed|failed|busy|no-answer|canceled|cancelled)$/i;

  function followCall(sid, booking, tries) {
    return proxy('/api/book/status/' + encodeURIComponent(sid))
      .then(readJson)
      .then(function (res) {
        var j = res.body;
        if (res.status === 501) {
          return 'The call was placed but cannot be followed from here: ' + (j.error || 'no status available') + '.';
        }
        var state = String(j.status || 'unknown');
        if (DONE.test(state)) {
          var out = ['**Call ' + state.toLowerCase() + '** — ' + summarise(booking) + '.'];
          if (j.summary) out.push('', j.summary);
          return out.join('\n');
        }
        if (tries >= 8) {
          return (
            'Still ringing after a while (`' + state + '`). The call id is `' + sid + '` — ' +
            'ask me for its status and I will check again.'
          );
        }
        return new Promise(function (resolve) {
          setTimeout(resolve, 4000);
        }).then(function () {
          return followCall(sid, booking, tries + 1);
        });
      });
  }

  register({
    name: 'call_status',
    desc: 'Check how a booking call placed earlier is going. Provide the call id (sid).',
    p: { sid: 'string' },
    exec: function (a, ctx) {
      var sid = String(a.sid || '');
      if (!sid) return 'give me the call id';
      if (!S.dataBase) return 'booking needs the DATA PROXY';
      return proxy('/api/book/status/' + encodeURIComponent(sid))
        .then(readJson)
        .then(function (res) {
          var j = res.body;
          if (res.status === 501) return 'No call has that id: ' + (j.error || 'voice booking is unavailable') + '.';
          ctx.actions.push({ t: 'stat', label: 'call ' + sid + ': ' + (j.status || 'unknown') });
          return '**' + sid + '** — ' + (j.status || 'unknown') + (j.summary ? '\n\n' + j.summary : '');
        })
        .catch(function (e) {
          return 'could not check that call: ' + ((e && e.message) || e);
        });
    },
  });
})();
