// Genome transfer. The browser engine exports its whole brain as
// `{kind:'surfingalien-genome', v:4, ...}`; these endpoints speak that same
// format, so a genome moves either direction:
//
//   UI  --POST /api/genome-->  server keeps running the goals with no tab open
//   UI  <--GET  /api/genome--  server hands its state back for import
//
// Goals whose condition or action the server cannot run are reported in
// `skipped` rather than silently dropped.

import { Router } from 'express';
import { getState, saveState } from '../autonomy/store.js';
import { validateGoal } from '../autonomy/engine.js';
import { normalizeSymbol } from '../market/yahoo.js';
import { log } from '../lib/log.js';

export const genomeRouter = Router();

genomeRouter.get('/genome', (_req, res) => {
  const state = getState();
  res.json({
    kind: 'surfingalien-genome',
    v: 4,
    name: state.name,
    exported: new Date().toISOString(),
    source: 'server',
    memory: state.memory,
    tasks: state.tasks,
    prefs: { boost: {} },
    goals: state.goals,
    workers: state.workers,
    watchlist: state.watchlist,
    skills: [],
    experience: [],
  });
});

genomeRouter.post('/genome', (req, res) => {
  const g = req.body || {};
  if (g.kind && g.kind !== 'surfingalien-genome') {
    return res.status(400).json({ ok: false, error: 'not a surfingalien genome' });
  }
  const merge = String(req.query.mode || 'merge') !== 'replace';
  const state = getState();

  if (!merge) {
    state.goals = [];
    state.watchlist = [];
    state.memory = [];
    state.tasks = [];
  }
  if (typeof g.name === 'string' && g.name.trim()) state.name = g.name.trim();

  const skipped = [];
  let imported = 0;

  for (const raw of Array.isArray(g.goals) ? g.goals : []) {
    const { errors, goal } = validateGoal(raw);
    if (errors.length) {
      skipped.push({ name: raw?.name || '(unnamed)', reason: errors.join('; ') });
      continue;
    }
    const clash = state.goals.find((x) => x.name === goal.name && x.condText === goal.condText);
    if (clash) continue;
    state.goals.push(goal);
    imported += 1;
  }

  for (const raw of Array.isArray(g.watchlist) ? g.watchlist : []) {
    const sym = normalizeSymbol(typeof raw === 'string' ? raw : raw?.sym);
    if (!sym) continue;
    if (!state.watchlist.some((w) => w.sym === sym)) state.watchlist.push({ sym });
  }

  // Tasks come along so `tasks open` conditions mean something server-side.
  for (const raw of Array.isArray(g.tasks) ? g.tasks : []) {
    if (!raw?.text) continue;
    if (state.tasks.some((t) => t.id === raw.id || t.text === raw.text)) continue;
    state.tasks.push({
      id: String(raw.id || `${Date.now().toString(36)}${state.tasks.length}`),
      text: String(raw.text),
      owner: String(raw.owner || 'ops'),
      done: Boolean(raw.done),
      t: Number(raw.t) || Date.now(),
    });
  }

  for (const raw of Array.isArray(g.memory) ? g.memory : []) {
    if (!raw?.k) continue;
    const existing = state.memory.find((m) => m.k === raw.k);
    if (existing) existing.v = String(raw.v ?? '');
    else state.memory.push({ k: String(raw.k), v: String(raw.v ?? ''), t: Date.now() });
  }

  saveState({ immediate: true });
  log.info(`genome imported: ${imported} goal(s), ${skipped.length} skipped`);
  return res.json({
    ok: true,
    mode: merge ? 'merge' : 'replace',
    importedGoals: imported,
    skipped,
    goals: state.goals.length,
    watchlist: state.watchlist.length,
  });
});
