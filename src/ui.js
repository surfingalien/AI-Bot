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
  cached = withTools.slice(0, at) + bootstrapScript(defaults) + withTools.slice(at);
  return cached;
}
