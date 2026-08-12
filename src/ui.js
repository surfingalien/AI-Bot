// Serves public/index.html — the SurfingAlien desk — with a small bootstrap
// script injected ahead of the engine block, and the server's own tools
// appended to the end of it.
//
// The HTML file itself is left byte-for-byte as authored. The engine reads its
// configuration out of localStorage the moment it boots, so the bootstrap seeds
// those keys (and only the ones that are still unset) with values this server
// actually knows: its own origin for the data proxy, and its brain proxy path
// when an upstream model is configured. A first-time visitor gets a working
// desk without touching the Settings panel; anything the operator has already
// chosen is left alone.
//
// The tools go *inside* the engine block rather than in a script tag of their
// own, because the engine is evaluated with `new Function(src)` — its tool
// registry is closure-scoped and a separate script can only see the window.
// Appending to the same source is the only way in, and it keeps index.html
// swappable: a newer desk build drops in without touching this file.

import fs from 'node:fs';
import path from 'node:path';
import { config, brainConfigured } from './config.js';
import { log } from './lib/log.js';

const ENGINE_TAG = '<script type="text/plain" id="engineSrc">';
const ENGINE_CLOSE = '</script>';

let cached = null;

// What makes the desk installable, and what makes it fit a phone once it is.
//
// Both belong here rather than in index.html, which is authored elsewhere and
// re-uploaded whole, and rather than in desk-server.js, whose styles are
// namespaced by contract — these rules deliberately reach into the desk's own
// classes, which is the one thing that file may not do.
//
// The selectors below are therefore a contract with the desk build: `.drawer`,
// `.tabs`, `.tab`. A build that renames them loses the mobile layout rather
// than breaking, which is the right way round.
const HEAD_EXTRAS = `
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#040e22">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="SurfingAlien">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style id="sa-fit">
/* A phone has no room for a panel beside anything, so the drawer stops
   pretending it is one and takes the screen — with the notch respected. */
@media (max-width: 820px) {
  .drawer { width: 100%; max-width: 100%; border-left: 0;
            padding-bottom: env(safe-area-inset-bottom, 0px); }
  /* The tab row runs off the right edge at this width. Scrolling it beats
     wrapping it: MEMORY stays reachable and the row keeps its one-line shape. */
  .tabs { flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch;
          scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { flex: 0 0 auto; }
  /* Anything below this is a thumb target that was built for a cursor. */
  .drawer .ph .x { font-size: 26px; padding: 6px 10px; margin: -6px -10px; }
}
/* Standalone has no browser chrome to absorb the notch or the home indicator,
   so the page has to leave room for both itself. */
@media (display-mode: standalone) {
  body { padding-top: env(safe-area-inset-top, 0px); }
}
</style>
<script>
/* Registered late and quietly: an install is a nicety, and a browser without
   service workers — or a page served over plain http — should reach a working
   desk regardless. */
if ('serviceWorker' in navigator) {
  addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
</script>
`;

function bootstrapScript(defaults) {
  return `<script>
/* injected by the SurfingAlien server — seeds first-run defaults only */
(function(){
  var d = ${JSON.stringify(defaults)};
  function seed(key, value){
    try{
      if(value === '' || value === null || value === undefined) return;
      if(localStorage.getItem('sa_' + key) !== null) return;
      localStorage.setItem('sa_' + key, JSON.stringify(value));
    }catch(e){}
  }
  var origin = (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : d.origin;
  seed('dataBase', origin);
  if(d.brain){
    seed('base', origin + '/api/v1');
    seed('model', d.model);
    seed('brain', true);
    seed('key', '');
  }
  window.__SA_SERVER = d;
})();
</script>
<script src="/desk-server.js" defer></script>
`;
}

/**
 * Splice the server's tools onto the end of the engine source, inside the same
 * block. Returns the HTML unchanged if the block cannot be located — an
 * unrecognised build is served as-is rather than corrupted by a guess.
 */
function withEngineTools(html, tagIndex) {
  const bodyStart = tagIndex + ENGINE_TAG.length;
  const close = html.indexOf(ENGINE_CLOSE, bodyStart);
  if (close === -1) {
    log.warn('engine block has no closing tag — serving the desk without server tools');
    return html;
  }
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/desk/engine-extensions.js'), 'utf8');
  return (
    html.slice(0, close) +
    '\n/* ---- server tools, appended into the engine scope ---- */\n' +
    source +
    html.slice(close)
  );
}

export function renderIndex() {
  if (cached) return cached;
  const file = path.resolve(process.cwd(), 'public/index.html');
  const html = fs.readFileSync(file, 'utf8');
  const defaults = {
    origin: `http://localhost:${config.port}`,
    brain: brainConfigured(),
    model: config.brain.model,
    autonomy: config.autonomy.enabled,
  };

  const index = html.indexOf(ENGINE_TAG);
  if (index === -1) {
    cached = html; // unrecognised build: serve it untouched
    return cached;
  }

  // Tools first, so the offsets the bootstrap splice uses stay valid.
  const withTools = withEngineTools(html, index);
  const at = withTools.indexOf(ENGINE_TAG);
  const spliced = withTools.slice(0, at) + bootstrapScript(defaults) + withTools.slice(at);
  cached = withHead(spliced);
  return cached;
}

/**
 * Add the install metadata and the mobile rules to <head>. A build without a
 * closing head tag is served as it is rather than guessed at — the same rule
 * the engine splice follows.
 */
function withHead(html) {
  const close = html.indexOf('</head>');
  if (close === -1) {
    log.warn('no </head> in the desk — serving it without the manifest or the mobile rules');
    return html;
  }
  return html.slice(0, close) + HEAD_EXTRAS + html.slice(close);
}
