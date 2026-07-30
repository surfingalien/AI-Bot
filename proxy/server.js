"use strict";
require("dotenv").config();

const { loadConfig } = require("./src/config");
const { createApp, startSchedulers } = require("./src/app");

const config = loadConfig(process.env);
const ctx = createApp(config);

// Boot sweep: load every tenant that exists on disk so their pending reminders
// are re-armed before the scheduler starts ticking.
const swept = ctx.store.sweep();

const stopTimers = startSchedulers(ctx);

const server = ctx.app.listen(config.port, () => {
  const mode = config.apiToken ? "token" : ctx.users.count ? "session" : "OPEN";
  console.log(
    "SurfingAlien proxy :%d -> %s (%s)  tenants=%d  auth=%s%s",
    config.port,
    config.baseUrl,
    config.model,
    swept,
    mode,
    config.apiKey ? "" : "  [no model key: offline brain]"
  );
  if (mode === "OPEN") {
    console.warn(
      "  ! auth is OPEN: every caller shares the single %q tenant. Set API_TOKEN or provision users before exposing this.",
      "anon"
    );
  }
});

function shutdown(signal) {
  console.log("\n[%s] shutting down", signal);
  stopTimers();
  ctx.hub.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
