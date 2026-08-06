/* SurfingAlien — server runtime panel.
 *
 * The desk's own autonomy loop only runs while the tab is open. This panel is
 * the window onto the copy that keeps running without it: what the server has
 * armed, what it has fired, and how to move a brain between the two.
 *
 * It lives outside index.html on purpose. The desk is authored elsewhere and
 * re-uploaded whole, so anything written into it would be overwritten on the
 * next revision — a companion file survives, and it stays inert if the server
 * is not reachable.
 */
(function () {
  'use strict';

  var API = '';
  var open = false;
  var timer = null;
  var mounted = false;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function api(path, options) {
    return fetch(API + path, options).then(function (r) {
      return r.json().then(
        function (j) {
          return { status: r.status, json: j };
        },
        function () {
          return { status: r.status, json: null };
        },
      );
    });
  }

  function say(msg, kind) {
    // Reuse the desk's toast when it exists so messaging stays consistent.
    if (typeof window.toast === 'function') {
      window.toast(msg, kind);
      return;
    }
    var note = document.querySelector('.sasrv-note');
    if (note) {
      note.textContent = msg;
      note.className = 'sasrv-note' + (kind ? ' ' + kind : '');
    }
  }

  function secs(n) {
    if (n == null) return '--';
    n = Math.max(0, n | 0);
    var m = Math.floor(n / 60);
    var s = n % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function ago(t) {
    var d = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (d < 60) return d + 's ago';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
  }

  /* ---------- styles ---------- */

  var CSS = [
    '.sasrv-btn{font-family:var(--disp,sans-serif);font-weight:600;font-size:12px;letter-spacing:1px;color:var(--ink,#eaf4ff);background:var(--glass,rgba(10,30,60,.46));border:1px solid var(--line,rgba(120,190,255,.14));padding:8px 12px;border-radius:8px;cursor:pointer;backdrop-filter:blur(8px);transition:.2s;display:flex;align-items:center;gap:7px}',
    '.sasrv-btn:hover{border-color:var(--cyan,#4fd0e6);color:#fff;box-shadow:0 0 16px rgba(79,208,230,.25)}',
    '.sasrv-btn .sasrv-dot{width:8px;height:8px;border-radius:50%;background:var(--ok,#46e0a0);box-shadow:0 0 8px var(--ok,#46e0a0)}',
    '.sasrv-btn.sasrv-float{position:fixed;left:24px;bottom:24px;z-index:41}',
    '.sasrv-panel{position:fixed;top:0;right:0;height:100%;width:430px;max-width:95vw;z-index:40;background:linear-gradient(180deg,rgba(6,20,46,.97),rgba(4,14,34,.99));border-left:1px solid var(--line,rgba(120,190,255,.14));transform:translateX(105%);transition:transform .4s cubic-bezier(.6,.05,.2,1);display:flex;flex-direction:column;backdrop-filter:blur(14px);font-family:var(--body,sans-serif)}',
    '.sasrv-panel.on{transform:translateX(0)}',
    '.sasrv-head{padding:16px 18px 12px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line,rgba(120,190,255,.14))}',
    '.sasrv-head h2{font-family:var(--disp,sans-serif);font-weight:600;font-size:14px;letter-spacing:2px;color:var(--cyan,#4fd0e6);margin:0}',
    '.sasrv-head .sasrv-x{cursor:pointer;color:var(--ink-faint,#5d7aa3);font-size:20px;line-height:1;background:none;border:none}',
    '.sasrv-head .sasrv-x:hover{color:#fff}',
    '.sasrv-body{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:14px;scrollbar-width:thin}',
    '.sasrv-body::-webkit-scrollbar{width:7px}.sasrv-body::-webkit-scrollbar-thumb{background:var(--line,rgba(120,190,255,.14));border-radius:4px}',
    '.sasrv-h{font-family:var(--disp,sans-serif);font-size:10px;letter-spacing:2px;color:var(--ink-faint,#5d7aa3);text-transform:uppercase}',
    '.sasrv-stat{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.sasrv-cell{background:rgba(120,190,255,.04);border:1px solid var(--line,rgba(120,190,255,.14));border-left:3px solid var(--cyan-d,#1c8fc4);border-radius:3px;padding:8px 10px}',
    '.sasrv-cell .k{font-family:var(--mono,monospace);font-size:8.5px;letter-spacing:1.5px;color:var(--ink-faint,#5d7aa3);text-transform:uppercase}',
    '.sasrv-cell .v{font-family:var(--big,sans-serif);font-weight:700;font-size:15px;color:#fff;margin-top:2px}',
    '.sasrv-cell.off{border-left-color:var(--ink-faint,#5d7aa3);opacity:.65}',
    '.sasrv-cell.ok{border-left-color:var(--ok,#46e0a0)}',
    '.sasrv-row{display:grid;grid-template-columns:1fr auto;gap:5px 10px;align-items:center;background:rgba(120,190,255,.04);border:1px solid var(--line,rgba(120,190,255,.14));border-left:3px solid var(--cyan-d,#1c8fc4);border-radius:3px;padding:9px 11px}',
    '.sasrv-row.off{opacity:.5;border-left-color:var(--ink-faint,#5d7aa3)}',
    '.sasrv-row .nm{font-family:var(--disp,sans-serif);font-weight:600;font-size:12px;color:var(--ink,#eaf4ff)}',
    '.sasrv-row .ds{font-family:var(--mono,monospace);font-size:10px;color:var(--ink-faint,#5d7aa3);grid-column:1/-1;line-height:1.5;word-break:break-word;white-space:pre-line}',
    '.sasrv-row .ctl{display:flex;gap:5px}',
    '.sasrv-row .ctl button{font-family:var(--mono,monospace);font-size:9.5px;background:none;border:1px solid var(--line,rgba(120,190,255,.14));color:var(--ink-dim,#9fb8d8);border-radius:5px;padding:3px 7px;cursor:pointer}',
    '.sasrv-row .ctl button:hover{border-color:var(--cyan,#4fd0e6);color:#fff}',
    '.sasrv-row .ctl button.on{border-color:var(--ok,#46e0a0);color:var(--ok,#46e0a0)}',
    '.sasrv-form{display:grid;grid-template-columns:1fr 92px;gap:6px}',
    '.sasrv-form input{font-family:var(--mono,monospace);font-size:11px;background:rgba(0,0,0,.3);border:1px solid var(--line,rgba(120,190,255,.14));border-radius:6px;padding:7px 9px;color:var(--ink,#eaf4ff);outline:none;min-width:0}',
    '.sasrv-form input:focus{border-color:var(--cyan-d,#1c8fc4)}',
    '.sasrv-form .full{grid-column:1/-1}',
    '.sasrv-go{font-family:var(--disp,sans-serif);font-weight:700;font-size:11px;letter-spacing:1px;color:var(--bg0,#070d18);background:var(--cyan,#4fd0e6);border:none;border-radius:6px;padding:8px 12px;cursor:pointer}',
    '.sasrv-go:hover{filter:brightness(1.08)}',
    '.sasrv-go.gh{background:none;color:var(--ink-dim,#9fb8d8);border:1px solid var(--line,rgba(120,190,255,.14))}',
    '.sasrv-go.gh:hover{border-color:var(--cyan,#4fd0e6);color:#fff}',
    '.sasrv-act{font-family:var(--mono,monospace);font-size:10.5px;color:var(--ink-dim,#9fb8d8);padding:6px 0;border-bottom:1px dashed var(--line,rgba(120,190,255,.14));line-height:1.5}',
    '.sasrv-act .g{color:var(--cyan,#4fd0e6)}',
    '.sasrv-act .t{color:var(--ink-faint,#5d7aa3);font-size:9px;margin-left:6px}',
    '.sasrv-act.bad .g{color:var(--warn,#ff7a5c)}',
    '.sasrv-empty{font-family:var(--mono,monospace);font-size:11px;color:var(--ink-faint,#5d7aa3);padding:10px 2px;text-align:center}',
    '.sasrv-note{font-family:var(--mono,monospace);font-size:9.5px;color:var(--ink-faint,#5d7aa3);line-height:1.6}',
    '.sasrv-note.warn{color:var(--warn,#ff7a5c)}.sasrv-note.ok{color:var(--ok,#46e0a0)}',
    '.sasrv-pair{display:flex;gap:6px}',
  ].join('\n');

  /* ---------- voice ----------
   *
   * The desk's speak() lives inside the engine's closure, so it cannot be
   * replaced from out here. speechSynthesis.speak is the boundary both sides
   * share: intercept there and every existing call site — dossiers, mission
   * summaries, reminders — gets briefed instead of read out as markup.
   */

  var VOICE_KEY = 'sa_srv_voice';
  var INTENT_KEY = 'sa_srv_intent';
  var voiceMode = 'brief'; // 'brief' | 'verbatim'
  var intentMode = true;
  var serverReady = false;
  var speakSeq = 0;
  var lastScript = null;
  var lastIntent = null;

  function loadVoiceMode() {
    try {
      var v = localStorage.getItem(VOICE_KEY);
      if (v === 'verbatim' || v === 'brief') voiceMode = v;
      var i = localStorage.getItem(INTENT_KEY);
      if (i === 'off') intentMode = false;
    } catch (e) {
      /* private mode — the defaults stand */
    }
  }

  function saveVoiceMode() {
    try {
      localStorage.setItem(VOICE_KEY, voiceMode);
      localStorage.setItem(INTENT_KEY, intentMode ? 'on' : 'off');
    } catch (e) {
      /* nothing to do; the modes still apply for this session */
    }
  }

  function installVoice() {
    if (!('speechSynthesis' in window) || window.__saVoicePatched) return;
    var synth = window.speechSynthesis;
    var original = synth.speak.bind(synth);
    window.__saVoicePatched = true;

    synth.speak = function (utterance) {
      var text = utterance && utterance.text ? String(utterance.text) : '';
      if (!serverReady || voiceMode === 'verbatim' || !text) return original(utterance);

      // Claim a ticket. If the desk starts saying something newer while the
      // rewrite is in flight, the stale one is dropped rather than queued —
      // hearing the previous answer after the current one is worse than
      // silence.
      var ticket = ++speakSeq;

      api('/api/voice/brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, title: document.title }),
      })
        .then(function (res) {
          if (ticket !== speakSeq) return;
          var script = res.json && res.json.ok && res.json.script;
          speakScript(script || text, utterance, original, (res.json && res.json.source) || 'raw');
        })
        .catch(function () {
          if (ticket !== speakSeq) return;
          // Server unreachable mid-session: better the old behaviour than none.
          speakScript(text, utterance, original, 'raw');
        });
    };
  }

  function speakScript(script, source, original, kind) {
    lastScript = { text: script, source: kind, t: Date.now() };
    renderVoice();
    try {
      var u = new SpeechSynthesisUtterance(script);
      // A briefing reads a touch slower than a data dump; keep whatever the
      // desk asked for otherwise.
      u.rate = source && source.rate ? source.rate : 1;
      u.pitch = source && source.pitch ? source.pitch : 1;
      if (source && source.voice) u.voice = source.voice;
      if (source && source.lang) u.lang = source.lang;
      original(u);
    } catch (e) {
      /* synthesis unavailable */
    }
  }

  /* ---------- voice in ----------
   *
   * The desk's recogniser accumulates a transcript in onresult and runs it in
   * onend, both closure-scoped. Wrapping the SpeechRecognition constructor
   * gets between them: we hold the desk's own handlers, translate the
   * transcript on the way through, and hand it back in the shape its handler
   * already expects. It hears a command; the operator spoke English.
   */
  function installIntent() {
    var Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor || window.__saIntentPatched) return;
    window.__saIntentPatched = true;

    function Wrapped() {
      var rec = new Ctor();
      var deskResult = null;
      var deskEnd = null;
      var heard = '';

      rec.addEventListener('result', function (e) {
        // Track the final transcript ourselves; the desk's copy is rebuilt
        // from the event we synthesise later.
        for (var i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) heard += e.results[i][0].transcript;
        }
      });

      Object.defineProperty(rec, 'onresult', {
        configurable: true,
        get: function () {
          return deskResult;
        },
        set: function (fn) {
          deskResult = fn;
          // Live interim text still reaches the desk untouched, so the caption
          // keeps updating while someone is still talking.
          rec.addEventListener('result', function (e) {
            if (deskResult) deskResult(e);
          });
        },
      });

      Object.defineProperty(rec, 'onend', {
        configurable: true,
        get: function () {
          return deskEnd;
        },
        set: function (fn) {
          deskEnd = fn;
          rec.addEventListener('end', function () {
            var said = heard.trim();
            heard = '';
            if (!serverReady || !intentMode || !said) {
              if (deskEnd) deskEnd();
              return;
            }
            var brief = document.getElementById('brief');
            if (brief) brief.textContent = 'understanding…';

            api('/api/intent', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ transcript: said }),
            })
              .then(function (res) {
                var out = res.json && res.json.ok ? res.json : null;
                deliver(out && out.command ? out.command : said, said, out);
              })
              .catch(function () {
                deliver(said, said, null);
              });
          });
        },
      });

      // Replay the (possibly rewritten) transcript through the desk's own
      // handler, so its bookkeeping runs exactly as it would have.
      function deliver(command, said, meta) {
        lastIntent = {
          said: said,
          command: command,
          rewritten: Boolean(meta && meta.rewritten),
          source: (meta && meta.source) || 'passthrough',
        };
        renderVoice();
        if (deskResult) {
          deskResult({
            resultIndex: 0,
            results: (function () {
              var alt = { transcript: command, confidence: 1 };
              var entry = [alt];
              entry.isFinal = true;
              var list = [entry];
              list.length = 1;
              return list;
            })(),
          });
        }
        if (deskEnd) deskEnd();
      }

      return rec;
    }

    window.SpeechRecognition = Wrapped;
    window.webkitSpeechRecognition = Wrapped;
  }

  function renderVoice() {
    if (!refs.voiceMode) return;
    refs.voiceMode.textContent = voiceMode === 'brief' ? 'BRIEFING' : 'VERBATIM';
    refs.voiceMode.className = 'sasrv-go' + (voiceMode === 'brief' ? '' : ' gh');
    if (refs.intentMode) {
      refs.intentMode.textContent = intentMode ? 'INTENT ON' : 'INTENT OFF';
      refs.intentMode.className = 'sasrv-go' + (intentMode ? '' : ' gh');
    }
    if (refs.voiceLast) {
      refs.voiceLast.textContent = lastScript
        ? '“' + lastScript.text + '” — ' + lastScript.source
        : 'Nothing spoken yet. The desk speaks when SPEAK is on in its settings.';
    }
    if (refs.intentLast) {
      refs.intentLast.textContent = lastIntent
        ? lastIntent.rewritten
          ? 'heard “' + lastIntent.said + '” → ran “' + lastIntent.command + '”'
          : 'heard “' + lastIntent.said + '” → passed through (' + lastIntent.source + ')'
        : 'Nothing heard yet. Hold SPACE and speak.';
    }
  }

  /* ---------- genome bridge ---------- */

  // Read straight from localStorage rather than the engine's closure: the desk
  // is re-authored often, and its storage keys are the stable contract.
  function readLS(key, fallback) {
    try {
      var v = localStorage.getItem('sa_' + key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }

  function writeLS(key, value) {
    try {
      localStorage.setItem('sa_' + key, JSON.stringify(value));
    } catch (e) {
      /* quota or private mode — the push still succeeded server-side */
    }
  }

  function localGenome() {
    return {
      kind: 'surfingalien-genome',
      v: 5,
      name: readLS('name', 'Operator'),
      exported: new Date().toISOString(),
      source: 'desk',
      memory: readLS('memory', []),
      tasks: readLS('tasks', []),
      prefs: readLS('prefs', { boost: {} }),
      goals: readLS('goals', []),
      workers: readLS('workers', []),
      watchlist: readLS('watchlist', []),
      portfolio: readLS('portfolio', []),
      consensus: readLS('consensus', false),
      skills: readLS('skills', []),
    };
  }

  function pushGenome() {
    var g = localGenome();
    return api('/api/genome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(g),
    }).then(function (res) {
      if (!res.json || !res.json.ok) {
        say('genome push failed', 'warn');
        return;
      }
      var skipped = res.json.skipped || [];
      say(
        'pushed: ' +
          res.json.importedGoals +
          ' goal(s)' +
          (skipped.length ? ', ' + skipped.length + ' not runnable server-side' : ''),
        'ok',
      );
      if (skipped.length) {
        setNote(
          'Not armed on the server: ' +
            skipped
              .map(function (s) {
                return s.name + ' (' + s.reason + ')';
              })
              .join('; '),
          'warn',
        );
      }
      refresh();
    });
  }

  function pullGenome() {
    return api('/api/genome').then(function (res) {
      var g = res.json;
      if (!g || g.kind !== 'surfingalien-genome') {
        say('no genome on the server', 'warn');
        return;
      }
      var counts =
        (g.goals || []).length + ' goal(s), ' + (g.memory || []).length + ' memory item(s)';
      if (
        !window.confirm(
          'Merge the server brain into this desk?\n\n' +
            counts +
            '\n\nThe page reloads so the engine picks it up.',
        )
      ) {
        return;
      }
      // Merge by identity so a pull never duplicates what is already here.
      var goals = readLS('goals', []);
      (g.goals || []).forEach(function (sg) {
        var clash = goals.some(function (x) {
          return x.name === sg.name && x.condText === sg.condText;
        });
        if (!clash) goals.push(sg);
      });
      var memory = readLS('memory', []);
      (g.memory || []).forEach(function (sm) {
        var i = memory.findIndex(function (x) {
          return x.k === sm.k;
        });
        if (i >= 0) memory[i] = sm;
        else memory.push(sm);
      });
      var watchlist = readLS('watchlist', []);
      (g.watchlist || []).forEach(function (w) {
        if (
          !watchlist.some(function (x) {
            return x.sym === w.sym;
          })
        ) {
          watchlist.push(w);
        }
      });
      writeLS('goals', goals);
      writeLS('memory', memory);
      writeLS('watchlist', watchlist);
      if (Array.isArray(g.tasks) && g.tasks.length) writeLS('tasks', g.tasks);
      if (Array.isArray(g.portfolio) && g.portfolio.length) writeLS('portfolio', g.portfolio);
      location.reload();
    });
  }

  /* ---------- rendering ---------- */

  var refs = {};

  function setNote(text, kind) {
    if (!refs.note) return;
    refs.note.textContent = text || '';
    refs.note.className = 'sasrv-note' + (kind ? ' ' + kind : '');
  }

  function cell(key, value, cls) {
    var box = el('div', 'sasrv-cell' + (cls ? ' ' + cls : ''));
    box.appendChild(el('div', 'k', key));
    box.appendChild(el('div', 'v', value));
    return box;
  }

  function renderStatus(cfg) {
    var box = refs.status;
    box.innerHTML = '';
    var au = cfg.autonomy || {};
    box.appendChild(
      cell('loop', au.enabled ? (au.running ? 'RUNNING' : 'IDLE') : 'OFF', au.running ? 'ok' : 'off'),
    );
    box.appendChild(cell('goals armed', (au.armed || 0) + '/' + (au.goals || 0)));
    box.appendChild(
      cell(
        'brain',
        cfg.brain && cfg.brain.configured ? 'PROXIED' : 'OFF',
        cfg.brain && cfg.brain.configured ? 'ok' : 'off',
      ),
    );
    box.appendChild(
      cell(
        'alerts',
        cfg.notify && cfg.notify.configured ? 'WEBHOOK' : 'OFF',
        cfg.notify && cfg.notify.configured ? 'ok' : 'off',
      ),
    );
    box.appendChild(cell('next goal', secs(au.nextGoalInSec)));
    box.appendChild(cell('ticks', String(au.ticks || 0)));

    if (refs.launcherDot) {
      refs.launcherDot.style.background = au.running ? 'var(--ok,#46e0a0)' : 'var(--amber,#f5c451)';
      refs.launcherDot.style.boxShadow =
        '0 0 8px ' + (au.running ? 'var(--ok,#46e0a0)' : 'var(--amber,#f5c451)');
    }
  }

  function goalRow(goal) {
    var row = el('div', 'sasrv-row' + (goal.enabled ? '' : ' off'));
    row.appendChild(el('div', 'nm', goal.name));

    var ctl = el('div', 'ctl');
    var toggle = el('button', goal.enabled ? 'on' : '', goal.enabled ? 'ON' : 'OFF');
    toggle.onclick = function () {
      api('/api/autonomy/goals/' + goal.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !goal.enabled }),
      }).then(refresh);
    };
    var run = el('button', null, 'RUN');
    run.onclick = function () {
      run.textContent = '...';
      api('/api/autonomy/goals/' + goal.id + '/run', { method: 'POST' }).then(function (res) {
        var a = res.json && res.json.activity;
        say(a ? goal.name + ': ' + a.summary : 'run failed', a && a.ok ? 'ok' : 'warn');
        refresh();
      });
    };
    var del = el('button', null, 'DEL');
    del.onclick = function () {
      if (!window.confirm('Disarm "' + goal.name + '" on the server?')) return;
      api('/api/autonomy/goals/' + goal.id, { method: 'DELETE' }).then(refresh);
    };
    ctl.appendChild(toggle);
    ctl.appendChild(run);
    ctl.appendChild(del);
    row.appendChild(ctl);

    var detail = goal.condText + ' → ' + goal.actionText + '  · every ' + goal.cadenceSec + 's';
    if (goal.lastResult) detail += '\nlast: ' + goal.lastResult.summary;
    row.appendChild(el('div', 'ds', detail));
    return row;
  }

  function renderGoals(goals) {
    var box = refs.goals;
    box.innerHTML = '';
    if (!goals.length) {
      box.appendChild(el('div', 'sasrv-empty', 'nothing armed on the server'));
      return;
    }
    goals.forEach(function (g) {
      box.appendChild(goalRow(g));
    });
  }

  function renderActivity(items) {
    var box = refs.activity;
    box.innerHTML = '';
    if (!items.length) {
      box.appendChild(el('div', 'sasrv-empty', 'nothing has fired yet'));
      return;
    }
    items.slice(0, 12).forEach(function (a) {
      var line = el('div', 'sasrv-act' + (a.ok === false ? ' bad' : ''));
      var name = el('span', 'g', a.goal || a.kind);
      line.appendChild(name);
      line.appendChild(document.createTextNode(' ' + a.summary));
      line.appendChild(el('span', 't', ago(a.t)));
      box.appendChild(line);
    });
  }

  function refresh() {
    return Promise.all([api('/api/config'), api('/api/autonomy'), api('/api/autonomy/activity?limit=12')])
      .then(function (res) {
        if (res[0].json) renderStatus(res[0].json);
        if (res[1].json && res[1].json.ok) renderGoals(res[1].json.goals || []);
        if (res[2].json && res[2].json.ok) renderActivity(res[2].json.activity || []);
      })
      .catch(function () {
        setNote('server unreachable', 'warn');
      });
  }

  /* ---------- panel ---------- */

  function buildPanel() {
    var panel = el('aside', 'sasrv-panel');
    panel.id = 'sasrvPanel';

    var head = el('div', 'sasrv-head');
    head.appendChild(el('h2', null, 'SERVER RUNTIME'));
    var close = el('button', 'sasrv-x', '×');
    close.setAttribute('aria-label', 'close server runtime');
    close.onclick = toggle;
    head.appendChild(close);
    panel.appendChild(head);

    var body = el('div', 'sasrv-body');

    body.appendChild(el('div', 'sasrv-h', 'status'));
    refs.status = el('div', 'sasrv-stat');
    body.appendChild(refs.status);

    body.appendChild(el('div', 'sasrv-h', 'goals running without this tab'));
    refs.goals = el('div', 'sasrv-stat');
    refs.goals.style.gridTemplateColumns = '1fr';
    body.appendChild(refs.goals);

    var form = el('div', 'sasrv-form');
    var name = el('input');
    name.placeholder = 'goal name';
    name.className = 'full';
    var cond = el('input');
    cond.placeholder = 'condition — e.g. price(NVDA) > 140';
    cond.className = 'full';
    var action = el('input');
    action.placeholder = 'action — e.g. alert NVDA broke out ($NVDA)';
    var cadence = el('input');
    cadence.placeholder = 'sec';
    cadence.value = '300';
    var arm = el('button', 'sasrv-go full', 'ARM ON SERVER');
    arm.onclick = function () {
      if (!cond.value.trim() || !action.value.trim()) {
        say('condition and action are required', 'warn');
        return;
      }
      api('/api/autonomy/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.value.trim() || 'goal',
          condText: cond.value.trim(),
          actionText: action.value.trim(),
          cadenceSec: parseInt(cadence.value, 10) || 300,
        }),
      }).then(function (res) {
        if (res.status === 201) {
          say('armed on the server', 'ok');
          setNote('');
          name.value = '';
          cond.value = '';
          action.value = '';
          refresh();
        } else {
          // The server refuses conditions and actions it cannot run, rather
          // than accepting them and failing silently at 3am.
          setNote((res.json && res.json.error) || 'refused', 'warn');
        }
      });
    };
    form.appendChild(name);
    form.appendChild(cond);
    form.appendChild(action);
    form.appendChild(cadence);
    form.appendChild(arm);
    body.appendChild(form);

    refs.note = el('div', 'sasrv-note');
    body.appendChild(refs.note);

    body.appendChild(el('div', 'sasrv-h', 'voice'));
    var voiceRow = el('div', 'sasrv-pair');
    refs.voiceMode = el('button', 'sasrv-go', 'BRIEFING');
    refs.voiceMode.onclick = function () {
      voiceMode = voiceMode === 'brief' ? 'verbatim' : 'brief';
      saveVoiceMode();
      renderVoice();
      say('voice: ' + (voiceMode === 'brief' ? 'briefing' : 'verbatim'), 'ok');
    };
    var tryVoice = el('button', 'sasrv-go gh', 'TEST');
    tryVoice.onclick = function () {
      // Deliberately the worst case: a table, citations and four-decimal
      // figures — what a dossier actually sounds like without this.
      var sample =
        '## NVDA — Dossier\n| Metric | Value |\n|---|---|\n| Last | $142.6234 |\n| RSI(14) | 68.3129 |\n' +
        '\n**VERDICT:** BUY (M) — entry $142.62 — stop $131.40 — target $168.90 — risk 6/10 [1]\n' +
        'Momentum is positive with price 12.4531% above the 200-day average.';
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(sample));
    };
    voiceRow.appendChild(refs.voiceMode);
    voiceRow.appendChild(tryVoice);
    body.appendChild(voiceRow);
    refs.voiceLast = el('div', 'sasrv-note');
    body.appendChild(refs.voiceLast);
    body.appendChild(
      el(
        'div',
        'sasrv-note',
        'Briefing rewrites what the desk is about to say into a few spoken sentences — the call first, then why, with numbers rounded the way people say them. Verbatim reads the raw text.',
      ),
    );

    var intentRow = el('div', 'sasrv-pair');
    refs.intentMode = el('button', 'sasrv-go', 'INTENT ON');
    refs.intentMode.onclick = function () {
      intentMode = !intentMode;
      saveVoiceMode();
      renderVoice();
      say('spoken intent: ' + (intentMode ? 'on' : 'off'), 'ok');
    };
    intentRow.appendChild(refs.intentMode);
    body.appendChild(intentRow);
    refs.intentLast = el('div', 'sasrv-note');
    body.appendChild(refs.intentLast);
    body.appendChild(
      el(
        'div',
        'sasrv-note',
        'With intent on, “how is my portfolio doing” becomes “positions” before the desk sees it. Anything that does not map to a command it knows is passed through exactly as spoken.',
      ),
    );

    body.appendChild(el('div', 'sasrv-h', 'activity'));
    refs.activity = el('div');
    body.appendChild(refs.activity);

    body.appendChild(el('div', 'sasrv-h', 'genome sync'));
    var pair = el('div', 'sasrv-pair');
    var push = el('button', 'sasrv-go', 'PUSH TO SERVER');
    push.onclick = pushGenome;
    var pull = el('button', 'sasrv-go gh', 'PULL TO DESK');
    pull.onclick = pullGenome;
    pair.appendChild(push);
    pair.appendChild(pull);
    body.appendChild(pair);
    body.appendChild(
      el(
        'div',
        'sasrv-note',
        'Push hands this desk’s goals, memory and watchlist to the server so they keep running with the tab closed. Pull merges the server brain back in.',
      ),
    );

    panel.appendChild(body);
    return panel;
  }

  function toggle() {
    open = !open;
    refs.panel.classList.toggle('on', open);
    if (open) {
      refresh();
      timer = setInterval(refresh, 15000);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function mount(cfg) {
    if (mounted) return;
    mounted = true;

    var style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    refs.panel = buildPanel();
    document.body.appendChild(refs.panel);

    // Floated bottom-left rather than docked in the desk's toolbar: the drawer
    // opens over the toolbar's right edge and would swallow the click.
    var launcher = el('button', 'sasrv-btn sasrv-float');
    refs.launcherDot = el('span', 'sasrv-dot');
    launcher.appendChild(refs.launcherDot);
    launcher.appendChild(document.createTextNode('SERVER'));
    launcher.title = 'goals the server keeps running with this tab closed';
    launcher.onclick = toggle;
    document.body.appendChild(launcher);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) toggle();
    });

    renderStatus(cfg);
    renderVoice();
  }

  function boot() {
    // Silence is the right outcome when the desk is opened from disk or the
    // server is down: the panel never appears, and both patches stay dormant
    // because serverReady is never set.
    api('/api/config')
      .then(function (res) {
        if (res.status !== 200 || !res.json || !res.json.ok) return;
        serverReady = true;
        mount(res.json);
      })
      .catch(function () {});
  }

  // Installed synchronously, before the engine runs. The desk captures the
  // SpeechRecognition constructor into a local the moment it boots, so a patch
  // that waited for the config round trip would lose the race and leave voice
  // input untouched. Both patches check serverReady at call time instead, so
  // installing early changes nothing until there is a server to talk to.
  loadVoiceMode();
  installVoice();
  installIntent();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
