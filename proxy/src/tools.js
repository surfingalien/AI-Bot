"use strict";
const { memoryOf, tasksOf, rid } = require("./store");
const { calc, convert, fmt, enc, gcalFmt, parseWhen } = require("./util");

/**
 * Every tool receives a ctx bound to exactly one tenant:
 *   { tenantId, db, save(), actions[], hub, config }
 * Nothing in here can reach another tenant's brain or clients.
 */
const TOOLS = [
  {
    name: "compute",
    description: "Evaluate a math expression or unit conversion (e.g. '18450 * 1.07', '5 km to mi').",
    parameters: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] },
    exec: (a) => {
      const c = convert(a.expr);
      if (c) return fmt(c.v) + " " + c.u;
      const r = calc(a.expr);
      return r !== null ? fmt(r) : "could not parse";
    },
  },
  {
    name: "remember",
    description: "Store a fact in the caller's long-term memory.",
    parameters: { type: "object", properties: { k: { type: "string" }, v: { type: "string" } }, required: ["k"] },
    exec: (a, x) => {
      if (!a.k || !String(a.k).trim()) return "error: k is required";
      const m = memoryOf(x.db).add(a.k, a.v);
      x.save();
      x.actions.push({ t: "stat", label: `memory + "${m.k}"` });
      x.hub.broadcast(x.tenantId, "memory", { k: m.k, v: m.v });
      x.hub.pushAudit(x.tenantId, "remembered " + m.k, "memory");
      return "remembered " + m.k;
    },
  },
  {
    name: "recall",
    description: "Search the caller's memory.",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    exec: (a, x) => {
      const r = memoryOf(x.db).recall(a.q);
      return r.length ? r.map((m) => m.k + ": " + m.v).join(" | ") : "no matches";
    },
  },
  {
    name: "add_task",
    description: "Add a task to the caller's board.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, owner: { type: "string" } },
      required: ["text"],
    },
    exec: (a, x) => {
      if (!a.text || !String(a.text).trim()) return "error: text is required";
      const t = tasksOf(x.db).add(a.text, a.owner);
      x.save();
      x.actions.push({ t: "stat", label: `task + "${t.text.slice(0, 24)}"` });
      x.hub.broadcast(x.tenantId, "task", { id: t.id, text: t.text, owner: t.owner, done: false });
      x.hub.pushAudit(x.tenantId, "task added: " + t.text, "task");
      return "task added";
    },
  },
  {
    name: "list_tasks",
    description: "List the caller's open tasks.",
    parameters: { type: "object", properties: {} },
    exec: (a, x) => {
      const open = tasksOf(x.db).open();
      return open.length ? open.map((t) => `[${t.owner}] ${t.text}`).join(" | ") : "none";
    },
  },
  {
    name: "complete_task",
    description: "Toggle a task done/undone by id.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    exec: (a, x) => {
      const t = tasksOf(x.db).toggle(a.id);
      if (!t) return "no such task";
      x.save();
      x.hub.broadcast(x.tenantId, "task", { id: t.id, text: t.text, owner: t.owner, done: t.done });
      x.hub.pushAudit(x.tenantId, (t.done ? "completed " : "reopened ") + t.text, "task");
      return "toggled: " + t.text;
    },
  },
  {
    name: "schedule_reminder",
    description:
      "Server-pushed reminder fired to ALL of the caller's connected clients. Provide text and either seconds or when (e.g. 'tomorrow at 3pm').",
    parameters: {
      type: "object",
      properties: { text: { type: "string" }, seconds: { type: "number" }, when: { type: "string" } },
      required: ["text"],
    },
    exec: (a, x) => {
      const text = String(a.text || "").trim();
      if (!text) return "error: text is required";

      let fireAt;
      if (a.seconds != null) {
        const secs = Number(a.seconds);
        if (!Number.isFinite(secs) || secs < 0) return "error: seconds must be a non-negative number";
        if (secs > x.config.maxReminderSeconds) return `error: seconds exceeds the ${x.config.maxReminderSeconds}s limit`;
        fireAt = Date.now() + secs * 1000;
      } else if (a.when) {
        const when = parseWhen(a.when);
        if (!Number.isFinite(when.getTime())) return "error: could not parse when";
        fireAt = when.getTime();
      } else {
        fireAt = Date.now() + 60000;
      }

      const r = { id: rid(), text, fireAt, done: false };
      x.db.reminders = x.db.reminders || [];
      x.db.reminders.push(r);
      x.save();
      x.actions.push({ t: "stat", label: "reminder armed" });
      x.hub.broadcast(x.tenantId, "reminder_armed", { id: r.id, text: r.text, fireAt });
      x.hub.pushAudit(x.tenantId, "reminder armed: " + r.text, "reminder");
      return "reminder armed for " + new Date(fireAt).toISOString();
    },
  },
  {
    name: "schedule_event",
    description: "Create a Google Calendar event link from a title and a natural-language time.",
    parameters: {
      type: "object",
      properties: { title: { type: "string" }, when: { type: "string" } },
      required: ["title"],
    },
    exec: (a, x) => {
      const when = parseWhen((a.when || "") + " " + a.title);
      const end = new Date(when.getTime() + 3600000);
      x.actions.push({
        t: "open",
        label: "add to Calendar",
        url:
          "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" +
          enc(a.title) +
          "&dates=" +
          gcalFmt(when) +
          "/" +
          gcalFmt(end),
      });
      return "scheduled " + a.title + " @ " + when.toISOString();
    },
  },
  {
    name: "compose_email",
    description: "Create a Gmail compose link.",
    parameters: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["subject"],
    },
    exec: (a, x) => {
      x.actions.push({
        t: "open",
        label: "Gmail compose",
        url:
          "https://mail.google.com/mail/u/0/?view=cm&fs=1&to=" +
          enc(a.to) +
          "&su=" +
          enc(a.subject) +
          "&body=" +
          enc(a.body),
      });
      return "email drafted";
    },
  },
  {
    name: "search_web",
    description: "Prepare web + news search links for a query.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    exec: (a, x) => {
      x.actions.push(
        { t: "open", label: "Google", url: "https://www.google.com/search?q=" + enc(a.query) },
        { t: "open", label: "News", url: "https://www.google.com/search?tbm=nws&q=" + enc(a.query) }
      );
      return "search links ready";
    },
  },
  {
    name: "open_drive",
    description: "Open a Google Drive search.",
    parameters: { type: "object", properties: { query: { type: "string" } } },
    exec: (a, x) => {
      x.actions.push({
        t: "open",
        label: "Drive",
        url: a.query ? "https://drive.google.com/drive/search?q=" + enc(a.query) : "https://drive.google.com",
      });
      return "drive opened";
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

const toolSchemas = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

/** Run a tool by name against a tenant-bound ctx. Never throws. */
function runTool(name, args, ctx) {
  const tool = byName.get(name);
  if (!tool) return "error: unknown tool";
  try {
    return String(tool.exec(args || {}, ctx));
  } catch (e) {
    return "error: " + (e && e.message ? e.message : String(e));
  }
}

const SYSTEM_PROMPT =
  "You are SurfingAlien AI, an orbital chief-of-staff with 19 specialist agents, serving a single authenticated user. " +
  "Use the tools to ACTUALLY do work (remember/recall, tasks, server-pushed reminders via schedule_reminder, compute, " +
  "calendar/email/search/drive). After tools, reply with a short plain-text summary. Never fabricate tool results.";

module.exports = { TOOLS, toolSchemas, runTool, SYSTEM_PROMPT };
