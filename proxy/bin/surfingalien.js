#!/usr/bin/env node
"use strict";

const { main, CliError } = require("../src/cli");

main(process.argv.slice(2))
  .then((code) => {
    // null means a command took over the process (e.g. `start` is now listening).
    if (code !== null && code !== undefined) process.exit(code);
  })
  .catch((err) => {
    if (err instanceof CliError) {
      console.error("\x1b[31merror\x1b[0m " + err.message);
      process.exit(2);
    }
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
