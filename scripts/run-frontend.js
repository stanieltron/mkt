#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = process.cwd();
const useShell = process.platform === "win32";
const localMode = process.argv.includes("--local");

function loadEnvFile(filePath, override = false) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    if (!override && process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main() {
  const env = { ...process.env };

  if (localMode) {
    const localEnvPath = resolve(root, "local_deploy_rust", ".env");
    if (!existsSync(localEnvPath)) {
      throw new Error("local_deploy_rust/.env not found. Run `npm run local:chain` first.");
    }
    loadEnvFile(localEnvPath, true);

    const backendPort = Number(process.env.BACKEND_PORT || 8787);
    env.FRONTEND_VITE_CONFIG = resolve(root, "local_deploy_rust", "dev", "vite.local.config.mjs");
    env.LOCAL_FAUCET_API_BASE = process.env.BACKEND_URL || `http://127.0.0.1:${backendPort}`;

    console.log("[run-frontend] local mode enabled (faucet + local relay expected).");
  } else {
    console.log("[run-frontend] non-local mode enabled (uses normal frontend env). ");
  }

  const child = spawn("node", ["scripts/frontend-dev.js"], {
    stdio: "inherit",
    cwd: root,
    shell: useShell,
    env,
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  console.error(`[run-frontend] fatal: ${error?.message || error}`);
  process.exit(1);
});