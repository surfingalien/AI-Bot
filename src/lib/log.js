import { config } from '../config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function emit(level, msg, extra) {
  if (LEVELS[level] > (LEVELS[config.logLevel] ?? 2)) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra);
}

export const log = {
  error: (m, e) => emit('error', m, e),
  warn: (m, e) => emit('warn', m, e),
  info: (m, e) => emit('info', m, e),
  debug: (m, e) => emit('debug', m, e),
};
