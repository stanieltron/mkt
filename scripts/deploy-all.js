#!/usr/bin/env node

"use strict";

const { spawnSync } = require("node:child_process");

const useShell = process.platform === "win32";
const args = new Set(process.argv.slice(2));

const withDb = args.has("--with-db");
const withDbFresh = args.has("--with-db-fresh");
const resetDb = args.has("--reset-db");
const freshChain = args.has("--fresh") || !args.has("--no-fresh");
const showHelp = args.has("--help") || args.has("-h");

if (showHelp) {
  console.log(`Usage: node scripts/deploy-all.js [options]

Options:
  --fresh            Reset anvil chain before startup (default behavior)
  --no-fresh         Reuse existing chain state (advanced)
  --with-db          Start PostgreSQL via scripts/db-up.js
  --with-db-fresh    Reset + start PostgreSQL via scripts/db-up.js --fresh
  --reset-db         Reset database schema before startup
`);
  process.exit(0);
}

if (withDb && withDbFresh) {
  console.error("[deploy-all] use only one of --with-db or --with-db-fresh");
  process.exit(1);
}

function runStep(label, cmd, cmdArgs) {
  console.log(`[deploy-all] ${label}...`);
  const res = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    shell: useShell,
    env: process.env,
  });
  if ((res.status ?? 1) !== 0) {
    throw new Error(`${label} failed`);
  }
}

try {
  if (withDbFresh) {
    runStep("Starting PostgreSQL (fresh)", "node", ["scripts/db-up.js", "--fresh"]);
  } else if (withDb) {
    runStep("Starting PostgreSQL", "node", ["scripts/db-up.js"]);
  }

  if (resetDb) {
    runStep("Resetting database schema", "node", ["scripts/db-init-rust.js", "--fresh"]);
  }

  const devArgs = ["scripts/dev-rust.js"];
  if (freshChain) {
    devArgs.push("--fresh");
  }
  console.log("[deploy-all] Launching rust local stack (command stays running while apps are up).");
  runStep("Starting full stack", "node", devArgs);
} catch (error) {
  console.error("[deploy-all] failed:", error?.message || error);
  process.exit(1);
}
