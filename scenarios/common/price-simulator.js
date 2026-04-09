"use strict";

function hashSeed(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) {
    return (Math.floor(seed) >>> 0) || 1;
  }
  const text = String(seed ?? "1");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h || 1;
}

function createRng(seed) {
  let t = hashSeed(seed);
  return function rng() {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function createNormalSampler(rng) {
  let spare = null;
  return function normal() {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    const z0 = mag * Math.cos(2 * Math.PI * v);
    const z1 = mag * Math.sin(2 * Math.PI * v);
    spare = z1;
    return z0;
  };
}

function generatePricePath({
  startPrice = 3000,
  steps = 2500,
  drift = 0,
  vol = 0.006,
  maxStepPct = 0.02,
  targetMultiplier = null,
  seed = 1,
}) {
  if (!Number.isFinite(startPrice) || startPrice <= 0) throw new Error("bad startPrice");
  if (!Number.isInteger(steps) || steps < 2) throw new Error("bad steps");

  const rng = createRng(seed);
  const normal = createNormalSampler(rng);
  const raw = new Array(steps);
  raw[0] = startPrice;

  for (let i = 1; i < steps; i++) {
    const shock = drift + vol * normal();
    const stepRet = clamp(shock, -maxStepPct, maxStepPct);
    const next = raw[i - 1] * (1 + stepRet);
    raw[i] = Math.max(1, next);
  }

  if (targetMultiplier === null || targetMultiplier <= 0) {
    return raw.map((p) => Math.max(1, Math.round(p)));
  }

  const targetEnd = startPrice * targetMultiplier;
  const rawEnd = raw[steps - 1];
  const baseScale = targetEnd / rawEnd;
  const adjusted = new Array(steps);
  adjusted[0] = Math.max(1, Math.round(startPrice));

  for (let i = 1; i < steps; i++) {
    const t = i / (steps - 1);
    const smoothScale = Math.pow(baseScale, t);
    adjusted[i] = Math.max(1, Math.round(raw[i] * smoothScale));
  }
  return adjusted;
}

function buildRegimePath({ regime, startPrice = 3000, steps = 2500, seed = 1 }) {
  const r = String(regime || "").toLowerCase();

  if (r === "uptrend") {
    return generatePricePath({
      startPrice,
      steps,
      drift: 0.00045,
      vol: 0.007,
      maxStepPct: 0.02,
      targetMultiplier: 2.0,
      seed,
    });
  }

  if (r === "downtrend") {
    return generatePricePath({
      startPrice,
      steps,
      drift: -0.00035,
      vol: 0.007,
      maxStepPct: 0.02,
      targetMultiplier: 0.5,
      seed,
    });
  }

  if (r === "neutral") {
    return generatePricePath({
      startPrice,
      steps,
      drift: 0.0,
      vol: 0.006,
      maxStepPct: 0.018,
      targetMultiplier: 1.0,
      seed,
    });
  }

  if (r === "random") {
    return generatePricePath({
      startPrice,
      steps,
      drift: 0.00005,
      vol: 0.007,
      maxStepPct: 0.02,
      targetMultiplier: null,
      seed,
    });
  }

  throw new Error(`unknown regime: ${regime}`);
}

module.exports = {
  createRng,
  generatePricePath,
  buildRegimePath,
};

