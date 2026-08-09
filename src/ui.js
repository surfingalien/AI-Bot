// Serves public/index.html — the SurfingAlien desk — with a small bootstrap
// script injected ahead of the engine block.
//
// The HTML file itself is left byte-for-byte as authored. The engine reads its
// configuration out of localStorage the moment it boots, so the bootstrap seeds
// those keys (and only the ones that are still unset) with values this server
// actually knows: its own origin for the data proxy, and its brain proxy path
// when an upstream model is configured. A first-time visitor gets a working
// desk without touching the Settings panel; anything the operator has already
// chosen is left alone.

import fs from 'node:fs';
import path from 'node:path';
import { config, brainConfigured } from './config.js';

const ENGINE_TAG = '<script type="text/plain" id="engineSrc">';

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
  cached =
    index === -1
      ? html // unrecognised build: serve it untouched
      : html.slice(0, index) + bootstrapScript(defaults) + html.slice(index);
  return cached;
}
