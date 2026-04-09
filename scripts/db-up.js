#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const freshMode = process.argv.includes("--fresh") || process.env.DB_FRESH === "1";

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    stdio: "inherit",
    shell: false,
    env: process.env,
    ...options,
  });
}

function check(cmd, args) {
  const res = spawnSync(cmd, args, {
    stdio: "ignore",
    shell: false,
    env: process.env,
  });
  return (res.status ?? 1) === 0;
}

function detectCompose() {
  if (check("docker", ["compose", "version"])) {
    return {
      cmd: "docker",
      prefix: ["compose"],
      label: "docker compose",
    };
  }

  if (check("docker-compose", ["version"])) {
    return {
      cmd: "docker-compose",
      prefix: [],
      label: "docker-compose",
    };
  }

  return null;
}

function runCompose(compose, args) {
  return run(compose.cmd, [...compose.prefix, ...args]);
}

function main() {
  const compose = detectCompose();
  if (!compose) {
    console.error("No Docker Compose command found. Install `docker compose` or `docker-compose`.");
    process.exit(1);
  }

  if (freshMode) {
    console.log(`[db-up] resetting PostgreSQL state via ${compose.label}...`);
    const downRes = runCompose(compose, ["down", "-v", "--remove-orphans"]);
    if ((downRes.status ?? 1) !== 0) {
      process.exit(downRes.status ?? 1);
    }
  }

  const upRes = runCompose(compose, ["up", "-d", "db"]);
  process.exit(upRes.status ?? 1);
}

main();

