#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");

const args = process.argv.slice(2);
const explicitForgeBin = process.env.FORGE_BIN;
const isWsl = Boolean(process.env.WSL_DISTRO_NAME);

const candidates = explicitForgeBin
  ? [explicitForgeBin]
  : process.platform === "win32"
    ? ["foundry/bin/forge.exe", "forge"]
    : isWsl
      ? ["foundry/bin/forge", "forge"]
      : ["foundry/bin/forge", "foundry/bin/forge.exe", "forge"];

for (const cmd of candidates) {
  if (cmd.includes("/") && !existsSync(cmd)) continue;

  const res = spawnSync(cmd, args, { stdio: "inherit" });

  if (res.error && res.error.code === "ENOENT") {
    continue;
  }

  process.exit(res.status ?? 1);
}

console.error("forge not found. Run: npm run install:foundry");
console.error("  This will download forge/anvil/cast/chisel and forge-std into foundry/");
if (isWsl) {
  console.error("WSL detected. Set FORGE_BIN to a Linux forge path, or install via: curl -L https://foundry.paradigm.xyz | bash && foundryup");
}
console.error("Manual install: https://book.getfoundry.sh/getting-started/installation");
process.exit(1);
