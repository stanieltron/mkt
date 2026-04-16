#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { resolve } = require("node:path");
const http = require("node:http");
const https = require("node:https");

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
const backendRpcUrl = process.env.BACKEND_RPC_URL || process.env.RPC_URL || "";

const children = [];
let shuttingDown = false;
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function statusLabel(ok) {
  return ok ? `${GREEN}[ok]${RESET}` : `${RED}[failed]${RESET}`;
}

function requestJson(targetUrl, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolvePromise, reject) => {
    let urlObj;
    try {
      urlObj = new URL(targetUrl);
    } catch (error) {
      reject(error);
      return;
    }
    const client = urlObj.protocol === "https:" ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = client.request(
      urlObj,
      {
        method,
        headers: {
          ...(payload ? { "content-type": "application/json" } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          const code = Number(res.statusCode || 0);
          if (code < 200 || code >= 300) {
            reject(new Error(`HTTP ${code}: ${raw || res.statusMessage || "request failed"}`));
            return;
          }
          try {
            resolvePromise(raw ? JSON.parse(raw) : {});
          } catch {
            resolvePromise({});
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runCheck(name, target, fn, attempts = 20, delayMs = 500) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fn();
      console.log(`${statusLabel(true)} [backend-start] ${name} -> ${target}`);
      return true;
    } catch (error) {
      lastError = error;
      await delay(delayMs);
    }
  }
  console.log(
    `${statusLabel(false)} [backend-start] ${name} -> ${target} (${String(lastError?.message || lastError)})`
  );
  return false;
}

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
    BACKEND_BIND_HOST: process.env.BACKEND_BIND_HOST || "0.0.0.0",
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

setTimeout(async () => {
  const upstreamHealth = `http://127.0.0.1:${backendPort}/api/health`;
  const relayHealth = `http://127.0.0.1:${relayPort}/api/health`;
  await runCheck("backend-upstream", upstreamHealth, async () => {
    const json = await requestJson(upstreamHealth);
    if (!json?.ok) throw new Error("health not ok");
  });
  if (localMode) {
    await runCheck("backend-relay", relayHealth, async () => {
      const json = await requestJson(relayHealth);
      if (!json?.ok) throw new Error("relay health not ok");
    });
  }
  if (backendRpcUrl) {
    await runCheck("rpc-upstream", backendRpcUrl, async () => {
      const json = await requestJson(backendRpcUrl, {
        method: "POST",
        body: { jsonrpc: "2.0", method: "web3_clientVersion", params: [], id: 1 },
      });
      if (!json?.result) throw new Error("missing web3_clientVersion");
    });
  }
}, 1200);
