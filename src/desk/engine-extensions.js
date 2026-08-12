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

  // ---------------------------------------------------------------------
  // Saying something true immediately
  // ---------------------------------------------------------------------
  //
  // A spinner appears because the interface has nothing true to say yet. The
  // fix is not a nicer spinner — it is to arrange for something true to be
  // available at submit, which means saying only what is already known from the
  // utterance itself. No network call, no model, no I/O of any kind: that is
  // precisely why it can appear instantly, and why it can never be wrong about
  // something it had to go and find out.
  //
  // It is a placeholder, not an answer. The first streamed token replaces it.

  function acknowledge(utterance) {
    var t = String(utterance == null ? '' : utterance).trim();
    if (!t) return 'One moment.';

    var url = t.match(/https?:\/\/([^/\s]+)/i);
    if (url) return 'Reading ' + url[1].replace(/^www\./i, '') + '…';

    if (/\bbook\b|\btable\b|\breservation\b|\bdinner\b/i.test(t)) return 'Getting the booking together…';
    if (/\bdeep[-\s]?research\b|\bresearch\b|\blook (this|that|it) up\b/i.test(t)) return 'Looking that up…';
    if (/\bportfolio\b|\bpositions\b|\bholdings\b/i.test(t)) return 'Pricing your positions…';
    if (/\bscorecard\b|\bprediction/i.test(t)) return 'Scoring the record…';
    if (/\bbacktest\b/i.test(t)) return 'Running the backtest…';
    if (/\bremember\b|\bnote that\b/i.test(t)) return 'Writing that down…';
    if (/\bbuild\b.*\bapp\b|\bcreate_prompt\b|\bbuild_app\b/i.test(t)) return 'Building that…';

    // A bare ticker is the most common thing typed here, and naming it back is
    // the most reassuring thing to say. Common English words in caps are not
    // tickers, so they fall through rather than producing "Pulling THE…".
    var sym = t.match(/\b[A-Z]{2,5}\b/);
    if (sym && !/^(THE|AND|FOR|YOU|ARE|WAS|BUT|NOT|CAN|HOW|WHY|WHO|ALL|ANY|NEW|NOW|OUT|GET|LET|SEE|USE|ITS|OUR)$/.test(sym[0])) {
      return 'Pulling ' + sym[0] + '…';
    }

    if (/\?\s*$/.test(t)) return 'Thinking about that…';
    return 'On it…';
  }

  // Every turn opens through here, so this is the one place that covers typed
  // input, spoken input, tapped suggestions and dossiers alike. Reassigning the
  // engine's own binding works because this file is spliced into its scope —
  // from outside, the function is unreachable.
  if (typeof openLiveTurn === 'function') {
    var openLiveTurnBase = openLiveTurn;
    // eslint-disable-next-line no-func-assign
    openLiveTurn = function (turn) {
      var live = openLiveTurnBase(turn);
      try {
        live.setBody(acknowledge(turn && turn.user));
      } catch (e) {
        /* an acknowledgement is never worth breaking a turn over */
      }
      return live;
    };
  }

  // ---------------------------------------------------------------------
  // Waking up
  // ---------------------------------------------------------------------
  //
  // The desk greets on boot from what the browser knows, which is nothing about
  // what happened while the tab was closed — and that is the only interesting
  // thing to say on waking. This asks the server what it has been doing and
  // reports it, so the greeting carries information rather than atmosphere.

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function wakeLine(state, activity) {
    var goals = (state && state.goals) || [];
    var armed = goals.filter(function (g) {
      return g.enabled;
    }).length;

    var hour = new Date().getHours();
    var parts = [(hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening') + ', ' + S.name + '.'];

    // Nothing came back, so nothing is claimed. "No goals armed" here would be
    // an answer invented out of a call that failed — and the greeting exists to
    // report what happened while the tab was shut, which is exactly what a desk
    // that cannot reach its server does not know.
    if (!state) {
      parts.push('I cannot reach the server, so this is a local greeting only.');
      return parts.join(' ');
    }

    parts.push(armed ? plural(armed, 'goal', 'goals') + ' armed.' : 'No goals armed.');

    // Only what happened since the tab was last open is news.
    var since = Date.now() - 12 * 3600 * 1000;
    var recent = ((activity && activity.activity) || []).filter(function (a) {
      return a && a.t > since;
    });
    if (recent.length) {
      var last = recent[0];
      parts.push(plural(recent.length, 'thing', 'things') + ' fired in the last twelve hours,');
      parts.push('most recently ' + String(last.label || last.text || 'a goal').replace(/\s+/g, ' ').slice(0, 70) + '.');
    } else if (armed) {
      parts.push('Nothing fired while you were away.');
    }

    return parts.join(' ');
  }

  // How long the greeting waits for the server to tell it something worth
  // adding. Past this it is said anyway: a desk that stays silent because a
  // status call is slow has told the operator nothing at all, which is worse
  // than telling them the half it always knew.
  var WAKE_ENRICH_MS = 1200;

  // Why the last greeting had nothing from the server, kept for diagnosis. The
  // greeting used to swallow this and simply not happen, which left no way to
  // tell a missing DATA PROXY from a broken one from a desk that never woke.
  var lastWakeError = null;

  function serverState() {
    if (!S.dataBase) return Promise.resolve(null);
    return Promise.all([
      proxy('/api/autonomy').then(readJson),
      proxy('/api/autonomy/activity?limit=20').then(readJson),
    ])
      .then(function (both) {
        if (both[0].status !== 200) {
          lastWakeError = 'autonomy responded ' + both[0].status;
          return null;
        }
        return both;
      })
      .catch(function (err) {
        lastWakeError = (err && err.message) || String(err);
        return null;
      });
  }

  function wake() {
    if (!S.dataBase) lastWakeError = 'no DATA PROXY configured';

    // The hour and the operator's name are known before anything is asked of
    // anyone, so the greeting never depends on a round trip completing. What
    // the server knows — goals armed, what fired overnight — is news, and news
    // is allowed to arrive late or not at all.
    var settled = false;
    function greet(both) {
      if (settled) return;
      settled = true;
      var line = wakeLine(both && both[0].body, both && both[1].body);
      pushTurn({
        user: '(waking up)',
        agentId: 'chief',
        agentName: 'Chief of staff',
        color: 'cyan',
        md: line,
        text: line,
        pre: null,
        actions: [],
        t: Date.now(),
      });
      try {
        speak(line);
      } catch (e) {
        /* a greeting is not worth an error card */
      }
    }

    var timer = setTimeout(function () {
      greet(null);
    }, WAKE_ENRICH_MS);

    serverState().then(function (both) {
      clearTimeout(timer);
      greet(both);
    });
  }

  // Speech on a phone may only start from something the operator did. The
  // greeting arrives on a timer, after a network call, which is not that — so
  // the synthesiser is opened here, inside the tap that entered the desk, with
  // an utterance that says nothing. What is spoken later inherits the
  // permission this one was granted.
  function primeSpeech() {
    try {
      if (!('speechSynthesis' in window)) return;
      var u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      u.__saPrime = true; // the server panel's patch lets this one straight through
      window.speechSynthesis.speak(u);
    } catch (e) {
      /* no synthesiser here; nothing was going to be spoken anyway */
    }
  }

  // Fires on entering the desk rather than at load, so it lands after the HUD
  // is visible and never speaks to an empty room.
  var enterBase = window.__saEnter;
  window.__saEnter = function () {
    primeSpeech(); // synchronous, inside the tap — this is the whole point of it
    if (typeof enterBase === 'function') {
      try {
        enterBase();
      } catch (e) {
        /* the desk's own entry must not be blocked by ours */
      }
    }
    setTimeout(wake, 700);
  };

  // A test seam. These are pure functions with no side effects; exposing them
  // is what lets them be asserted directly rather than through the DOM.
  window.__saExt = {
    acknowledge: acknowledge,
    wakeLine: wakeLine,
    wake: wake,
    wakeError: function () {
      return lastWakeError;
    },
  };
})();
