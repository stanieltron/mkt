#!/usr/bin/env node
/**
 * install-foundry.js
 *
 * Installs Foundry binaries (forge, anvil, cast, chisel) and forge-std
 * into the local foundry/ directory so the project is self-contained.
 *
 * Behaviour:
 *  1. Binaries  - prefer globally installed Foundry from PATH.
 *                 If missing, download the latest official release asset
 *                 from foundry-rs/foundry into foundry/bin.
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
  rmSync,
  readdirSync,
  renameSync,
} = require("node:fs");
const { resolve, join } = require("node:path");
const https = require("node:https");

const root = process.cwd();
const foundryDir = resolve(root, "foundry");
const binDir = resolve(foundryDir, "bin");
const libDir = resolve(foundryDir, "lib");
const forgeStdDir = resolve(libDir, "forge-std");

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

function fetchJson(url) {
  return new Promise((resolvePromise, reject) => {
    https
      .get(url, { headers: { "User-Agent": "mkt-install-foundry", Accept: "application/vnd.github+json" } }, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolvePromise(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

async function getLatestFoundryArchiveFromApi() {
  const release = await fetchJson("https://api.github.com/repos/foundry-rs/foundry/releases/latest");
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const isArm = process.arch === "arm64";

  let candidates = [];
  if (process.platform === "win32") {
    candidates = [isArm ? "win32_arm64.zip" : "win32_amd64.zip"];
  } else if (process.platform === "darwin") {
    candidates = [isArm ? "darwin_arm64.tar.gz" : "darwin_amd64.tar.gz"];
  } else {
    candidates = [isArm ? "linux_arm64.tar.gz" : "linux_amd64.tar.gz", isArm ? "alpine_arm64.tar.gz" : "alpine_amd64.tar.gz"];
  }

  for (const suffix of candidates) {
    const asset = assets.find((a) => typeof a?.name === "string" && a.name.endsWith(suffix));
    if (asset?.browser_download_url) {
      return {
        url: asset.browser_download_url,
        format: asset.name.endsWith(".zip") ? "zip" : "tar.gz",
        name: asset.name,
      };
    }
  }

  throw new Error(`No compatible Foundry release asset found for ${process.platform}/${process.arch}`);
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

function extractTarGz(tarPath, destination) {
  if (commandAvailable("tar", ["--version"])) {
    run("tar", ["-xzf", tarPath, "-C", destination]);
    return;
  }
  if (commandAvailable("python3")) {
    run("python3", [
      "-c",
      "import tarfile,sys; tarfile.open(sys.argv[1], 'r:gz').extractall(sys.argv[2])",
      tarPath,
      destination,
    ]);
    return;
  }
  if (commandAvailable("python")) {
    run("python", [
      "-c",
      "import tarfile,sys; tarfile.open(sys.argv[1], 'r:gz').extractall(sys.argv[2])",
      tarPath,
      destination,
    ]);
    return;
  }
  console.error("x No TAR extractor found. Install `tar` or `python3`.");
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
  const asset = await getLatestFoundryArchiveFromApi();
  const archivePath = resolve(foundryDir, asset.format === "zip" ? "_foundry_download.zip" : "_foundry_download.tar.gz");
  console.log(`  Downloading Foundry from official release asset:\n  ${asset.url}`);
  await downloadFile(asset.url, archivePath);
  console.log(`  Download complete (${asset.name}).`);

  console.log("  Extracting to foundry/bin/ ...");
  if (asset.format === "zip") {
    extractZip(archivePath, binDir);
  } else {
    extractTarGz(archivePath, binDir);
  }

  if (existsSync(archivePath)) {
    unlinkSync(archivePath);
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

async function installForgeStd() {
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
    console.warn("  git not found; downloading forge-std archive instead...");
    const archiveUrl = "https://codeload.github.com/foundry-rs/forge-std/tar.gz/refs/heads/master";
    const archivePath = resolve(libDir, "_forge-std.tar.gz");
    const tmpExtractDir = resolve(libDir, "_forge-std_extract");
    if (existsSync(tmpExtractDir)) rmSync(tmpExtractDir, { recursive: true, force: true });
    mkdirSync(tmpExtractDir, { recursive: true });
    await downloadFile(archiveUrl, archivePath);
    extractTarGz(archivePath, tmpExtractDir);
    const extracted = readdirSync(tmpExtractDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .find((name) => name.startsWith("forge-std-"));
    if (!extracted) {
      throw new Error("Unable to locate extracted forge-std directory from archive");
    }
    if (existsSync(forgeStdDir)) rmSync(forgeStdDir, { recursive: true, force: true });
    renameSync(join(tmpExtractDir, extracted), forgeStdDir);
    if (existsSync(archivePath)) unlinkSync(archivePath);
    if (existsSync(tmpExtractDir)) rmSync(tmpExtractDir, { recursive: true, force: true });
    console.log("[ok] forge-std installed (archive fallback).");
    return;
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
  await installForgeStd();

  console.log("\n[ok] Done. foundry/ is ready.\n");
}

main().catch((err) => {
  console.error(`\nx install-foundry failed: ${err.message || err}`);
  process.exit(1);
});
