// The autonomy loop: the thing that makes this an agent rather than a proxy.
//
// Every tick it walks the armed goals, refreshes whatever market data their
// conditions reference, evaluates them, and runs the action of the ones that
// fire. Each firing is written to the activity log, so there is always an
// answer to "what has it been doing?".

import { config } from '../config.js';
import { getState, recordActivity, rid, saveState } from './store.js';
import { conditionSymbols, evaluateCondition, parseCondition } from './conditions.js';
import { executeAction, parseAction } from './actions.js';
import { snapshot } from '../market/yahoo.js';
import { log } from '../lib/log.js';

const FEED_TTL_MS = 120000;

const feed = Object.create(null); // symbol -> snapshot
let timer = null;
let running = false;
let ticks = 0;
let startedAt = 0;

export function validateGoal(input = {}) {
  const errors = [];
  const name = String(input.name || '').trim() || 'goal';
  const condText = String(input.condText ?? input.cond ?? 'always').trim();
  const actionText = String(input.actionText ?? input.action ?? '').trim();
  const cadenceSec = Math.max(30, parseInt(input.cadenceSec ?? input.cadence ?? 300, 10) || 300);

  const cond = parseCondition(condText);
  if (cond.kind === 'invalid') errors.push(cond.error);
  const action = parseAction(actionText);
  if (action.kind === 'invalid') errors.push(action.error);

  return {
    errors,
    goal: {
      id: input.id || rid(),
      name,
      condText,
      actionText,
      cadenceSec,
      enabled: input.enabled !== false,
      lastRun: 0,
      lastFireDay: input.lastFireDay || '',
      runs: 0,
      fires: 0,
      lastResult: null,
    },
  };
}

export function addGoal(input) {
  const { errors, goal } = validateGoal(input);
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    throw err;
  }
  const state = getState();
  state.goals.push(goal);
  saveState({ immediate: true });
  log.info(`goal armed: ${goal.name} [${goal.condText} -> ${goal.actionText}]`);
  return goal;
}

export function updateGoal(id, patch = {}) {
  const state = getState();
  const goal = state.goals.find((g) => g.id === id);
  if (!goal) return null;

  if (patch.condText != null) {
    const cond = parseCondition(patch.condText);
    if (cond.kind === 'invalid') {
      const err = new Error(cond.error);
      err.status = 400;
      throw err;
    }
    goal.condText = String(patch.condText);
  }
  if (patch.actionText != null) {
    const action = parseAction(patch.actionText);
    if (action.kind === 'invalid') {
      const err = new Error(action.error);
      err.status = 400;
      throw err;
    }
    goal.actionText = String(patch.actionText);
  }
  if (patch.name != null) goal.name = String(patch.name).trim() || goal.name;
  if (patch.cadenceSec != null) {
    goal.cadenceSec = Math.max(30, parseInt(patch.cadenceSec, 10) || goal.cadenceSec);
  }
  if (patch.enabled != null) goal.enabled = Boolean(patch.enabled);

  saveState({ immediate: true });
  return goal;
}

export function removeGoal(id) {
  const state = getState();
  const before = state.goals.length;
  state.goals = state.goals.filter((g) => g.id !== id);
  const removed = state.goals.length !== before;
  if (removed) saveState({ immediate: true });
  return removed;
}

async function refreshFeed(symbols) {
  const stale = symbols.filter((s) => !feed[s] || Date.now() - feed[s].ts > FEED_TTL_MS);
  for (const sym of stale) {
    try {
      feed[sym] = await snapshot(sym);
    } catch (err) {
      log.debug(`feed refresh failed for ${sym}: ${err?.message || err}`);
    }
  }
}

export function getFeed() {
  return feed;
}

/**
 * Evaluate one goal and, if its condition holds, run its action.
 *
 * @param {object} goal
 * @param {{force?:boolean}} opts force skips the condition check (manual run).
 */
export async function runGoal(goal, opts = {}) {
  const state = getState();
  const cond = parseCondition(goal.condText);
  const action = parseAction(goal.actionText);

  if (action.kind === 'invalid') {
    const record = recordActivity({
      goal: goal.name,
      goalId: goal.id,
      kind: 'error',
      summary: action.error,
      fired: false,
    });
    goal.lastResult = { ok: false, summary: action.error, t: record.t };
    return record;
  }

  if (!opts.force) {
    if (cond.kind === 'invalid') {
      const record = recordActivity({
        goal: goal.name,
        goalId: goal.id,
        kind: 'error',
        summary: cond.error,
        fired: false,
      });
      goal.lastResult = { ok: false, summary: cond.error, t: record.t };
      return record;
    }

    const symbols = conditionSymbols(goal.condText);
    if (symbols.length) await refreshFeed(symbols);

    const verdict = evaluateCondition(cond, { state, feed, now: new Date(), goal });
    if (verdict !== true) {
      if (verdict === null) {
        log.debug(`goal ${goal.name}: condition undecidable (no feed for ${symbols.join(',')})`);
      }
      return null;
    }
    if (cond.kind === 'time') goal.lastFireDay = new Date().toDateString();
  }

  let result;
  try {
    result = await executeAction(action, {});
  } catch (err) {
    result = { ok: false, summary: `action failed: ${err?.message || err}`, detail: null };
  }

  goal.fires = (goal.fires || 0) + 1;
  goal.lastResult = { ok: result.ok, summary: result.summary, t: Date.now() };

  const record = recordActivity({
    goal: goal.name,
    goalId: goal.id,
    kind: action.kind,
    summary: result.summary,
    ok: result.ok,
    fired: true,
    forced: Boolean(opts.force),
    detail: result.detail || null,
  });
  log.info(`goal fired: ${goal.name} -> ${result.summary}`);
  return record;
}

export async function tick() {
  if (running) return; // a slow research run must not stack ticks
  running = true;
  ticks += 1;
  try {
    const state = getState();
    const nowSec = Math.floor(Date.now() / 1000);
    for (const goal of state.goals) {
      if (!goal.enabled) continue;
      if (nowSec - (goal.lastRun || 0) < goal.cadenceSec) continue;
      goal.lastRun = nowSec;
      goal.runs = (goal.runs || 0) + 1;
      await runGoal(goal);
    }
    saveState();
  } catch (err) {
    log.error(`autonomy tick failed: ${err?.message || err}`);
  } finally {
    running = false;
  }
}

export function start() {
  if (timer) return;
  startedAt = Date.now();
  timer = setInterval(() => {
    tick().catch((err) => log.error(`tick error: ${err?.message || err}`));
  }, config.autonomy.tickMs);
  if (timer.unref) timer.unref();
  log.info(`autonomy loop started (tick ${config.autonomy.tickMs}ms)`);
}

export function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  log.info('autonomy loop stopped');
}

export function status() {
  const state = getState();
  const nowSec = Math.floor(Date.now() / 1000);
  let nextIn = null;
  for (const goal of state.goals) {
    if (!goal.enabled) continue;
    const left = goal.cadenceSec - (nowSec - (goal.lastRun || 0));
    if (nextIn == null || left < nextIn) nextIn = left;
  }
  return {
    running: Boolean(timer),
    tickMs: config.autonomy.tickMs,
    ticks,
    uptimeSec: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
    goals: state.goals.length,
    armed: state.goals.filter((g) => g.enabled).length,
    watchlist: state.watchlist.length,
    nextGoalInSec: nextIn == null ? null : Math.max(0, nextIn),
    feedSymbols: Object.keys(feed),
  };
}
