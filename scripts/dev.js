#!/usr/bin/env node

"use strict";

const { spawnSync } = require("node:child_process");

const args = new Set(process.argv.slice(2));
const useShell = process.platform === "win32";

function run(cmd, cmdArgs) {
  const res = spawnSync(cmd, cmdArgs, {
    stdio: "inherit",
    shell: useShell,
    env: process.env,
  });
  process.exit(res.status ?? 1);
}

if (args.has("--contracts-only")) {
  console.log("[dev] contracts-only mode: deploying contracts only");
  run("node", ["scripts/deploy-local.js"]);
}

if (args.has("--apps-only")) {
  console.warn("[dev] --apps-only is no longer supported in rust-only mode; starting full rust stack");
}

const forwarded = ["scripts/dev-rust.js"];
if (args.has("--fresh")) {
  forwarded.push("--fresh");
}

run("node", forwarded);
