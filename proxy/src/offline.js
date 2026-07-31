"use strict";
const { runTool } = require("./tools");
const { calc, convert } = require("./util");

/**
 * The offline brain.
 *
 * With no OPENAI_API_KEY there is no model to plan tool calls, so a small set of
 * intent rules drives the same tools directly. This is what makes "blank key =
 * useful server" true rather than aspirational: memory, tasks, reminders and
 * compute all keep working, and only free-form answers are unavailable.
 *
 * Deliberately literal. It matches phrasings or it says it did not.
 */

const DURATION = { second: 1, seconds: 1, sec: 1, secs: 1, minute: 60, minutes: 60, min: 60, mins: 60, hour: 3600, hours: 3600, day: 86400, days: 86400 };

const RULES = [
  // remind me to X in 15 minutes  /  remind me in 30 seconds to X
  {
    re: /^remind\s+me\s+(?:to\s+)?(.+?)\s+in\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|days?)\b/i,
    tool: (m) => ["schedule_reminder", { text: m[1].trim(), seconds: Number(m[2]) * DURATION[m[3].toLowerCase()] }],
  },
  {
    re: /^remind\s+me\s+in\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|days?)\s+(?:to\s+)?(.+)$/i,
    tool: (m) => ["schedule_reminder", { text: m[3].trim(), seconds: Number(m[1]) * DURATION[m[2].toLowerCase()] }],
  },
  // remind me to X tomorrow at 3pm
  {
    re: /^remind\s+me\s+(?:to\s+)?(.+?)\s+((?:tomorrow|next week|on \w+day|at \d).*)$/i,
    tool: (m) => ["schedule_reminder", { text: m[1].trim(), when: m[2].trim() }],
  },
  // remember the launch is Oct 3  /  remember that X = Y
  {
    re: /^remember\s+(?:that\s+)?(.+?)\s+(?:is|are|=|:)\s+(.+)$/i,
    tool: (m) => ["remember", { k: m[1].trim().replace(/^the\s+/i, ""), v: m[2].trim() }],
  },
  { re: /^remember\s+(?:that\s+)?(.+)$/i, tool: (m) => ["remember", { k: m[1].trim(), v: "" }] },

  { re: /^(?:recall|what do you know about|look up)\s+(.+)$/i, tool: (m) => ["recall", { q: m[1].trim() }] },

  { re: /^(?:list|show)\s+(?:my\s+)?(?:open\s+)?tasks\b/i, tool: () => ["list_tasks", {}] },
  { re: /^what(?:'s| is| are)\s+(?:on\s+)?my\s+(?:task|todo)/i, tool: () => ["list_tasks", {}] },
  { re: /^(?:complete|finish|done with)\s+(?:task\s+)?([A-Za-z0-9]+)$/i, tool: (m) => ["complete_task", { id: m[1] }] },
  {
    re: /^(?:add\s+(?:a\s+)?task|task|todo)\s*:?\s+(.+?)(?:\s+for\s+(\w+))?$/i,
    tool: (m) => ["add_task", { text: m[1].trim(), owner: m[2] }],
  },

  { re: /^(?:search|google)\s+(?:for\s+)?(.+)$/i, tool: (m) => ["search_web", { query: m[1].trim() }] },
  { re: /^(?:open\s+)?drive\s*(.*)$/i, tool: (m) => ["open_drive", { query: (m[1] || "").trim() }] },
  {
    re: /^(?:schedule|calendar)\s+(.+?)(?:\s+((?:tomorrow|next week|on \w+day|at \d).*))?$/i,
    tool: (m) => ["schedule_event", { title: m[1].trim(), when: m[2] || "" }],
  },
  {
    re: /^(?:email|draft (?:an )?email)\s+(?:to\s+(\S+@\S+)\s+)?(?:about\s+)?(.+)$/i,
    tool: (m) => ["compose_email", { to: m[1] || "", subject: m[2].trim(), body: "" }],
  },
];

const NO_MODEL =
  "No model key is configured, so I can only run tools I recognise directly. " +
  "Try: remember X is Y · recall X · add task X · list tasks · remind me to X in 10 minutes · 5 km to mi · 18450 * 1.07";

function runOffline(input, ctx) {
  const text = String(input).trim();
  const used = [];
  const replies = [];

  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (!m) continue;
    const [name, args] = rule.tool(m);
    const result = runTool(name, args, ctx);
    if (!result.startsWith("error:")) used.push(name);
    replies.push(result);
    return { answer: replies.join(" "), used };
  }

  // Bare arithmetic or a conversion, with no command word around it.
  if (convert(text) !== null || calc(text) !== null) {
    const result = runTool("compute", { expr: text }, ctx);
    return { answer: result, used: ["compute"] };
  }

  return { answer: NO_MODEL, used: [] };
}

module.exports = { runOffline, NO_MODEL };
