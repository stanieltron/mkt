#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
console.warn("[mysql-up] deprecated; forwarding to scripts/db-up.js");
const forwardedArgs = process.argv.slice(2);
const result = spawnSync("node", ["scripts/db-up.js", ...forwardedArgs], {
  stdio: "inherit",
  shell: false,
  env: process.env,
});
process.exit(result.status ?? 1);
