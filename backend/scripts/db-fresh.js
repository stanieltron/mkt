#!/usr/bin/env node
"use strict";

const { Client } = require("pg");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
    await client.query("COMMIT");
    console.log("[db-fresh] public schema reset complete");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[db-fresh] failed: ${String(error?.message || error)}`);
  process.exit(1);
});