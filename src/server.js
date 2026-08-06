import { createApp } from './app.js';
import { config, authRequired } from './config.js';
import { loadState, saveState } from './autonomy/store.js';
import { start as startAutonomy, stop as stopAutonomy } from './autonomy/engine.js';
import { log } from './lib/log.js';

const app = createApp();
loadState();

const server = app.listen(config.port, config.host, () => {
  log.info(`SurfingAlien desk on http://localhost:${config.port}`);
  log.info(
    `brain=${config.brain.base ? 'proxied' : 'off'} notify=${
      config.notify.webhook ? 'on' : 'off'
    } autonomy=${config.autonomy.enabled ? 'on' : 'off'} auth=${authRequired() ? 'on' : 'off'}`,
  );

  // Say it plainly rather than leaving it to be discovered: bound off-loopback
  // with no token, every endpoint here is open to whoever can route to it.
  const loopbackOnly = /^(127\.|::1$|localhost$)/.test(config.host);
  if (!authRequired() && !loopbackOnly) {
    log.warn(
      `listening on ${config.host} with no API_TOKEN — goals, memory and the model budget are open to anyone who can reach this port`,
    );
  }

  if (config.autonomy.enabled) startAutonomy();
});

function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  stopAutonomy();
  saveState({ immediate: true });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
