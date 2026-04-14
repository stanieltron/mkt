#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const http = require("node:http");
const net = require("node:net");

const root = process.cwd();
const useShell = process.platform === "win32";
const localMode = process.argv.includes("--local");
const freshMode = process.argv.includes("--fresh") || process.env.BACKEND_FRESH === "1";
const children = [];
let shuttingDown = false;

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

function ensureWindowsRustBuildWorkarounds(baseEnv) {
  if (process.platform !== "win32") return baseEnv;
  const nextEnv = { ...baseEnv };
  if (!nextEnv.CARGO_TARGET_DIR) nextEnv.CARGO_TARGET_DIR = resolve(root, "target_temp", "backend-rust");
  if (!nextEnv.CARGO_INCREMENTAL) nextEnv.CARGO_INCREMENTAL = "0";
  if (!nextEnv.RUSTFLAGS) nextEnv.RUSTFLAGS = "-C codegen-units=1";
  return nextEnv;
}

function runStep(label, cmd, args, options = {}) {
  console.log(`[run-backend] ${label}...`);
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: root,
    shell: useShell,
    env: process.env,
    ...options,
  });
  if ((res.status ?? 1) !== 0) {
    throw new Error(`${label} failed with exit code ${res.status}`);
  }
}

function startProcess(label, cmd, args, options = {}) {
  console.log(`[run-backend] starting ${label}`);
  const child = spawn(cmd, args, {
    stdio: "inherit",
    cwd: root,
    shell: useShell,
    env: process.env,
    ...options,
  });
  children.push(child);
  child.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[run-backend] ${label} exited with code ${code ?? 0}`);
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    process.exit(exitCode);
  }, 1200);
}

function waitForPort(host, port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolvePromise, reject) => {
    const attempt = () => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket
        .once("connect", () => {
          socket.destroy();
          resolvePromise();
        })
        .once("timeout", () => {
          socket.destroy();
          if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${host}:${port}`));
          setTimeout(attempt, 1000);
        })
        .once("error", () => {
          socket.destroy();
          if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${host}:${port}`));
          setTimeout(attempt, 1000);
        })
        .connect(port, host);
    };
    attempt();
  });
}

function waitForHttpOk(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolvePromise, reject) => {
    const attempt = () => {
      const req = http.request(url, { method: "GET", timeout: 2500 }, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) return resolvePromise();
        if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${url}`));
        setTimeout(attempt, 1000);
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${url}`));
        setTimeout(attempt, 1000);
      });
      req.end();
    };
    attempt();
  });
}

function cargoWatchAvailable() {
  const res = spawnSync("cargo", ["watch", "--version"], {
    stdio: "ignore",
    shell: useShell,
    env: process.env,
  });
  return (res.status ?? 1) === 0;
}

async function main() {
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  if (!localMode) {
    const hasCargoWatch = cargoWatchAvailable();
    if (hasCargoWatch) {
      startProcess("rust-backend (cargo-watch)", "cargo", ["watch", "-q", "-c", "-x", "run"], {
        cwd: resolve(root, "backend"),
      });
    } else {
      startProcess("rust-backend (cargo run)", "cargo", ["run"], {
        cwd: resolve(root, "backend"),
      });
    }
    console.log("[run-backend] running in non-local mode. Using current shell/.env settings.");
    return;
  }

  const localEnvPath = resolve(root, "local_deploy_rust", ".env");
  if (!existsSync(localEnvPath)) {
    throw new Error("local_deploy_rust/.env not found. Run `npm run local:chain` first.");
  }
  loadEnvFile(localEnvPath, true);

  runStep("Starting local Postgres + Redis", "node", ["scripts/db-up.js", ...(freshMode ? ["--fresh"] : [])]);
  runStep("Initializing local DB schema", "node", ["scripts/db-init-rust.js", ...(freshMode ? ["--fresh"] : [])]);

  const pgHost = process.env.POSTGRES_HOST || "127.0.0.1";
  const pgPort = Number(process.env.POSTGRES_PORT || 5434);
  const backendPort = Number(process.env.BACKEND_PORT || 8787);
  const backendUpstreamPort = Number(process.env.LOCAL_BACKEND_UPSTREAM_PORT || 8788);

  const rustEnv = ensureWindowsRustBuildWorkarounds({
    ...process.env,
    PORT: String(backendUpstreamPort),
    DATABASE_URL:
      process.env.DATABASE_URL ||
      `postgresql://${process.env.POSTGRES_USER || "app"}:${process.env.POSTGRES_PASSWORD || "app"}@${pgHost}:${pgPort}/${process.env.POSTGRES_DB || "appdb"}`,
  });

  const hasCargoWatch = cargoWatchAvailable();
  if (hasCargoWatch) {
    startProcess("rust-backend (cargo-watch)", "cargo", ["watch", "-q", "-c", "-x", "run"], {
      cwd: resolve(root, "backend"),
      env: rustEnv,
    });
  } else {
    startProcess("rust-backend (cargo run)", "cargo", ["run"], {
      cwd: resolve(root, "backend"),
      env: rustEnv,
    });
  }

  await waitForPort("127.0.0.1", backendUpstreamPort, 180_000);
  await waitForHttpOk(`http://127.0.0.1:${backendUpstreamPort}/api/health`, 30_000);

  startProcess("local-backend-relay", "node", [resolve(root, "local_deploy_rust", "dev", "local-backend-relay.js")], {
    env: {
      ...process.env,
      BACKEND_PORT: String(backendPort),
      LOCAL_BACKEND_UPSTREAM_PORT: String(backendUpstreamPort),
    },
  });

  await waitForPort("127.0.0.1", backendPort, 30_000);
  await waitForHttpOk(`http://127.0.0.1:${backendPort}/api/health`, 30_000);

  console.log(`[run-backend] local mode ready: relay=http://127.0.0.1:${backendPort} upstream=http://127.0.0.1:${backendUpstreamPort}`);
}

main().catch((error) => {
  console.error(`[run-backend] fatal: ${error?.message || error}`);
  shutdown(1);
});