#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");

const port = process.env.FRONTEND_PORT || "5173";
const frontendRoot = resolve(process.cwd(), "frontend");
const viteBin = resolve(
  frontendRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vite.cmd" : "vite"
);

if (!existsSync(viteBin)) {
  console.error("[frontend-dev] Vite not found. Run `npm install` in frontend first.");
  process.exit(1);
}

const args = ["--host", "--strictPort", "--port", String(port)];
if (process.env.FRONTEND_VITE_CONFIG) {
  args.push("--config", process.env.FRONTEND_VITE_CONFIG);
}

const runtimeEnv = { ...process.env };
const isMountedWorkspace =
  process.platform !== "win32" && String(process.cwd() || "").startsWith("/mnt/");
const isWsl = Boolean(process.env.WSL_DISTRO_NAME);
if (isWsl || isMountedWorkspace) {
  runtimeEnv.CHOKIDAR_USEPOLLING = runtimeEnv.CHOKIDAR_USEPOLLING || "1";
  runtimeEnv.CHOKIDAR_INTERVAL = runtimeEnv.CHOKIDAR_INTERVAL || "150";
}

const child = spawn(viteBin, args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: runtimeEnv,
  cwd: frontendRoot,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
