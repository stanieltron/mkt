#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const root = process.cwd();
const localModeArg = process.argv.includes("--local");
const publicModeArg = process.argv.includes("--public");
const localModeEnv = String(process.env.LOCAL_MODE || "").toLowerCase() === "true";
const publicModeEnv = String(process.env.PUBLIC_MODE || "").toLowerCase() === "true";
const localMode = localModeArg || (!publicModeArg && localModeEnv);

const backendPublicPort = Number(process.env.PORT || 8787);
const backendInternalPort = Number(process.env.BACKEND_INTERNAL_PORT || 8788);
const relayPort = Number(process.env.BACKEND_RELAY_PORT || backendPublicPort);

const backendBin = resolve(
  root,
  "target",
  "release",
  process.platform === "win32" ? "makeit-backend.exe" : "makeit-backend"
);
const relayScript = resolve(root, "local-relay", "local-backend-relay.js");

const children = [];
let shuttingDown = false;

function start(name, cmd, args, env) {
  const child = spawn(cmd, args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: false,
  });
  children.push(child);
  child.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[backend-start] ${name} exited with code ${code ?? 0}`);
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch {}
  }
  setTimeout(() => {
    for (const child of children) {
      try { child.kill("SIGKILL"); } catch {}
    }
    process.exit(code);
  }, 1200);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const backendPort = localMode ? backendInternalPort : backendPublicPort;
const backend = start("backend", backendBin, [], {
  ...process.env,
  PORT: String(backendPort),
});

if (localMode) {
  start("local-relay", "node", [relayScript], {
    ...process.env,
    BACKEND_PORT: String(relayPort),
    LOCAL_BACKEND_UPSTREAM_PORT: String(backendInternalPort),
    LOCAL_BACKEND_UPSTREAM_URL: `http://127.0.0.1:${backendInternalPort}`,
  });
  console.log(`[backend-start] local mode ON: relay=http://0.0.0.0:${relayPort} upstream=http://127.0.0.1:${backendInternalPort}`);
} else {
  console.log(`[backend-start] public mode ON: backend=http://0.0.0.0:${backendPublicPort}`);
}

backend.on("spawn", () => {
  if (localMode) return;
  console.log("[backend-start] started");
});