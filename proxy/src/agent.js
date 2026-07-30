"use strict";
const { toolSchemas, runTool, SYSTEM_PROMPT } = require("./tools");
const { runOffline } = require("./offline");

/**
 * The tool loop, scoped to one tenant.
 *
 * `deps.upstream` is injected so tests can drive the loop without a model
 * provider; the default implementation talks to any OpenAI-compatible /chat/completions.
 */
function createUpstream(config) {
  return async function upstream(messages) {
    if (!config.apiKey) throw new Error("OPENAI_API_KEY not configured");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), config.upstreamTimeoutMs);
    try {
      const r = await fetch(config.baseUrl + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.apiKey },
        body: JSON.stringify({ model: config.model, messages, tools: toolSchemas, tool_choice: "auto" }),
        signal: ctl.signal,
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error("upstream " + r.status + ": " + body.slice(0, 300));
      }
      return await r.json();
    } catch (e) {
      if (e.name === "AbortError") throw new Error("upstream timed out after " + config.upstreamTimeoutMs + "ms");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Only pass through history entries the upstream will accept. */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
}

async function runAgentLoop({ input, history, tenantId, store, hub, config, upstream }) {
  const db = store.load(tenantId);
  const ctx = {
    tenantId,
    db,
    hub,
    config,
    actions: [],
    save: () => store.save(tenantId),
  };
  // No upstream configured (blank OPENAI_API_KEY) => the offline brain drives
  // the same tools by intent instead of 502-ing on every request.
  if (!upstream) {
    const out = runOffline(input, ctx);
    hub.broadcast(tenantId, "agent", { answer: out.answer, used: out.used, offline: true });
    return { ...out, actions: ctx.actions, offline: true };
  }

  const used = [];
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...sanitizeHistory(history),
    { role: "user", content: input },
  ];

  for (let turn = 0; turn < config.agentMaxTurns; turn++) {
    const res = await upstream(messages);
    const msg = res && res.choices && res.choices[0] && res.choices[0].message;
    if (!msg) throw new Error("empty upstream response");
    messages.push(msg);

    if (!msg.tool_calls || !msg.tool_calls.length) {
      const answer = msg.content || "Done. " + used.join(", ");
      hub.broadcast(tenantId, "agent", { answer, used });
      return { answer, actions: ctx.actions, used };
    }

    for (const tc of msg.tool_calls) {
      let args = {};
      try {
        args = JSON.parse((tc.function && tc.function.arguments) || "{}");
      } catch {
        args = {};
      }
      const name = tc.function && tc.function.name;
      const result = runTool(name, args, ctx);
      if (!result.startsWith("error:")) used.push(name);
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }

  const answer = "(tool loop limit reached)";
  hub.broadcast(tenantId, "agent", { answer, used });
  return { answer, actions: ctx.actions, used };
}

module.exports = { runAgentLoop, createUpstream, sanitizeHistory };
