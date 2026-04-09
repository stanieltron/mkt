"use strict";

const fs = require("fs");
const path = require("path");

function toSerializable(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toSerializable);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toSerializable(v);
    return out;
  }
  return value;
}

function normalizeName(name) {
  const normalized = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "scenario-result";
}

function writeScenarioResult({ scenarioName, payload }) {
  const fileName = `${normalizeName(scenarioName)}.json`;
  const resultsDir = path.resolve(__dirname, "..", "results");
  const filePath = path.join(resultsDir, fileName);

  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      toSerializable({
        scenarioName,
        generatedAt: new Date().toISOString(),
        result: payload,
      }),
      null,
      2
    ) + "\n",
    "utf8"
  );

  return filePath;
}

module.exports = {
  writeScenarioResult,
};
