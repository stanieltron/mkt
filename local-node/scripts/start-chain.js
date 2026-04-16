#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");

const env = {
  ...process.env,
  ANVIL_HOST: process.env.ANVIL_HOST || "0.0.0.0",
  ANVIL_PORT: process.env.ANVIL_PORT || process.env.PORT || "8545",
  ANVIL_SILENT: process.env.ANVIL_SILENT || "1",
};

const userArgs = process.argv.slice(2);
const args = ["scripts/run-local-chain.js", ...userArgs];
if (!userArgs.includes("--fresh")) args.push("--fresh");

const child = spawn("node", args, {
  stdio: "inherit",
  env,
  shell: false,
});

child.on("error", (error) => {
  console.error(`[start-chain] failed to start: ${String(error?.message || error)}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[start-chain] exited due to signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
