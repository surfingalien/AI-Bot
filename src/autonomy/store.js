// Durable agent state. Deliberately a single JSON file: the genome the browser
// exports is a JSON blob too, so import/export stays lossless and the whole
// brain is one greppable artifact.

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../lib/log.js';

const EMPTY = {
  name: 'Operator',
  memory: [],
  tasks: [],
  goals: [],
  workers: [],
  watchlist: [],
  // Carried for genome fidelity; the desk, not the loop, acts on these.
  portfolio: [],
  consensus: false,
  activity: [],
  updated: null,
};

let state = null;
let writeTimer = null;

function file() {
  return path.resolve(process.cwd(), config.autonomy.stateFile);
}

function normalize(raw) {
  const s = { ...EMPTY, ...(raw && typeof raw === 'object' ? raw : {}) };
  for (const key of [
    'memory',
    'tasks',
    'goals',
    'workers',
    'watchlist',
    'portfolio',
    'activity',
  ]) {
    if (!Array.isArray(s[key])) s[key] = [];
  }
  return s;
}

export function loadState() {
  if (state) return state;
  try {
    const text = fs.readFileSync(file(), 'utf8');
    state = normalize(JSON.parse(text));
    log.info(`state loaded from ${config.autonomy.stateFile} (${state.goals.length} goals)`);
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`state unreadable, starting fresh: ${err.message}`);
    state = normalize(null);
  }
  return state;
}

export function getState() {
  return loadState();
}

function writeNow() {
  const target = file();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    state.updated = new Date().toISOString();
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, target); // atomic swap, never a half-written brain
  } catch (err) {
    log.error(`failed to persist state: ${err.message}`);
  }
}

/** Debounced save — autonomy ticks mutate state far more often than it matters. */
export function saveState({ immediate = false } = {}) {
  loadState();
  if (immediate) {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    writeNow();
    return;
  }
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeNow();
  }, 500);
  if (writeTimer.unref) writeTimer.unref();
}

export function resetState(next) {
  state = normalize(next);
  saveState({ immediate: true });
  return state;
}

export function recordActivity(entry) {
  const s = loadState();
  const record = { id: rid(), t: Date.now(), ...entry };
  s.activity.push(record);
  if (s.activity.length > config.autonomy.maxActivity) {
    s.activity = s.activity.slice(-config.autonomy.maxActivity);
  }
  saveState();
  return record;
}

export function rememberFact(key, value) {
  const s = loadState();
  const k = String(key || '').trim();
  if (!k) return null;
  const existing = s.memory.find((m) => m.k.toLowerCase() === k.toLowerCase());
  if (existing) {
    existing.v = String(value);
    existing.t = Date.now();
  } else {
    s.memory.push({ id: rid(), k, v: String(value), t: Date.now() });
  }
  saveState();
  return s.memory.find((m) => m.k.toLowerCase() === k.toLowerCase());
}

export function rid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
