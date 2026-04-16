#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");

const root = process.cwd();
const useShell = process.platform === "win32";
const freshMode = process.argv.includes("--fresh") || process.env.LOCAL_CHAIN_FRESH === "1";

function runStep(label, cmd, args, options = {}) {
  console.log(`[local-chain] ${label}...`);
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
          if (Date.now() - start > timeoutMs) {
            return reject(new Error(`Timed out waiting for ${host}:${port}`));
          }
          setTimeout(attempt, 1000);
        })
        .once("error", () => {
          socket.destroy();
          if (Date.now() - start > timeoutMs) {
            return reject(new Error(`Timed out waiting for ${host}:${port}`));
          }
          setTimeout(attempt, 1000);
        })
        .connect(port, host);
    };
    attempt();
  });
}

function rpcCall(url, method, params = []) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params });
  return new Promise((resolvePromise, reject) => {
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) return reject(new Error(parsed.error.message));
            resolvePromise(parsed.result);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function portIsOpen(host, port) {
  try {
    await waitForPort(host, port, 1200);
    return true;
  } catch {
    return false;
  }
}

async function isAnvilRpc(url) {
  try {
    const version = await rpcCall(url, "web3_clientVersion");
    return String(version || "").toLowerCase().includes("anvil");
  } catch {
    return false;
  }
}

async function main() {
  const anvilHost = process.env.ANVIL_HOST || "127.0.0.1";
  const anvilPort = Number(process.env.ANVIL_PORT || 8545);
  const anvilCheckHost = anvilHost === "0.0.0.0" ? "127.0.0.1" : anvilHost;
  const anvilRpcUrl = `http://${anvilCheckHost}:${anvilPort}`;

  let anvilProcess = null;

  if (await portIsOpen(anvilCheckHost, anvilPort)) {
    if (!(await isAnvilRpc(anvilRpcUrl))) {
      throw new Error(`Port ${anvilPort} is in use by a non-Anvil process`);
    }
    if (freshMode) {
      console.log("[local-chain] resetting existing Anvil chain...");
      await rpcCall(anvilRpcUrl, "anvil_reset", []);
    } else {
      console.log("[local-chain] reusing existing Anvil instance");
    }
  } else {
    console.log("[local-chain] starting Anvil...");
    anvilProcess = spawn("node", ["scripts/anvil.js"], {
      stdio: "inherit",
      cwd: root,
      shell: useShell,
      env: { ...process.env, ANVIL_SILENT: process.env.ANVIL_SILENT || "1" },
    });

    await waitForPort(anvilCheckHost, anvilPort, 120_000);
    if (!(await isAnvilRpc(anvilRpcUrl))) {
      throw new Error("Anvil started but RPC is not responding correctly");
    }
    console.log("[local-chain] Anvil is up");
  }

  runStep("Deploying local contracts + env files", "node", ["scripts/deploy-local.js"], {
    env: {
      ...process.env,
      RPC_URL: anvilRpcUrl,
      ANVIL_RPC_URL: anvilRpcUrl,
    },
  });

  console.log("[local-chain] local chain setup ready.");
  console.log("[local-chain] generated: local_deploy_rust/.env and e2e/.env");

  if (!anvilProcess) {
    console.log("[local-chain] anvil was already running elsewhere; this command is done.");
    return;
  }

  console.log("[local-chain] keeping Anvil running in this shell (Ctrl+C to stop).\n");

  const shutdown = () => {
    try {
      anvilProcess.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        anvilProcess.kill("SIGKILL");
      } catch {}
      process.exit(0);
    }, 1000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  anvilProcess.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(`[local-chain] fatal: ${error?.message || error}`);
  process.exit(1);
});