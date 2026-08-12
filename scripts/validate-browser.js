#!/usr/bin/env node
// The half of validation a route walk cannot reach: does the desk actually
// boot in a browser, does the SERVER panel mount, does a goal arm from the UI,
// and is a dossier briefed aloud rather than recited digit by digit.
//
// Driven by scripts/validate.js, which supplies a running server. Run alone it
// needs VALIDATE_BASE and VALIDATE_TOKEN.
//
// Exit codes: 0 passed, 1 failed, 2 skipped (no browser available). Skipping is
// printed, never counted as a pass — an absent Chromium must not read as green.

const BASE = process.env.VALIDATE_BASE;
const TOKEN = process.env.VALIDATE_TOKEN;

if (!BASE || !TOKEN) {
  console.log('validate-browser: set VALIDATE_BASE and VALIDATE_TOKEN, or run `npm run validate -- --browser`');
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.log('\x1b[33m~\x1b[0m browser pass skipped: playwright-core is not installed');
    console.log('\x1b[2m  npm i -D playwright-core   (Chromium is already present in most CI images)\x1b[0m');
    process.exit(2);
  }
}

const checks = [];
const check = (label, pass, detail = '') => {
  checks.push({ label, pass });
  console.log(`${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
};

// Honour an explicit path, then the layout Playwright's own installer uses,
// then let Playwright find its own download.
async function launch() {
  const explicit = process.env.CHROMIUM_PATH;
  const attempts = explicit ? [{ executablePath: explicit }, {}] : [{}];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    try {
      for (const entry of fs.readdirSync(root)) {
        if (!/^chromium/.test(entry)) continue;
        for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
          const candidate = path.join(root, entry, rel);
          if (fs.existsSync(candidate)) attempts.push({ executablePath: candidate });
        }
      }
      const bare = path.join(root, 'chromium');
      if (fs.existsSync(bare)) attempts.push({ executablePath: bare });
    } catch {
      /* nothing readable there; fall through to Playwright's own resolution */
    }
  }
  let last;
  for (const opts of attempts) {
    try {
      return await chromium.launch(opts);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

let browser;
try {
  browser = await launch();
} catch (err) {
  console.log(`\x1b[33m~\x1b[0m browser pass skipped: no launchable Chromium (${String(err.message).split('\n')[0]})`);
  process.exit(2);
}

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Counted rather than inspected: whether a translation happened early is a
// question about when a request left, which the page itself cannot answer.
const intentCalls = [];
page.on('request', (r) => {
  if (r.url().includes('/api/intent')) intentCalls.push(Date.now());
});

// Chromium ships neither speech synthesis nor recognition, so both are stood
// in for before anything loads. The stand-ins record rather than simulate: what
// is being checked is what the desk *asked* to have spoken.
await page.addInitScript(() => {
  window.__spoken = [];
  window.__recs = [];
  class FakeRecognition {
    constructor() {
      window.__recs.push(this);
      this._l = {};
    }
    addEventListener(t, fn) {
      (this._l[t] = this._l[t] || []).push(fn);
    }
    _emit(t, ev) {
      (this._l[t] || []).forEach((fn) => fn(ev));
      if (this['on' + t]) this['on' + t](ev);
    }
    start() {}
    stop() {}
    // What the recogniser reports while someone is still talking: the same
    // shape as a final result, minus the commitment.
    __hear(text) {
      const entry = [{ transcript: text, confidence: 1 }];
      entry.isFinal = false;
      this._emit('result', { resultIndex: 0, results: [entry] });
    }
    __say(text) {
      const entry = [{ transcript: text, confidence: 1 }];
      entry.isFinal = true;
      this._emit('result', { resultIndex: 0, results: [entry] });
      this._emit('end', {});
    }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  const wait = setInterval(() => {
    if (window.speechSynthesis && !window.__hooked) {
      window.__hooked = true;
      const real = window.speechSynthesis.speak.bind(window.speechSynthesis);
      window.speechSynthesis.speak = (u) => {
        window.__spoken.push(u && u.text);
        return real(u);
      };
      clearInterval(wait);
    }
  }, 5);
});

console.log('\n  the locked door');
const locked = await page.goto(BASE, { waitUntil: 'domcontentloaded' });
check('a tokenless visit is refused', locked.status() === 401, String(locked.status()));
check('and says how to unlock', (await page.content()).includes('?token='));

console.log('\n  unlocking once, by URL');
await page.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'networkidle' });
check('the token leaves the address bar', !page.url().includes('token='), page.url());
const jar = (await page.context().cookies()).find((c) => c.name === 'sa_token');
check('an httpOnly cookie replaces it', Boolean(jar && jar.httpOnly));
check('and the page source never holds it', !(await page.content()).includes(TOKEN));

console.log('\n  the desk');
const enter = page.locator('.enterbtn');
if (await enter.count()) {
  await enter.first().click();
  await page.waitForTimeout(1200);
}
check('the engine boots', await page.evaluate(() => Boolean(window.__saInit)));
check('no fatal banner', (await page.locator('#fatal.show').count()) === 0);
check('the SERVER launcher mounts', (await page.locator('.sasrv-btn').count()) === 1);

console.log('\n  one menu, two panels');
await page.locator('.sasrv-btn').click();
await page.waitForTimeout(400);
check('the launcher opens a menu, not a panel', (await page.locator('.sasrv-menu.on').count()) === 1);
check('offering both panels', (await page.locator('.sasrv-mitem').count()) === 2);

// MISSION CONTROL is the desk's own drawer, reached by its class because the
// function that opens it is closure-scoped inside the engine.
await page.locator('.sasrv-mitem', { hasText: 'MISSION CONTROL' }).click();
await page.waitForTimeout(600);
check('mission control opens from it', (await page.locator('#drawer.open').count()) === 1);
check('and the menu closes behind it', (await page.locator('.sasrv-menu.on').count()) === 0);

console.log('\n  the panel');
await page.locator('.sasrv-btn').click();
await page.waitForTimeout(300);
await page.locator('.sasrv-mitem', { hasText: 'SERVER' }).click();
await page.waitForTimeout(900);
check('it opens', (await page.locator('.sasrv-panel.on').count()) === 1);
// It layers over mission control rather than closing it: that drawer holds the
// composer and the log, so closing it to make room would take the input away.
check('leaving the desk intact underneath', (await page.locator('#drawer.open').count()) === 1);
const status = (await page.locator('.sasrv-stat').first().innerText()).replace(/\n/g, ' ');
check('status reads live', /RUNNING/.test(status), status.slice(0, 90));

const inputs = page.locator('.sasrv-form input');
await inputs.nth(0).fill('browser validation');
await inputs.nth(1).fill('always');
await inputs.nth(2).fill('log validated in a browser');
await inputs.nth(3).fill('60');
await page.locator('.sasrv-go', { hasText: 'ARM ON SERVER' }).click();
await page.waitForTimeout(1200);
check('a goal arms from the UI', (await page.locator('.sasrv-row').count()) >= 1);

// The panel clears its fields after a successful arm, so both are refilled: an
// empty action is caught client-side and would never reach the server, which
// would make this assert the wrong guard.
await inputs.nth(1).fill('when vibes are good');
await inputs.nth(2).fill('log this should not arm');
await page.locator('.sasrv-go', { hasText: 'ARM ON SERVER' }).click();
await page.waitForTimeout(900);
const note = await page.evaluate(
  () =>
    [...document.querySelectorAll('.sasrv-note')].map((n) => n.innerText).find((t) => /unrecognised/i.test(t)) || '',
);
check('an unrunnable goal is refused inline', /unrecognised condition/i.test(note), note.slice(0, 60));

console.log('\n  voice out');
await page.evaluate(() => {
  window.__spoken = [];
  window.speechSynthesis.speak(
    new SpeechSynthesisUtterance(
      '## NVDA\n| Metric | Value |\n|---|---|\n| Last | $142.6234 |\n\nMomentum is up 12.4531% [1].\n**VERDICT:** BUY (M)',
    ),
  );
});
await page.waitForTimeout(2500);
const spoken = await page.evaluate(() => window.__spoken);
check(
  'a dossier is briefed, not recited',
  spoken.length === 1 && !/\||\*\*|142\.6234/.test(spoken[0] || ''),
  (spoken[0] || '').slice(0, 80),
);

console.log('\n  waking up');
// The wake line reports what the server did while the tab was shut, so it can
// only come from the server — the browser has no way to know it.
const wake = await page.evaluate(() =>
  [...document.querySelectorAll('.turn')].map((t) => t.innerText).find((t) => /waking up/.test(t)) || '',
);
check('the desk reports the server state on entry', /goals? armed/i.test(wake), wake.replace(/\n/g, ' ').slice(0, 90));

console.log('\n  the acknowledgement');
// Timed rather than merely present: the claim is that it costs no round trip,
// and a check that only asserts the text would pass on a slow implementation.
const ack = await page.evaluate(() => {
  const started = performance.now();
  const line = window.__saExt.acknowledge('what do you make of https://www.reuters.com/markets/x');
  return { line, ms: performance.now() - started };
});
check('it is built from the utterance alone', ack.line === 'Reading reuters.com…', ack.line);
check('and costs no measurable time', ack.ms < 5, `${ack.ms.toFixed(3)} ms`);

console.log('\n  booking, end to end');
// The server appends book_restaurant into the engine's own scope, so this also
// proves the injection landed somewhere the tool loop can actually reach.
// The panel is still open from the checks above and covers the composer.
await page.locator('.sasrv-head .sasrv-x').click();
await page.waitForTimeout(500);
// Dismissing it gives the desk back rather than leaving a blank screen — the
// drawer underneath is where the composer lives.
const composer = page.locator('#dinput');
check('dismissing the panel gives the composer back', await composer.isVisible());
await composer.click();
await composer.fill('book a table for 4 at Osteria Mozza on Friday at 8pm under Suhas');
await page.keyboard.press('Enter');
await page.waitForTimeout(6000);

const log = await page.evaluate(() => document.querySelector('#pane-log')?.innerText || '');
check('the model reaches the booking tool', /tools: book_restaurant/.test(log));
check('an unconfigured server refuses out loud', /not configured/i.test(log));
check(
  'the call script survives to the screen',
  /Read this out/.test(log) && /book a table for 4/i.test(log),
  (log.match(/Read this out:[\s\S]{0,90}/) || [''])[0].replace(/\n/g, ' '),
);
check('and the venue is one tap from dialling', (await page.locator('a.chip[data-url^="tel:"]').count()) >= 1);

console.log('\n  voice in');
await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })));
await page.waitForTimeout(400);
await page.evaluate(() => window.__recs.at(-1)?.__say("how's my portfolio doing"));
await page.waitForTimeout(2000);
const turn = await page.evaluate(() => {
  const u = [...document.querySelectorAll('.turn .u')].pop();
  return u ? u.innerText.replace(/\n/g, ' ') : '';
});
check('spoken English becomes a command', /positions/i.test(turn), turn.slice(0, 60));

console.log('\n  voice in, before the sentence ends');
// A phrasing the fast path cannot place, so the translation behind it is a
// model call — the latency this is meant to hide. Timed rather than merely
// present: a check on the outcome alone would pass on the implementation that
// waits for silence before it starts.
const before = intentCalls.length;
await page.evaluate(() =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })),
);
await page.waitForTimeout(400);
await page.evaluate(() => window.__recs.at(-1)?.__hear('what is going on with data center demand'));
await page.waitForTimeout(1000); // past the settle window, still mid-utterance
const early = intentCalls.length - before;
check('the translation starts while the operator is still talking', early === 1, `${early} request(s)`);

// Capitalised and stopped, the way a recogniser commits a final transcript.
// Same words, so the answer already in flight is the answer to this.
await page.evaluate(() => window.__recs.at(-1)?.__say('What is going on with data center demand.'));
await page.waitForTimeout(2500);
check(
  'and the finished transcript reuses it rather than asking again',
  intentCalls.length - before === 1,
  `${intentCalls.length - before} request(s) for one utterance`,
);
const guessed = await page.evaluate(() => {
  const u = [...document.querySelectorAll('.turn .u')].pop();
  return u ? u.innerText.replace(/\n/g, ' ') : '';
});
// The guess was asked about the interim wording; what runs is the final one,
// because an untranslated command is only ever the words back.
check(
  'and what runs is the transcript as finally heard',
  /What is going on with data center demand\./.test(guessed),
  guessed.slice(0, 70),
);

console.log('\n  voice in, when the guess was wrong');
// Carrying on past the pause changes the words, and an answer about the old
// ones would run the wrong command. It has to be dropped and asked again.
const restart = intentCalls.length;
await page.evaluate(() =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })),
);
await page.waitForTimeout(400);
await page.evaluate(() => window.__recs.at(-1)?.__hear('tell me about nvidia'));
await page.waitForTimeout(1000);
await page.evaluate(() => window.__recs.at(-1)?.__say('tell me about nvidia data centers'));
await page.waitForTimeout(2500);
check(
  'a stale guess is thrown away and the question asked properly',
  intentCalls.length - restart === 2,
  `${intentCalls.length - restart} request(s)`,
);
const corrected = await page.evaluate(() => {
  const u = [...document.querySelectorAll('.turn .u')].pop();
  return u ? u.innerText.replace(/\n/g, ' ') : '';
});
check(
  'and the subject the operator added survives',
  /data center/i.test(corrected),
  corrected.slice(0, 70),
);

console.log('\n  installable');
const manifest = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) return null;
  const res = await fetch(link.href);
  return { status: res.status, body: await res.json() };
});
check('a manifest is served', manifest && manifest.status === 200, manifest ? manifest.body.name : 'missing');
check(
  'it asks for standalone, with icons',
  manifest && manifest.body.display === 'standalone' && manifest.body.icons.length >= 2,
  manifest ? `${manifest.body.display}, ${manifest.body.icons.length} icons` : '',
);
const icon = await page.evaluate(async () => {
  const res = await fetch('/icon-192.png');
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type'), png: buf[1] === 0x50 && buf[2] === 0x4e, bytes: buf.length };
});
check('the icon is a real PNG', icon.status === 200 && icon.png, `${icon.type}, ${icon.bytes} bytes`);
const sw = await page.evaluate(async () => {
  const res = await fetch('/sw.js');
  const body = await res.text();
  return { status: res.status, cachesApi: body.includes("indexOf('/api/') === 0") };
});
check('a service worker is served', sw.status === 200);
// The desk is live data. A worker that cached /api would answer a dossier from
// yesterday, which is worse than not answering at all.
check('and it refuses to cache anything under /api', sw.cachesApi);

console.log('\n  on a phone');
// A new page is a new context, so it carries none of the cookies the desktop
// one unlocked with — it has to unlock for itself or it measures the 401 page.
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await phone.goto(`${BASE}/?token=${TOKEN}`, { waitUntil: 'networkidle' });
const phoneEnter = phone.locator('.enterbtn');
if (await phoneEnter.count()) await phoneEnter.first().click();
await phone.waitForTimeout(2000);
const fit = await phone.evaluate(() => {
  const de = document.documentElement;
  const drawer = document.querySelector('.drawer');
  const tabs = document.querySelector('.tabs');
  const launcher = document.querySelector('.sasrv-btn.sasrv-float');
  const composer = document.querySelector('#dinput');
  const overlap = (a, b) => {
    if (!a || !b) return false;
    const r = a.getBoundingClientRect();
    const s = b.getBoundingClientRect();
    return r.right > s.left && r.left < s.right && r.bottom > s.top && r.top < s.bottom;
  };
  return {
    horizontalScroll: de.scrollWidth > de.clientWidth,
    drawerFillsWidth: drawer ? Math.round(drawer.getBoundingClientRect().width) >= de.clientWidth - 1 : null,
    tabsScrollable: tabs ? getComputedStyle(tabs).overflowX === 'auto' : null,
    launcherOverlapsComposer: overlap(launcher, composer),
  };
});
check('the page does not scroll sideways', fit.horizontalScroll === false);
check('the drawer uses the whole width instead of 470px of it', fit.drawerFillsWidth === true);
check('the tab row scrolls rather than running off the edge', fit.tabsScrollable === true);
check('and the launcher is clear of the composer', fit.launcherOverlapsComposer === false);
await phone.close();

check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();

const failed = checks.filter((c) => !c.pass);
console.log(
  `\n${failed.length ? '\x1b[31m' : '\x1b[32m'}${checks.length - failed.length}/${checks.length} browser checks passed\x1b[0m`,
);
process.exit(failed.length ? 1 : 0);
