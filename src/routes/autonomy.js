// Control surface for the server-side agent: arm goals, inspect what fired,
// manage the watchlist and memory.

import { Router } from 'express';
import { getState, rememberFact, saveState } from '../autonomy/store.js';
import {
  addGoal,
  getFeed,
  removeGoal,
  runGoal,
  status,
  tick,
  updateGoal,
} from '../autonomy/engine.js';
import { normalizeSymbol } from '../market/yahoo.js';
import { deepResearch } from '../autonomy/research.js';
import { rateLimit } from '../lib/rateLimit.js';

export const autonomyRouter = Router();

function bad(res, err) {
  return res.status(err.status || 500).json({ ok: false, error: err.message || String(err) });
}

autonomyRouter.get('/autonomy', (_req, res) => {
  const state = getState();
  res.json({
    ok: true,
    status: status(),
    goals: state.goals,
    watchlist: state.watchlist,
    memory: state.memory,
    tasks: state.tasks,
    feed: Object.fromEntries(
      Object.entries(getFeed()).map(([sym, snap]) => [
        sym,
        { ts: snap.ts, last: snap.indicators?.last ?? null, rsi: snap.indicators?.rsi ?? null },
      ]),
    ),
  });
});

autonomyRouter.get('/autonomy/activity', (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const state = getState();
  res.json({ ok: true, activity: state.activity.slice(-limit).reverse() });
});

autonomyRouter.post('/autonomy/goals', (req, res) => {
  try {
    res.status(201).json({ ok: true, goal: addGoal(req.body || {}) });
  } catch (err) {
    bad(res, err);
  }
});

autonomyRouter.patch('/autonomy/goals/:id', (req, res) => {
  try {
    const goal = updateGoal(req.params.id, req.body || {});
    if (!goal) return res.status(404).json({ ok: false, error: 'no such goal' });
    return res.json({ ok: true, goal });
  } catch (err) {
    return bad(res, err);
  }
});

autonomyRouter.delete('/autonomy/goals/:id', (req, res) => {
  if (!removeGoal(req.params.id)) {
    return res.status(404).json({ ok: false, error: 'no such goal' });
  }
  return res.json({ ok: true });
});

// Fire a goal now, skipping its condition — the "does this actually work?"
// button.
autonomyRouter.post(
  '/autonomy/goals/:id/run',
  rateLimit({ name: 'goal-run', max: 20 }),
  async (req, res) => {
    const state = getState();
    const goal = state.goals.find((g) => g.id === req.params.id);
    if (!goal) return res.status(404).json({ ok: false, error: 'no such goal' });
    const record = await runGoal(goal, { force: true });
    saveState({ immediate: true });
    return res.json({ ok: true, activity: record });
  },
);

autonomyRouter.post('/autonomy/tick', rateLimit({ name: 'tick', max: 20 }), async (_req, res) => {
  await tick();
  res.json({ ok: true, status: status() });
});

autonomyRouter.put('/autonomy/watchlist', (req, res) => {
  const input = Array.isArray(req.body?.symbols) ? req.body.symbols : null;
  if (!input) return res.status(400).json({ ok: false, error: 'symbols[] required' });

  const symbols = [];
  const rejected = [];
  for (const raw of input) {
    const sym = normalizeSymbol(typeof raw === 'string' ? raw : raw?.sym);
    if (sym) {
      if (!symbols.includes(sym)) symbols.push(sym);
    } else {
      rejected.push(raw);
    }
  }
  const state = getState();
  state.watchlist = symbols.map((sym) => ({ sym }));
  saveState({ immediate: true });
  return res.json({ ok: true, watchlist: state.watchlist, rejected });
});

autonomyRouter.post('/autonomy/memory', (req, res) => {
  const fact = rememberFact(req.body?.k, req.body?.v);
  if (!fact) return res.status(400).json({ ok: false, error: 'k and v required' });
  return res.json({ ok: true, fact });
});

// Ad-hoc research without arming a goal for it.
autonomyRouter.post('/research', rateLimit({ name: 'research', max: 10 }), async (req, res) => {
  const topic = String(req.body?.topic || '').trim();
  if (!topic) return res.status(400).json({ ok: false, error: 'topic required' });
  const urls = Array.isArray(req.body?.urls) ? req.body.urls.slice(0, 4) : [];
  try {
    const result = await deepResearch(topic, urls);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return bad(res, err);
  }
});
