#!/usr/bin/env node
/**
 * dev-rust.js
 *
 * Single-script local environment launcher for the Rust backend variant.
 *
 * What it does, in order:
 *   1. Boot Anvil (local blockchain) — reuses existing if already running
 *   2. Deploy smart contracts via deploy-local.js
 *      → writes .env.local, backend/.env, frontend/.env.local
 *   3. Start Postgres (docker compose up -d db)
 *   4. Init DB schema from backend/migrations/*.sql via db-init-rust.js
 *   5. Start Rust backend with cargo-watch (hot reload)
 *   6. Start frontend dev server
 *
 * Flags:
 *   --fresh        Reset Anvil chain, wipe DB, and redeploy everything from scratch
 *
 * Usage:
 *   node scripts/dev-rust.js
 *   node scripts/dev-rust.js --fresh
 */

"use strict";

const { spawn, spawnSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const http = require("node:http");
const net = require("node:net");

const root = process.cwd();
const useShell = process.platform === "win32";
const children = [];
let shuttingDown = false;

const freshMode = process.argv.includes("--fresh") || process.env.DEV_FRESH === "1";
const protocolVariant = "default";

// ─── env helpers ─────────────────────────────────────────────────────────────

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

function loadRootEnv(override = false) {
  loadEnvFile(resolve(root, ".env"), override);
  loadEnvFile(resolve(root, ".env.local"), override);
}

function ensureWindowsRustBuildWorkarounds(baseEnv) {
  if (process.platform !== "win32") return baseEnv;

  const nextEnv = { ...baseEnv };

  // Keep Rust artifacts out of backend/target on Windows, where stale object
  // files are prone to getting locked during rebuilds on NTFS-mounted worktrees.
  if (!nextEnv.CARGO_TARGET_DIR) {
    nextEnv.CARGO_TARGET_DIR = resolve(root, "target_temp", "backend-rust");
  }
  if (!nextEnv.CARGO_INCREMENTAL) {
    nextEnv.CARGO_INCREMENTAL = "0";
  }
  if (!nextEnv.RUSTFLAGS) {
    nextEnv.RUSTFLAGS = "-C codegen-units=1";
  }

  return nextEnv;
}

// ─── process management ───────────────────────────────────────────────────────

function runStep(label, cmd, args, options = {}) {
  console.log(`[dev-rust] ${label}...`);
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
  console.log(`[dev-rust] starting ${label}`);
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
    console.error(`[dev-rust] ${label} exited with code ${code ?? 0}`);
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[dev-rust] shutting down...");
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  setTimeout(() => {
    for (const child of children) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
    process.exit(exitCode);
  }, 1500);
}

// ─── network helpers ──────────────────────────────────────────────────────────

function waitForPort(host, port, timeoutMs) {
  const start = Date.now();
  return new Promise((res, rej) => {
    const attempt = () => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket
        .once("connect", () => { socket.destroy(); res(); })
        .once("timeout", () => {
          socket.destroy();
          if (Date.now() - start > timeoutMs) return rej(new Error(`Timed out waiting for ${host}:${port}`));
          setTimeout(attempt, 1000);
        })
        .once("error", () => {
          socket.destroy();
          if (Date.now() - start > timeoutMs) return rej(new Error(`Timed out waiting for ${host}:${port}`));
          setTimeout(attempt, 1000);
        })
        .connect(port, host);
    };
    attempt();
  });
}

function waitForHttpOk(url, timeoutMs) {
  const start = Date.now();
  return new Promise((res, rej) => {
    const attempt = () => {
      const req = http.request(url, { method: "GET", timeout: 2500 }, (r) => {
        r.resume();
        if (r.statusCode >= 200 && r.statusCode < 300) return res();
        if (Date.now() - start > timeoutMs) return rej(new Error(`Timed out waiting for ${url}`));
        setTimeout(attempt, 1000);
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) return rej(new Error(`Timed out waiting for ${url}`));
        setTimeout(attempt, 1000);
      });
      req.end();
    };
    attempt();
  });
}

function rpcCall(url, method, params = []) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params });
  return new Promise((res, rej) => {
    const req = http.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (r) => {
      let raw = "";
      r.setEncoding("utf8");
      r.on("data", (c) => (raw += c));
      r.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return rej(new Error(parsed.error.message));
          res(parsed.result);
        } catch (e) { rej(e); }
      });
    });
    req.on("error", rej);
    req.write(body);
    req.end();
  });
}

async function portIsOpen(host, port) {
  try { await waitForPort(host, port, 1200); return true; } catch { return false; }
}

async function isAnvilRpc(url) {
  try {
    const v = await rpcCall(url, "web3_clientVersion");
    return String(v || "").toLowerCase().includes("anvil");
  } catch { return false; }
}

// ─── cargo-watch check ────────────────────────────────────────────────────────

function cargoWatchAvailable() {
  const res = spawnSync("cargo", ["watch", "--version"], {
    stdio: "ignore",
    shell: useShell,
    env: process.env,
  });
  return (res.status ?? 1) === 0;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  loadRootEnv();

  const anvilHost = process.env.ANVIL_HOST || "127.0.0.1";
  const anvilPort = Number(process.env.ANVIL_PORT || 8545);
  const anvilCheckHost = anvilHost === "0.0.0.0" ? "127.0.0.1" : anvilHost;
  const rpcUrl = process.env.RPC_URL || `http://${anvilCheckHost}:${anvilPort}`;

  // ── 1. Anvil ──────────────────────────────────────────────────────────────
  if (await portIsOpen(anvilCheckHost, anvilPort)) {
    if (!(await isAnvilRpc(rpcUrl))) throw new Error(`Port ${anvilPort} is in use by a non-Anvil process`);
    if (freshMode) {
      console.log("[dev-rust] resetting existing Anvil chain...");
      await rpcCall(rpcUrl, "anvil_reset", []);
    } else {
      console.log("[dev-rust] reusing existing Anvil instance");
    }
  } else {
    startProcess("anvil", "node", ["scripts/anvil.js"], {
      env: { ...process.env, ANVIL_SILENT: process.env.ANVIL_SILENT || "1" },
    });
    await waitForPort(anvilCheckHost, anvilPort, 120_000);
    if (!(await isAnvilRpc(rpcUrl))) throw new Error("Anvil started but RPC is not responding correctly");
    console.log("[dev-rust] Anvil is up");
  }

  // ── 2. Deploy contracts ───────────────────────────────────────────────────
  runStep(
    `Deploying contracts (${protocolVariant})`,
    "node",
    ["scripts/deploy-local.js", `--variant=${protocolVariant}`]
  );
  // Reload env — deploy-local.js writes .env.local with all addresses
  loadRootEnv(true);

  // ── 3. Postgres ───────────────────────────────────────────────────────────
  const pgHost = process.env.POSTGRES_HOST || "127.0.0.1";
  const pgPort = Number(process.env.POSTGRES_PORT || 5434);

  if (await portIsOpen(pgHost, pgPort)) {
    console.log("[dev-rust] Postgres already running, skipping docker compose up");
  } else {
    runStep("Starting Postgres (docker compose)", "node", [
      "scripts/db-up.js",
      ...(freshMode ? ["--fresh"] : []),
    ]);
  }

  // ── 4. DB schema init ─────────────────────────────────────────────────────
  runStep(
    `Initializing DB schema${freshMode ? " (fresh)" : ""}`,
    "node",
    [
      "scripts/db-init-rust.js",
      ...(freshMode ? ["--fresh"] : []),
    ],
    {
      env: {
        ...process.env,
        POSTGRES_HOST: pgHost,
        POSTGRES_PORT: String(pgPort),
        POSTGRES_DB: process.env.POSTGRES_DB || "appdb",
        POSTGRES_USER: process.env.POSTGRES_USER || "app",
        POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || "app",
      },
    }
  );

  // ── 5. Rust backend (hot reload via cargo-watch) ──────────────────────────
  const backendPort = Number(process.env.BACKEND_PORT || 8787);
  const backendUpstreamPort = Number(process.env.LOCAL_BACKEND_UPSTREAM_PORT || 8788);
  const rustEnv = ensureWindowsRustBuildWorkarounds({
    ...process.env,
    PORT: String(backendUpstreamPort),
    // Ensure the Rust backend sees the correct DATABASE_URL
    DATABASE_URL:
      process.env.DATABASE_URL ||
      `postgresql://${process.env.POSTGRES_USER || "app"}:${process.env.POSTGRES_PASSWORD || "app"}@${pgHost}:${pgPort}/${process.env.POSTGRES_DB || "appdb"}`,
  });

  if (process.platform === "win32") {
    console.log(
      `[dev-rust] Windows Rust build workaround enabled -> ${rustEnv.CARGO_TARGET_DIR}`
    );
  }

  const hasCargoWatch = cargoWatchAvailable();
  if (hasCargoWatch) {
    console.log("[dev-rust] cargo-watch detected — starting Rust backend with hot reload");
    startProcess(
      "rust-backend (cargo-watch)",
      "cargo",
      ["watch", "-q", "-c", "-x", "run"],
      { cwd: resolve(root, "backend"), env: rustEnv }
    );
  } else {
    console.warn(
      "[dev-rust] cargo-watch not found — falling back to `cargo run`.\n" +
      "         Install it for hot reload: cargo install cargo-watch"
    );
    startProcess(
      "rust-backend (cargo run)",
      "cargo",
      ["run"],
      { cwd: resolve(root, "backend"), env: rustEnv }
    );
  }

  console.log("[dev-rust] waiting for shared Rust backend to be ready...");
  await waitForPort("127.0.0.1", backendUpstreamPort, 180_000); // 3 min — first compile takes time
  await waitForHttpOk(`http://127.0.0.1:${backendUpstreamPort}/api/health`, 30_000);
  console.log(`[dev-rust] shared Rust backend is up → http://127.0.0.1:${backendUpstreamPort}`);

  startProcess("local-backend-relay", "node", [resolve(root, "local_deploy_rust", "dev", "local-backend-relay.js")], {
    env: {
      ...process.env,
      BACKEND_PORT: String(backendPort),
      LOCAL_BACKEND_UPSTREAM_PORT: String(backendUpstreamPort),
    },
  });
  await waitForPort("127.0.0.1", backendPort, 30_000);
  await waitForHttpOk(`http://127.0.0.1:${backendPort}/api/health`, 30_000);
  console.log(`[dev-rust] local relay backend is up → http://127.0.0.1:${backendPort}`);

  // ── 6. Frontend ───────────────────────────────────────────────────────────
  const frontendPort = Number(process.env.FRONTEND_PORT || 5173);
  startProcess("frontend", "node", ["scripts/frontend-dev.js"], {
    env: {
      ...process.env,
      FRONTEND_VITE_CONFIG: resolve(root, "local_deploy_rust", "dev", "vite.local.config.mjs"),
      LOCAL_FAUCET_API_BASE: `http://127.0.0.1:${backendPort}`,
    },
  });
  await waitForPort("127.0.0.1", frontendPort, 120_000);

  console.log(
    `\n[dev-rust] ✅ full local environment is up!\n` +
    `  frontend  → http://127.0.0.1:${frontendPort}\n` +
    `  backend   → http://127.0.0.1:${backendPort}\n` +
    `  rpc       → ${rpcUrl}\n` +
    `  db        → postgres://127.0.0.1:${pgPort}\n`
  );
}

main().catch((err) => {
  console.error("[dev-rust] fatal:", err?.message || err);
  shutdown(1);
});
