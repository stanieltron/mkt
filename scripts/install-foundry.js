#!/usr/bin/env node
/**
 * install-foundry.js
 *
 * Installs Foundry binaries (forge, anvil, cast, chisel) and forge-std
 * into the local foundry/ directory so the project is self-contained.
 *
 * Behaviour:
 *  1. Binaries  - prefer globally installed Foundry from PATH.
 *                 If missing, download the latest release into foundry/bin.
 *                 If foundry/foundry.zip exists, delete it as stale.
 *  2. forge-std - if foundry/lib/forge-std already exists, skips.
 *                 Otherwise clones from GitHub. No forge required.
 *
 * Override env vars:
 *  FOUNDRY_BIN    - explicit forge binary path (also treated as global install)
 *  FORGE_STD_SKIP - set to "1" to skip forge-std cloning
 */

"use strict";

const { spawnSync } = require("node:child_process");
const {
  existsSync,
  mkdirSync,
  createWriteStream,
  chmodSync,
  unlinkSync,
} = require("node:fs");
const { resolve, join } = require("node:path");
const https = require("node:https");

const root = process.cwd();
const foundryDir = resolve(root, "foundry");
const binDir = resolve(foundryDir, "bin");
const libDir = resolve(foundryDir, "lib");
const forgeStdDir = resolve(libDir, "forge-std");
const staleLocalZip = resolve(foundryDir, "foundry.zip");

const isWin = process.platform === "win32";
const ext = isWin ? ".exe" : "";
const BINARIES = ["forge", "anvil", "cast", "chisel"];

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.error) throw res.error;
  if ((res.status ?? 1) !== 0) {
    process.exit(res.status ?? 1);
  }
}

function commandAvailable(cmd, args = ["--version"]) {
  const res = spawnSync(cmd, args, { stdio: "ignore" });
  return !res.error && (res.status ?? 1) === 0;
}

function binariesPresent() {
  return BINARIES.every((b) => existsSync(join(binDir, b + ext)));
}

function globalBinariesPresent() {
  if (process.env.FOUNDRY_BIN) {
    return commandAvailable(process.env.FOUNDRY_BIN, ["--version"]);
  }
  return BINARIES.every((b) => commandAvailable(b, ["--version"]));
}

function downloadFile(url, dest) {
  return new Promise((resolvePromise, reject) => {
    const follow = (u) => {
      https
        .get(u, { headers: { "User-Agent": "mkt-install-foundry" } }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            return follow(res.headers.location);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          }
          const out = createWriteStream(dest);
          res.pipe(out);
          out.on("finish", () => out.close(resolvePromise));
          out.on("error", reject);
        })
        .on("error", reject);
    };
    follow(url);
  });
}

function getLatestFoundryZipUrl() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  let platform;
  if (process.platform === "win32") platform = `${arch}_pc-windows-msvc`;
  else if (process.platform === "darwin") platform = `${arch}-apple-darwin`;
  else platform = `${arch}-unknown-linux-musl`;
  return `https://github.com/foundry-rs/foundry/releases/latest/download/foundry_nightly_${platform}.zip`;
}

function extractZip(zipPath, destination) {
  if (isWin) {
    run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${zipPath}' -DestinationPath '${destination}' -Force`,
    ]);
    return;
  }

  if (commandAvailable("unzip")) {
    run("unzip", ["-o", zipPath, "-d", destination]);
    return;
  }

  if (commandAvailable("python3")) {
    run("python3", [
      "-c",
      "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
      zipPath,
      destination,
    ]);
    return;
  }

  if (commandAvailable("python")) {
    run("python", [
      "-c",
      "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
      zipPath,
      destination,
    ]);
    return;
  }

  console.error("x No ZIP extractor found. Install `unzip` or `python3`.");
  process.exit(1);
}

async function installBinaries() {
  if (globalBinariesPresent()) {
    console.log("[ok] Foundry binaries available on PATH - skipping local download.");
    return;
  }

  if (binariesPresent()) {
    console.log("[ok] Foundry binaries already present in foundry/bin/ - skipping.");
    return;
  }

  mkdirSync(binDir, { recursive: true });

  if (existsSync(staleLocalZip)) {
    console.log(`  Removing stale local archive: ${staleLocalZip}`);
    unlinkSync(staleLocalZip);
  }

  const url = getLatestFoundryZipUrl();
  console.log(`  Downloading Foundry from:\n  ${url}`);

  const zipPath = resolve(foundryDir, "_foundry_download.zip");
  await downloadFile(url, zipPath);
  console.log("  Download complete.");

  console.log("  Extracting to foundry/bin/ ...");
  extractZip(zipPath, binDir);

  if (existsSync(zipPath)) {
    unlinkSync(zipPath);
  }

  if (!isWin) {
    for (const b of BINARIES) {
      const p = join(binDir, b);
      if (existsSync(p)) chmodSync(p, 0o755);
    }
  }

  if (!binariesPresent()) {
    console.error("x Binary extraction failed - binaries not found in foundry/bin/");
    process.exit(1);
  }

  console.log("[ok] Foundry binaries installed.");
}

function installForgeStd() {
  if (process.env.FORGE_STD_SKIP === "1") {
    console.log("  FORGE_STD_SKIP=1 - skipping forge-std.");
    return;
  }

  if (existsSync(resolve(forgeStdDir, "src"))) {
    console.log("[ok] forge-std already present - skipping.");
    return;
  }

  mkdirSync(libDir, { recursive: true });

  const gitCheck = spawnSync("git", ["--version"], { stdio: "ignore" });
  if (gitCheck.error || (gitCheck.status ?? 1) !== 0) {
    console.error("x git not found. Install git to clone forge-std.");
    process.exit(1);
  }

  console.log("  Cloning forge-std ...");
  run("git", [
    "clone",
    "--depth=1",
    "https://github.com/foundry-rs/forge-std.git",
    forgeStdDir,
  ]);
  console.log("[ok] forge-std installed.");
}

async function main() {
  console.log("\n--- Installing Foundry tooling ------------------------------");

  console.log("\n[1/2] Binaries (forge, anvil, cast, chisel)");
  await installBinaries();

  console.log("\n[2/2] forge-std Solidity library");
  installForgeStd();

  console.log("\n[ok] Done. foundry/ is ready.\n");
}

main().catch((err) => {
  console.error(`\nx install-foundry failed: ${err.message || err}`);
  process.exit(1);
});
