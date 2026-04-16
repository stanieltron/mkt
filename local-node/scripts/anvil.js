#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");

const mnemonic =
  process.env.ANVIL_MNEMONIC || "test test test test test test test test test test test junk";
const host = process.env.ANVIL_HOST || "127.0.0.1";
const port = process.env.ANVIL_PORT || "8545";
const chainId = process.env.ANVIL_CHAIN_ID || "31337";
const accounts = process.env.ANVIL_ACCOUNTS || "20";
// Intentionally fixed for Railway/local-chain deployments.
const balance = "100000000000";
const silent = String(process.env.ANVIL_SILENT || "0").toLowerCase() === "1";
const explicitAnvilBin = process.env.ANVIL_BIN;
const isWsl = Boolean(process.env.WSL_DISTRO_NAME);

const candidates = explicitAnvilBin
  ? [explicitAnvilBin]
  : process.platform === "win32"
    ? [resolve("foundry", "bin", "anvil.exe"), "anvil"]
    : isWsl
      ? [resolve("foundry", "bin", "anvil"), "anvil"]
      : [resolve("foundry", "bin", "anvil"), resolve("foundry", "bin", "anvil.exe"), "anvil"];

let cmd = null;

function commandExists(command) {
  const res = spawnSync(command, ["--version"], {
    stdio: "ignore",
    env: process.env,
    shell: false,
  });
  if (res.error && res.error.code === "ENOENT") {
    return false;
  }
  return true;
}

for (const candidate of candidates) {
  if (candidate.includes("foundry")) {
    if (!existsSync(candidate)) continue;
    cmd = candidate;
    break;
  }
  if (!commandExists(candidate)) continue;
  cmd = candidate;
  break;
}

if (!cmd) {
  console.error("anvil not found. Install Foundry in this environment.");
  if (isWsl) {
    console.error("WSL detected. Install Linux Foundry in WSL (or set ANVIL_BIN to a Linux anvil path).");
  }
  process.exit(1);
}

const args = [
  "--host",
  host,
  "--port",
  String(port),
  "--chain-id",
  String(chainId),
  "--accounts",
  String(accounts),
  "--balance",
  String(balance),
  "--mnemonic",
  mnemonic,
];
if (silent) {
  args.push("--silent");
}

const child = spawn(cmd, args, {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  console.error(`failed to start anvil: ${String(error?.message || error)}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`anvil exited due to signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
