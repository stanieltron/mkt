#!/usr/bin/env node
"use strict";

const { spawn, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");

function commandAvailable(cmd, args = ["--version"], env = process.env) {
  const res = spawnSync(cmd, args, { stdio: "ignore", env, shell: false });
  if (res.error && res.error.code === "ENOENT") return false;
  return (res.status ?? 1) === 0;
}

function withPrependedPath(env, dirs) {
  const sep = process.platform === "win32" ? ";" : ":";
  const filtered = dirs.filter(Boolean);
  const existing = env.PATH || "";
  return { ...env, PATH: [...filtered, existing].filter(Boolean).join(sep) };
}

function runOrThrow(cmd, args, env) {
  const res = spawnSync(cmd, args, { stdio: "inherit", env, shell: false });
  if ((res.status ?? 1) !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${res.status ?? 1}`);
  }
}

function ensureFoundry(baseEnv) {
  const localBinDir = join(process.cwd(), "foundry", "bin");
  const localAnvil = join(localBinDir, process.platform === "win32" ? "anvil.exe" : "anvil");
  const localForge = join(localBinDir, process.platform === "win32" ? "forge.exe" : "forge");
  const homeFoundryBin = join(homedir(), ".foundry", "bin");
  const homeAnvil = join(homeFoundryBin, "anvil");
  const homeForge = join(homeFoundryBin, "forge");

  let env = withPrependedPath(baseEnv, [localBinDir, homeFoundryBin]);

  if (commandAvailable("anvil", ["--version"], env) && commandAvailable("forge", ["--version"], env)) {
    return env;
  }

  if (existsSync(localAnvil) && existsSync(localForge)) {
    env = withPrependedPath(baseEnv, [localBinDir, homeFoundryBin]);
    return env;
  }

  if (process.platform === "win32") {
    throw new Error("Foundry missing and automatic install in this script supports Linux Railway images only.");
  }

  console.log("[railway-anvil] Foundry not found. Installing with foundryup...");
  runOrThrow("bash", ["-lc", "curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup"], env);

  env = withPrependedPath(baseEnv, [localBinDir, homeFoundryBin]);
  if (!commandAvailable("anvil", ["--version"], env) || !commandAvailable("forge", ["--version"], env)) {
    throw new Error("Foundry install completed but anvil/forge are still unavailable in PATH.");
  }

  if (!baseEnv.ANVIL_BIN && existsSync(homeAnvil)) env.ANVIL_BIN = homeAnvil;
  if (!baseEnv.FORGE_BIN && existsSync(homeForge)) env.FORGE_BIN = homeForge;
  return env;
}

let env = {
  ...process.env,
  ANVIL_HOST: process.env.ANVIL_HOST || "0.0.0.0",
  ANVIL_PORT: process.env.ANVIL_PORT || process.env.PORT || "8545",
  ANVIL_SILENT: process.env.ANVIL_SILENT || "1",
};
env = ensureFoundry(env);

const userArgs = process.argv.slice(2);
const args = ["scripts/run-local-chain.js", ...userArgs];
if (!userArgs.includes("--fresh")) args.push("--fresh");

const child = spawn("node", args, {
  stdio: "inherit",
  env,
  shell: false,
});

child.on("error", (error) => {
  console.error(`[railway-anvil] failed to start: ${String(error?.message || error)}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[railway-anvil] exited due to signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
