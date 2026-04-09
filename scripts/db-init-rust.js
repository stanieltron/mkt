#!/usr/bin/env node
/**
 * db-init-rust.js
 * Initializes the Postgres database from scratch for the Rust backend.
 * - Drops & recreates the public schema (removes all Prisma or stale state)
 * - Applies backend/migrations/20260401000000_init.sql directly via pg
 *
 * Usage: node scripts/db-init-rust.js [--fresh]
 */

const { Client } = require("pg");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const net = require("node:net");

const freshMode = process.argv.includes("--fresh") || process.env.DB_FRESH === "1";
const root = process.cwd();

const migrationFile = resolve(root, "backend", "migrations", "20260401000000_init.sql");

const postgresHost = process.env.POSTGRES_HOST || process.env.PGHOST || "127.0.0.1";
const postgresPort = Number(process.env.POSTGRES_PORT || process.env.PGPORT || "5434");
const postgresDb = process.env.POSTGRES_DB || process.env.PGDATABASE || "appdb";
const postgresUser = process.env.POSTGRES_USER || process.env.PGUSER || "app";
const postgresPassword = process.env.POSTGRES_PASSWORD || process.env.PGPASSWORD || "app";
const initialPriceUsdc6PerWeth = BigInt(process.env.INITIAL_PRICE_USDC_6_PER_WETH || "2000000000");
const seedHistoryHours = Number(process.env.SEED_PRICE_HISTORY_HOURS || "24");
const seedHistoryStepSeconds = Number(process.env.SEED_PRICE_HISTORY_STEP_SECONDS || "60");

function formatUtcTimestampNoZone(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  const millis = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}`;
}

function waitForPostgres(host, port, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((res, rej) => {
    const attempt = () => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket
        .once("connect", () => { socket.destroy(); res(); })
        .once("timeout", () => {
          socket.destroy();
          if (Date.now() - start > timeoutMs) return rej(new Error(`Timed out waiting for Postgres at ${host}:${port}`));
          setTimeout(attempt, 1000);
        })
        .once("error", () => {
          socket.destroy();
          if (Date.now() - start > timeoutMs) return rej(new Error(`Timed out waiting for Postgres at ${host}:${port}`));
          setTimeout(attempt, 1000);
        })
        .connect(port, host);
    };
    attempt();
  });
}

async function main() {
  console.log(`[db-init-rust] waiting for Postgres at ${postgresHost}:${postgresPort}...`);
  await waitForPostgres(postgresHost, postgresPort);

  const client = new Client({
    host: postgresHost,
    port: postgresPort,
    database: postgresDb,
    user: postgresUser,
    password: postgresPassword,
  });
  await client.connect();

  try {
    if (freshMode) {
      console.log("[db-init-rust] fresh mode: dropping and recreating public schema...");
      await client.query("DROP SCHEMA public CASCADE;");
      await client.query("CREATE SCHEMA public;");
      console.log("[db-init-rust] schema wiped.");
    }

    // Check if tables already exist (idempotent when not fresh)
    const check = await client.query(
      `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='User'`
    );
    if (Number(check.rows[0].count) > 0 && !freshMode) {
      console.log('[db-init-rust] schema already initialized, skipping migration (use --fresh to reset).');
      return;
    }

    console.log(`[db-init-rust] applying migration: ${migrationFile}`);
    const sql = readFileSync(migrationFile, "utf8");
    await client.query(sql);
    console.log("[db-init-rust] migration applied successfully.");

    const seedPrice = (initialPriceUsdc6PerWeth * 1000000000000n).toString();
    const totalSeconds = Math.max(seedHistoryStepSeconds, Math.floor(seedHistoryHours * 3600));
    const sampleCount = Math.floor(totalSeconds / seedHistoryStepSeconds) + 1;
    const now = Date.now();
    const values = [];
    const placeholders = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const secondsAgo = totalSeconds - index * seedHistoryStepSeconds;
      const timestamp = formatUtcTimestampNoZone(new Date(now - secondsAgo * 1000));
      const base = values.length;
      placeholders.push(`($${base + 1}, $${base + 2})`);
      values.push(seedPrice, timestamp);
    }
    await client.query(
      `INSERT INTO "PriceSample" (price, timestamp) VALUES ${placeholders.join(", ")}`,
      values
    );
    console.log(
      `[db-init-rust] seeded ${sampleCount} raw price samples at ${seedPrice} covering ${seedHistoryHours}h.`
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[db-init-rust] failed:", err?.message || err);
  process.exit(1);
});
