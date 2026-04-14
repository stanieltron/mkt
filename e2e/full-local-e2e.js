#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { readFileSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { Wallet, JsonRpcProvider, Contract, NonceManager, parseUnits, formatUnits } = require("ethers");
const { Client } = require("pg");

const root = process.cwd();
const WS = globalThis.WebSocket;
const COLORS = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
let stepNo = 0;
const checklist = {
  stack: false,
  faucet: false,
  referrals: false,
  ws: false,
  matrix: false,
  referral_volume: false,
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];
const ORACLE_ABI = [
  "function getPriceE18() view returns (uint256)",
];
const MAKEIT_ABI = [
  "function openLongTrade(uint256 expectedPriceE18,uint256 toleranceBps,uint32 profitTargetPpm,uint32 tradeLeverage,uint96 tradeMarginUSDC) returns (uint256 tradeId)",
  "function openShortTrade(uint256 expectedPriceE18,uint256 toleranceBps,uint32 profitTargetPpm,uint32 tradeLeverage,uint96 tradeMarginUSDC) returns (uint256 tradeId)",
  "function liquidateTrade(uint256 tradeId)",
  "function rebalanceUsdcToEth(uint256 usdcAmount6)",
  "function getTrade(uint256 tradeId) view returns ((address trader,uint8 side,uint8 status,uint40 openedAt,uint32 profitTargetPpm,uint32 leverage,uint96 marginUSDC,uint128 notionalUSDC,uint256 entryPriceE18,uint256 tpPriceE18,uint256 slPriceE18))",
  "function reservedMarginUSDC() view returns (uint256)",
  "function protocolFeeAccruedUSDC() view returns (uint256)",
];
const SWAP_ADAPTER_ABI = [
  "function buyWETHWithExactUSDC(uint256 usdcIn6,address payer,address recipient) returns (uint256 usdcSpent6,uint256 wethOut18)",
  "function sellWETHForExactUSDC(uint256 usdcNeeded6,address payer,address recipient) returns (uint256 wethSold18,uint256 usdcOut6)",
];

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseEnvFile(path) {
  const env = {};
  const raw = readFileSync(path, "utf8");
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    env[line.slice(0, at)] = line.slice(at + 1);
  }
  return env;
}

async function isHealthy(url) {
  try {
    await fetchJson(url, {}, 2000);
    return true;
  } catch {
    return false;
  }
}

function stopManagedStack(child) {
  return new Promise((resolveStop) => {
    if (!child || child.exitCode !== null || child.killed) {
      resolveStop();
      return;
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolveStop();
    };

    child.once("exit", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
      return;
    }

    setTimeout(() => {
      if (child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
      finish();
    }, 10000);
  });
}

async function ensureLocalStackReady() {
  const envPath = resolve(root, "e2e", ".env");
  let env = existsSync(envPath) ? parseEnvFile(envPath) : null;
  const reuse = process.env.E2E_REUSE_STACK === "1";

  if (reuse && env) {
    const relayBase = env.BACKEND_URL || "http://127.0.0.1:8787";
    const upstreamBase = `http://127.0.0.1:${env.LOCAL_BACKEND_UPSTREAM_PORT || "8788"}`;
    const relayOk = await isHealthy(`${relayBase}/api/health`);
    const upstreamOk = await isHealthy(`${upstreamBase}/api/health`);
    if (relayOk && upstreamOk) {
      return { env, managedStack: null };
    }
  }

  console.log("[e2e] starting deterministic local stack via npm run local:fresh ...");
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const managedStack = spawn(npmCmd, ["run", "local:fresh"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });

  let exited = false;
  let exitCode = null;
  managedStack.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  await waitFor(
    "local stack ready",
    async () => {
      if (exited) {
        throw new Error(`local:fresh exited before readiness (code=${exitCode ?? "unknown"})`);
      }
      if (!existsSync(envPath)) return false;
      env = parseEnvFile(envPath);
      const relayBase = env.BACKEND_URL || "http://127.0.0.1:8787";
      const upstreamBase = `http://127.0.0.1:${env.LOCAL_BACKEND_UPSTREAM_PORT || "8788"}`;
      const relayOk = await isHealthy(`${relayBase}/api/health`);
      const upstreamOk = await isHealthy(`${upstreamBase}/api/health`);
      return relayOk && upstreamOk;
    },
    360000,
    2000
  );

  return { env, managedStack };
}

async function fetchJson(url, init = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${JSON.stringify(body)}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitFor(label, fn, timeoutMs = 30000, stepMs = 750) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await fn();
    if (ok) return true;
    await sleep(stepMs);
  }
  throw new Error(`timeout: ${label}`);
}

function wsCollector(url) {
  const state = {
    open: false,
    events: {},
    messages: [],
    socket: null,
  };
  if (!WS) return state;
  const ws = new WS(url);
  state.socket = ws;
  ws.onopen = () => { state.open = true; };
  ws.onmessage = (evt) => {
    let parsed = null;
    try { parsed = JSON.parse(String(evt.data)); } catch { return; }
    const name = parsed?.event || "unknown";
    state.events[name] = (state.events[name] || 0) + 1;
    state.messages.push(parsed);
    if (state.messages.length > 200) state.messages.shift();
  };
  ws.onclose = () => { state.open = false; };
  return state;
}

function pushResult(results, name, ok, detail = "") {
  results.push({ name, ok, detail });
  const mark = ok
    ? `${COLORS.green}PASS${COLORS.reset}`
    : `${COLORS.red}FAIL${COLORS.reset}`;
  console.log(`[e2e] ${mark} ${name}${detail ? ` :: ${detail}` : ""}`);
  if (name === "stack health") checklist.stack = ok;
  if (name === "faucet 10 wallets") checklist.faucet = ok;
  if (name === "referral chain register 10 wallets") checklist.referrals = ok;
  if (name === "prepare ws collectors") checklist.ws = ok;
  if (name === "strict trade matrix (long/short, tp/sl, lev 100/300, payout paths)") checklist.matrix = ok;
  if (name === "referral volumes positive after trades") checklist.referral_volume = ok;
}

function statusCell(ok) {
  return ok ? `${COLORS.green}PASS${COLORS.reset}` : `${COLORS.red}FAIL${COLORS.reset}`;
}

function decimalToBigInt(raw) {
  const s = String(raw ?? "0").trim();
  if (!s) return 0n;
  const whole = s.includes(".") ? s.slice(0, s.indexOf(".")) : s;
  if (!whole || whole === "-" || whole === "+") return 0n;
  return BigInt(whole);
}

function toE18Number(raw) {
  return Number(formatUnits(decimalToBigInt(raw), 18));
}

function toUsdcNumber(raw) {
  return Number(formatUnits(decimalToBigInt(raw), 6));
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected=${expected} actual=${actual}`);
  }
}

function expectTrue(cond, label) {
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

function ppmMulDiv(value, ppm) {
  return (value * BigInt(ppm)) / 1_000_000n;
}

function calcExpected(grossMarginUsdc6, leverage, side, outcome, entryPriceE18) {
  const lpFeePpm = 70n;
  const protocolFeePpm = 30n;
  const totalFeePpm = lpFeePpm + protocolFeePpm;
  const gross = BigInt(grossMarginUsdc6);
  const lev = BigInt(leverage);
  const fee = (gross * lev * totalFeePpm) / 1_000_000n;
  const effective = gross - fee;
  const move = BigInt(entryPriceE18) / lev;
  const entry = BigInt(entryPriceE18);

  let tp;
  let sl;
  if (side === "LONG") {
    tp = entry + move;
    sl = entry - move;
  } else {
    tp = entry - move;
    sl = entry + move;
  }

  const win = outcome === "TP";
  const pnl = win ? effective : -effective;
  const payout = win ? effective * 2n : 0n;
  return { fee, effective, tp, sl, pnl, payout };
}

async function runTest(name, results, fn) {
  stepNo += 1;
  console.log(`\n[e2e] ${COLORS.cyan}STEP ${stepNo}${COLORS.reset} ${name}`);
  try {
    const detail = await fn();
    pushResult(results, name, true, detail || "");
    return true;
  } catch (e) {
    pushResult(results, name, false, String(e?.message || e));
    return false;
  }
}

async function main() {
  const results = [];
  let managedStack = null;
  let pg = null;
  const wsByWallet = new Map();
  let env;
  try {
    const ready = await ensureLocalStackReady();
    env = ready.env;
    managedStack = ready.managedStack;
  } catch (error) {
    console.error(`[e2e] unable to prepare local stack: ${String(error?.message || error)}`);
    process.exit(1);
  }

  const relayBase = env.BACKEND_URL || "http://127.0.0.1:8787";
  const upstreamBase = `http://127.0.0.1:${env.LOCAL_BACKEND_UPSTREAM_PORT || "8788"}`;
  const provider = new JsonRpcProvider(env.RPC_URL || "http://127.0.0.1:8545");

  const usdc = new Contract(env.USDC_ADDRESS, ERC20_ABI, provider);
  const weth = new Contract(env.WETH_ADDRESS, ERC20_ABI, provider);
  const oracle = new Contract(env.ORACLE_ADDRESS, ORACLE_ABI, provider);
  const makeitRead = new Contract(env.MAKEIT_ADDRESS, MAKEIT_ABI, provider);

  const swapper = new NonceManager(new Wallet(env.SWAPPER_PRIVATE_KEY, provider));
  const defaultDeployerPk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const localDeployEnvPath = resolve(root, "local_deploy_rust", ".env");
  let deployerPk = env.DEPLOYER_PRIVATE_KEY || defaultDeployerPk;
  if (!env.DEPLOYER_PRIVATE_KEY && existsSync(localDeployEnvPath)) {
    const localEnv = parseEnvFile(localDeployEnvPath);
    if (localEnv.DEPLOYER_PRIVATE_KEY) {
      deployerPk = localEnv.DEPLOYER_PRIVATE_KEY;
    }
  }
  const ownerSigner = new NonceManager(new Wallet(deployerPk, provider));
  const swapperAddr = await swapper.getAddress();
  const ownerAddr = await ownerSigner.getAddress();
  const swapAdapter = new Contract(env.SWAP_ADAPTER_ADDRESS, SWAP_ADAPTER_ABI, swapper);
  const makeitOwner = new Contract(env.MAKEIT_ADDRESS, MAKEIT_ABI, ownerSigner);

  const wallets = Array.from({ length: 10 }, (_, idx) => {
    const i = idx + 1;
    const pk = env[`TEST_WALLET_${i}_PRIVATE_KEY`];
    if (!pk) {
      throw new Error(`Missing TEST_WALLET_${i}_PRIVATE_KEY in e2e/.env`);
    }
    const base = new Wallet(pk, provider);
    const signer = new NonceManager(base);
    return {
      index: i,
      address: base.address,
      signer,
    };
  });
  const tradeWallets = wallets.slice(0, 8);

  const matrixCases = [
    { key: "L100_TP", walletIdx: 1, side: "LONG", leverage: 100, outcome: "TP", expectedSettlement: "USDC_POOL_PAYOUT", wave: "UP" },
    { key: "S100_SL", walletIdx: 2, side: "SHORT", leverage: 100, outcome: "SL", expectedSettlement: "MARGIN_RETAINED", wave: "UP" },
    { key: "L300_TP", walletIdx: 3, side: "LONG", leverage: 300, outcome: "TP", expectedSettlement: "USDC_POOL_PAYOUT", wave: "UP" },
    { key: "S300_SL", walletIdx: 4, side: "SHORT", leverage: 300, outcome: "SL", expectedSettlement: "MARGIN_RETAINED", wave: "UP" },
    { key: "L100_SL", walletIdx: 5, side: "LONG", leverage: 100, outcome: "SL", expectedSettlement: "BUY_WETH_ON_SL", wave: "DOWN" },
    { key: "S100_TP", walletIdx: 6, side: "SHORT", leverage: 100, outcome: "TP", expectedSettlement: "SELL_WETH_FOR_PROFIT", wave: "DOWN" },
    { key: "L300_SL", walletIdx: 7, side: "LONG", leverage: 300, outcome: "SL", expectedSettlement: "BUY_WETH_ON_SL", wave: "DOWN" },
    { key: "S300_TP", walletIdx: 8, side: "SHORT", leverage: 300, outcome: "TP", expectedSettlement: "SELL_WETH_FOR_PROFIT", wave: "DOWN" },
  ];

  const openedByCase = new Map();
  const faucetClaimed = new Set();

  await runTest("stack health", results, async () => {
    await fetchJson(`${relayBase}/api/health`);
    await fetchJson(`${upstreamBase}/api/health`);
    return "relay + upstream healthy";
  });

  await runTest("faucet 10 wallets", results, async () => {
    for (const wallet of wallets) {
      const key = wallet.address.toLowerCase();
      if (faucetClaimed.has(key)) {
        throw new Error(`duplicate faucet claim attempt for ${wallet.address}`);
      }
      const out = await fetchJson(`${relayBase}/api/faucet/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet.address }),
      });
      if (!out?.ok) throw new Error(`faucet failed for ${wallet.address}`);
      faucetClaimed.add(key);
    }
    return "all wallets funded";
  });

  await runTest("referral chain register 10 wallets", results, async () => {
    const login1 = await fetchJson(`${upstreamBase}/api/users/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallets[0].address }),
    });
    const code1 = login1?.user?.referralCode;
    if (!code1) throw new Error("wallet1 code missing");

    const login2 = await fetchJson(`${upstreamBase}/api/users/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallets[1].address, referralCode: code1 }),
    });
    const code2 = login2?.user?.referralCode;
    if (!code2) throw new Error("wallet2 code missing");

    const login3 = await fetchJson(`${upstreamBase}/api/users/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallets[2].address, referralCode: code2 }),
    });
    const code3 = login3?.user?.referralCode;
    if (!code3) throw new Error("wallet3 code missing");

    let prevCode = code3;
    for (let i = 3; i < wallets.length; i += 1) {
      const login = await fetchJson(`${upstreamBase}/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: wallets[i].address, referralCode: prevCode }),
      });
      prevCode = login?.user?.referralCode || prevCode;
    }

    pg = new Client({ connectionString: env.DATABASE_URL });
    await pg.connect();
    const rows = await pg.query(
      `SELECT id, "walletAddress", "referredBy"
       FROM "User"
       WHERE "walletAddress" = ANY($1::text[])`,
      [wallets.map((w) => w.address.toLowerCase())]
    );
    const byWallet = new Map(rows.rows.map((r) => [String(r.walletAddress).toLowerCase(), r]));
    expectEqual(byWallet.size, 10, "all referral users exist");

    const w1 = byWallet.get(wallets[0].address.toLowerCase());
    expectTrue(!!w1, "wallet1 exists");
    expectTrue(w1.referredBy == null, "wallet1 has no referrer");
    for (let i = 1; i < wallets.length; i += 1) {
      const child = byWallet.get(wallets[i].address.toLowerCase());
      const parent = byWallet.get(wallets[i - 1].address.toLowerCase());
      expectTrue(!!child && !!parent, `wallet ${i + 1} and parent exist`);
      expectEqual(Number(child.referredBy || 0), Number(parent.id), `wallet${i + 1} referredBy wallet${i}`);
    }

    const ref1 = await fetchJson(`${upstreamBase}/api/users/${wallets[0].address.toLowerCase()}/referrals`);
    const ref2 = await fetchJson(`${upstreamBase}/api/users/${wallets[1].address.toLowerCase()}/referrals`);
    expectEqual((ref1?.tier1 || []).length, 1, "wallet1 tier1 count");
    expectEqual((ref1?.tier2 || []).length, 1, "wallet1 tier2 count");
    expectEqual((ref2?.tier1 || []).length, 1, "wallet2 tier1 count");
    expectEqual((ref2?.tier2 || []).length, 1, "wallet2 tier2 count");
    return "wallet chain linkage verified in DB and API";
  });

  await runTest("prepare ws collectors", results, async () => {
    for (const wallet of tradeWallets) {
      const wsUrl = `${relayBase.replace(/^http/i, "ws").replace(/\/+$/, "")}/ws?wallet=${wallet.address.toLowerCase()}`;
      const collector = wsCollector(wsUrl);
      wsByWallet.set(wallet.address.toLowerCase(), collector);
    }
    await waitFor("ws open", async () => Array.from(wsByWallet.values()).every((v) => v.open), 10000, 300);
    return "wallet ws streams connected";
  });

  await runTest("strict trade matrix (long/short, tp/sl, lev 100/300, payout paths)", results, async () => {
    const margin = parseUnits("10", 6);
    const targetPpm = 1_000_000;
    const tolerance = 3_000;
    const MAX_UINT256 = (2n ** 256n) - 1n;
    if (!pg) {
      pg = new Client({ connectionString: env.DATABASE_URL });
      await pg.connect();
    }

    const primeAllAllowances = async () => {
      const actors = [
        ...wallets.map((w) => ({ signer: w.signer, addr: w.address.toLowerCase(), label: `wallet${w.index}` })),
        { signer: swapper, addr: swapperAddr.toLowerCase(), label: "swapper" },
      ];
      for (const actor of actors) {
        const usdcW = usdc.connect(actor.signer);
        const wethW = weth.connect(actor.signer);
        if ((await usdcW.allowance(actor.addr, env.MAKEIT_ADDRESS)) !== MAX_UINT256) {
          await (await usdcW.approve(env.MAKEIT_ADDRESS, MAX_UINT256)).wait();
        }
        if ((await usdcW.allowance(actor.addr, env.SWAP_ADAPTER_ADDRESS)) !== MAX_UINT256) {
          await (await usdcW.approve(env.SWAP_ADAPTER_ADDRESS, MAX_UINT256)).wait();
        }
        if ((await wethW.allowance(actor.addr, env.SWAP_ADAPTER_ADDRESS)) !== MAX_UINT256) {
          await (await wethW.approve(env.SWAP_ADAPTER_ADDRESS, MAX_UINT256)).wait();
        }
      }
    };

    const fmtUsdc6 = (v) => Number(formatUnits(v, 6)).toFixed(4);
    const fmtWeth18 = (v) => Number(formatUnits(v, 18)).toFixed(6);
    const fmtPriceE18 = (v) => Number(formatUnits(v, 18)).toFixed(4);
    const makeitAddr = env.MAKEIT_ADDRESS.toLowerCase();

    const getPoolState = async () => {
      const [u, w, r, p] = await Promise.all([
        usdc.balanceOf(makeitAddr),
        weth.balanceOf(makeitAddr),
        makeitRead.reservedMarginUSDC(),
        makeitRead.protocolFeeAccruedUSDC(),
      ]);
      const locked = r + p;
      const free = u > locked ? (u - locked) : 0n;
      return { usdc6: u, weth18: w, reserved6: r, protocol6: p, free6: free };
    };

    const ensureAllowances = async (signer, addr) => {
      const usdcW = usdc.connect(signer);
      const wethW = weth.connect(signer);
      if ((await usdcW.allowance(addr, env.MAKEIT_ADDRESS)) < margin) {
        await (await usdcW.approve(env.MAKEIT_ADDRESS, MAX_UINT256)).wait();
      }
      if ((await usdcW.allowance(addr, env.SWAP_ADAPTER_ADDRESS)) === 0n) {
        await (await usdcW.approve(env.SWAP_ADAPTER_ADDRESS, MAX_UINT256)).wait();
      }
      if ((await wethW.allowance(addr, env.SWAP_ADAPTER_ADDRESS)) === 0n) {
        await (await wethW.approve(env.SWAP_ADAPTER_ADDRESS, MAX_UINT256)).wait();
      }
    };
    const ensureSwapperAllowancesAndBalances = async () => {
      const usdcW = usdc.connect(swapper);
      const wethW = weth.connect(swapper);
      if ((await usdcW.allowance(swapperAddr, env.SWAP_ADAPTER_ADDRESS)) === 0n) {
        await (await usdcW.approve(env.SWAP_ADAPTER_ADDRESS, MAX_UINT256)).wait();
      }
      if ((await wethW.allowance(swapperAddr, env.SWAP_ADAPTER_ADDRESS)) === 0n) {
        await (await wethW.approve(env.SWAP_ADAPTER_ADDRESS, MAX_UINT256)).wait();
      }
      const usdcBal = await usdc.balanceOf(swapperAddr);
      const wethBal = await weth.balanceOf(swapperAddr);
      expectTrue(usdcBal > parseUnits("25000", 6), "swapper usdc balance too low for price-up wave");
      expectTrue(wethBal > parseUnits("5", 18), "swapper weth balance too low for price-down wave");
    };

    const openCase = async (c) => {
      const wallet = wallets[c.walletIdx - 1];
      const makeit = new Contract(env.MAKEIT_ADDRESS, MAKEIT_ABI, wallet.signer);
      await ensureAllowances(wallet.signer, wallet.address);
      const userUsdcBefore = await usdc.balanceOf(wallet.address);
      const poolUsdcBefore = await usdc.balanceOf(makeitAddr);
      const expectedPrice = await oracle.getPriceE18();
      let predictedId;
      let tx;
      if (c.side === "LONG") {
        predictedId = await makeit.openLongTrade.staticCall(expectedPrice, tolerance, targetPpm, c.leverage, margin);
        tx = await makeit.openLongTrade(expectedPrice, tolerance, targetPpm, c.leverage, margin);
      } else {
        predictedId = await makeit.openShortTrade.staticCall(expectedPrice, tolerance, targetPpm, c.leverage, margin);
        tx = await makeit.openShortTrade(expectedPrice, tolerance, targetPpm, c.leverage, margin);
      }
      await tx.wait();
      const tradeId = Number(predictedId);
      const trade = await makeitRead.getTrade(tradeId);
      const ex = calcExpected(margin, c.leverage, c.side, c.outcome, trade.entryPriceE18);
      expectEqual(BigInt(trade.tpPriceE18), ex.tp, `${c.key} tp`);
      expectEqual(BigInt(trade.slPriceE18), ex.sl, `${c.key} sl`);
      const userUsdcAfter = await usdc.balanceOf(wallet.address);
      const poolUsdcAfter = await usdc.balanceOf(makeitAddr);
      expectEqual(userUsdcBefore - userUsdcAfter, margin, `${c.key} user usdc debit on open`);
      expectEqual(poolUsdcAfter - poolUsdcBefore, margin, `${c.key} pool usdc credit on open`);

      await waitFor(
        `${c.key} open row in db`,
        async () => {
          const row = await pg.query(
            `SELECT status, direction, leverage, margin, "entryPrice", "tpPrice", "slPrice"
             FROM "Trade" t
             JOIN "User" u ON u.id = t."userId"
             WHERE u."walletAddress" = $1 AND t."onChainTradeId" = $2`,
            [wallet.address.toLowerCase(), tradeId]
          );
          if (row.rows.length !== 1) return false;
          const r = row.rows[0];
          return String(r.status || "").toUpperCase() === "OPEN"
            && String(r.direction || "").toUpperCase() === c.side
            && Number(r.leverage || 0) === c.leverage;
        },
        20000,
        300
      );

      console.log(
        `[e2e] open ${c.key} tradeId=${tradeId} wallet=${wallet.address} ` +
        `entry=${fmtPriceE18(trade.entryPriceE18)} tp=${fmtPriceE18(ex.tp)} sl=${fmtPriceE18(ex.sl)} ` +
        `userUsdc(before=${fmtUsdc6(userUsdcBefore)} after=${fmtUsdc6(userUsdcAfter)} delta=${fmtUsdc6(userUsdcAfter - userUsdcBefore)}) ` +
        `makeitUsdc(before=${fmtUsdc6(poolUsdcBefore)} after=${fmtUsdc6(poolUsdcAfter)} delta=+${fmtUsdc6(poolUsdcAfter - poolUsdcBefore)})`
      );
      openedByCase.set(c.key, {
        ...c,
        wallet: wallet.address.toLowerCase(),
        tradeId,
        entryPriceE18: BigInt(trade.entryPriceE18),
        expected: ex,
        userUsdcBefore,
      });
    };

    const movePriceUpTo = async (targetPriceE18) => {
      let cur = await oracle.getPriceE18();
      let loops = 0;
      while (cur < targetPriceE18 && loops < 30) {
        await (await swapAdapter.buyWETHWithExactUSDC(parseUnits("4000", 6), swapperAddr, swapperAddr)).wait();
        cur = await oracle.getPriceE18();
        loops += 1;
        console.log(`[e2e] price move up ${loops}: ${fmtPriceE18(cur)}`);
        await sleep(2500);
      }
      if (cur < targetPriceE18) {
        throw new Error(`unable to move price up to target`);
      }
    };

    const movePriceDownTo = async (targetPriceE18) => {
      let cur = await oracle.getPriceE18();
      let loops = 0;
      while (cur > targetPriceE18 && loops < 30) {
        await (await swapAdapter.sellWETHForExactUSDC(parseUnits("7000", 6), swapperAddr, swapperAddr)).wait();
        cur = await oracle.getPriceE18();
        loops += 1;
        console.log(`[e2e] price move down ${loops}: ${fmtPriceE18(cur)}`);
        await sleep(2500);
      }
      if (cur > targetPriceE18) {
        throw new Error(`unable to move price down to target`);
      }
    };

    const waitClosed = async (cases, label) => {
      await waitFor(
        `all expected trades closed on chain (${label})`,
        async () => {
          for (const c of cases) {
            const o = openedByCase.get(c.key);
            const t = await makeitRead.getTrade(o.tradeId);
            if (Number(t.status) === 0) return false;
          }
          return true;
        },
        120000,
        800
      );
    };

    const verifyRows = async (cases, waveLabel) => {
      let sumPayout = 0n;
      let sumSold = 0n;
      let sumBought = 0n;
      const closeLogs = [];
      for (const c of cases) {
        const opened = openedByCase.get(c.key);
        const ex = opened.expected;
        const rowRes = await pg.query(
          `SELECT t.*, u."walletAddress"
           FROM "Trade" t
           JOIN "User" u ON u.id = t."userId"
           WHERE u."walletAddress" = $1 AND t."onChainTradeId" = $2
           LIMIT 1`,
          [opened.wallet, opened.tradeId]
        );
        expectEqual(rowRes.rows.length, 1, `${c.key} db row`);
        const row = rowRes.rows[0];

        expectEqual(String(row.direction || "").toUpperCase(), c.side, `${c.key} direction`);
        expectEqual(Number(row.leverage || 0), c.leverage, `${c.key} leverage`);
        expectEqual(decimalToBigInt(row.margin), ex.effective, `${c.key} margin`);
        expectEqual(decimalToBigInt(row.entryPrice), opened.entryPriceE18, `${c.key} entry`);
        expectEqual(decimalToBigInt(row.tpPrice), ex.tp, `${c.key} tp`);
        expectEqual(decimalToBigInt(row.slPrice), ex.sl, `${c.key} sl`);
        expectEqual(String(row.status || "").toUpperCase(), "LIQUIDATED", `${c.key} status`);
        expectEqual(String(row.closeReason || ""), c.outcome === "TP" ? "CLOSED_TP" : "CLOSED_SL", `${c.key} closeReason`);
        expectEqual(decimalToBigInt(row.pnl), ex.pnl, `${c.key} pnl`);
        expectEqual(decimalToBigInt(row.payoutUsdc), ex.payout, `${c.key} payoutUsdc`);
        expectEqual(String(row.settlementAction || ""), c.expectedSettlement, `${c.key} settlementAction`);
        expectEqual(decimalToBigInt(row.settlementUsdcAmount), ex.payout, `${c.key} settlementUsdcAmount`);
        expectTrue(decimalToBigInt(row.exitPrice) > 0n, `${c.key} exitPrice set`);
        expectTrue(String(row.closeTxHash || "").startsWith("0x"), `${c.key} close tx hash`);

        const sold = decimalToBigInt(row.soldWeth);
        const bought = decimalToBigInt(row.boughtWeth);
        const settWeth = decimalToBigInt(row.settlementWethAmount);
        if (c.expectedSettlement === "SELL_WETH_FOR_PROFIT") {
          expectTrue(sold > 0n, `${c.key} soldWeth > 0`);
          expectEqual(bought, 0n, `${c.key} boughtWeth=0`);
          expectTrue(settWeth > 0n, `${c.key} settlementWeth > 0`);
        } else if (c.expectedSettlement === "BUY_WETH_ON_SL") {
          expectEqual(sold, 0n, `${c.key} soldWeth=0`);
          expectTrue(bought > 0n, `${c.key} boughtWeth > 0`);
          expectTrue(settWeth > 0n, `${c.key} settlementWeth > 0`);
        } else {
          expectEqual(sold, 0n, `${c.key} soldWeth=0`);
          expectEqual(bought, 0n, `${c.key} boughtWeth=0`);
          expectEqual(settWeth, 0n, `${c.key} settlementWeth=0`);
        }

        const apiTrades = await fetchJson(`${upstreamBase}/api/trades?wallet=${opened.wallet}`);
        const closed = apiTrades?.closedTrades || [];
        const apiRow = closed.find((t) => String(t?.onChainTradeId || "") === String(opened.tradeId));
        expectTrue(!!apiRow, `${c.key} appears in closed trades api`);
        expectEqual(String(apiRow.closeReason || ""), c.outcome === "TP" ? "CLOSED_TP" : "CLOSED_SL", `${c.key} api closeReason`);

        const userFinal = await usdc.balanceOf(opened.wallet);
        const userBeforeClose = opened.userUsdcBefore - margin;
        const expectedUserFinal = opened.userUsdcBefore - margin + ex.payout;
        expectEqual(userFinal, expectedUserFinal, `${c.key} final user usdc`);

        sumPayout += ex.payout;
        sumSold += sold;
        sumBought += bought;

        closeLogs.push({
          key: c.key,
          tradeId: opened.tradeId,
          status: row.status,
          closeReason: row.closeReason,
          entry: opened.entryPriceE18,
          exit: decimalToBigInt(row.exitPrice),
          pnlRaw: String(row.pnl),
          payoutRaw: String(row.payoutUsdc),
          settlement: row.settlementAction,
          sold,
          bought,
          userBeforeClose,
          userFinal,
          expectedUserFinal,
          closeBlock: Number(row.closeBlockNumber || row.closeblocknumber || 0),
        });
      }
      closeLogs.sort((a, b) => (a.closeBlock - b.closeBlock) || (a.tradeId - b.tradeId));
      for (const l of closeLogs) {
        console.log(
          `[e2e] close ${waveLabel}#${l.closeBlock}:${l.tradeId} ${l.key} status=${l.status} closeReason=${l.closeReason} ` +
          `entry=${fmtPriceE18(l.entry)} close=${fmtPriceE18(l.exit)} ` +
          `pnlRaw=${l.pnlRaw} payoutRaw=${l.payoutRaw} ` +
          `settlement=${l.settlement} soldWeth=${fmtWeth18(l.sold)} boughtWeth=${fmtWeth18(l.bought)} ` +
          `userUsdc(beforeClose=${fmtUsdc6(l.userBeforeClose)} afterClose=${fmtUsdc6(l.userFinal)} expectedAfter=${fmtUsdc6(l.expectedUserFinal)})`
        );
      }
      console.log(
        `[e2e] ${waveLabel} summary: payout=${fmtUsdc6(sumPayout)} soldWeth=${fmtWeth18(sumSold)} boughtWeth=${fmtWeth18(sumBought)}`
      );
      return { sumPayout, sumSold, sumBought };
    };

    const upWave = matrixCases.filter((c) => c.wave === "UP");
    const downWave = matrixCases.filter((c) => c.wave === "DOWN");
    await primeAllAllowances();
    await ensureSwapperAllowancesAndBalances();

    console.log("[e2e] wave UP: opening trades");
    for (const c of upWave) await openCase(c);
    const upPreClose = await getPoolState();
    const upTarget = upWave.reduce((acc, c) => {
      const o = openedByCase.get(c.key);
      const boundary = c.outcome === "TP" ? o.expected.tp : o.expected.sl;
      return boundary > acc ? boundary : acc;
    }, 0n) + 10n ** 12n;
    console.log(
      `[e2e] wave UP makeit pre-close: usdc=${fmtUsdc6(upPreClose.usdc6)} free=${fmtUsdc6(upPreClose.free6)} ` +
      `reserved=${fmtUsdc6(upPreClose.reserved6)} protocol=${fmtUsdc6(upPreClose.protocol6)} weth=${fmtWeth18(upPreClose.weth18)}`
    );
    console.log(`[e2e] wave UP target price=${fmtPriceE18(upTarget)}`);
    await movePriceUpTo(upTarget);
    await waitClosed(upWave, "UP");
    await waitFor(
      "db rows closed for up wave",
      async () => {
        for (const c of upWave) {
          const o = openedByCase.get(c.key);
          const row = await pg.query(
            `SELECT status, pnl, "exitPrice", "closeReason"
             FROM "Trade" t
             JOIN "User" u ON u.id = t."userId"
             WHERE u."walletAddress" = $1 AND t."onChainTradeId" = $2`,
            [o.wallet, o.tradeId]
          );
          if (row.rows.length !== 1) return false;
          if (String(row.rows[0].status || "").toUpperCase() !== "LIQUIDATED") return false;
          if (row.rows[0].pnl == null || row.rows[0].exitPrice == null || !row.rows[0].closeReason) return false;
        }
        return true;
      },
      25000,
      400
    );
    const upResult = await verifyRows(upWave, "UP");
    const upPostClose = await getPoolState();
    expectEqual(
      upPostClose.usdc6 - upPreClose.usdc6,
      -upResult.sumPayout,
      "UP wave makeit usdc delta"
    );
    expectEqual(
      upPostClose.weth18 - upPreClose.weth18,
      upResult.sumBought - upResult.sumSold,
      "UP wave makeit weth delta"
    );

    console.log("[e2e] wave DOWN: opening trades");
    for (const c of downWave) await openCase(c);
    const poolUsdc = await usdc.balanceOf(env.MAKEIT_ADDRESS);
    const reserved = await makeitRead.reservedMarginUSDC();
    const protocol = await makeitRead.protocolFeeAccruedUSDC();
    const freeUsdc = poolUsdc > (reserved + protocol) ? poolUsdc - reserved - protocol : 0n;
    if (freeUsdc > 1_000_000n) {
      await (await makeitOwner.rebalanceUsdcToEth(freeUsdc - 1_000_000n)).wait();
    }
    const downTarget = downWave.reduce((acc, c) => {
      const o = openedByCase.get(c.key);
      const boundary = c.outcome === "TP" ? o.expected.tp : o.expected.sl;
      return acc === 0n || boundary < acc ? boundary : acc;
    }, 0n) - 10n ** 12n;
    const downPreClose = await getPoolState();
    console.log(
      `[e2e] wave DOWN makeit pre-close: usdc=${fmtUsdc6(downPreClose.usdc6)} free=${fmtUsdc6(downPreClose.free6)} ` +
      `reserved=${fmtUsdc6(downPreClose.reserved6)} protocol=${fmtUsdc6(downPreClose.protocol6)} weth=${fmtWeth18(downPreClose.weth18)}`
    );
    console.log(`[e2e] wave DOWN target price=${fmtPriceE18(downTarget)}`);
    await movePriceDownTo(downTarget);
    await waitClosed(downWave, "DOWN");
    await waitClosed(matrixCases, "ALL");
    await waitFor(
      "ws trade_closed delivered for matrix wallets",
      async () => matrixCases.every((c) => {
        const w = wallets[c.walletIdx - 1].address.toLowerCase();
        const collector = wsByWallet.get(w);
        return (collector?.events?.trade_closed || 0) >= 1;
      }),
      20000,
      300
    );
    await waitFor(
      "db rows closed for matrix",
      async () => {
        for (const c of matrixCases) {
          const o = openedByCase.get(c.key);
          const row = await pg.query(
            `SELECT status, pnl, "exitPrice", "closeReason", "settlementAction"
             FROM "Trade" t
             JOIN "User" u ON u.id = t."userId"
             WHERE u."walletAddress" = $1 AND t."onChainTradeId" = $2`,
            [o.wallet, o.tradeId]
          );
          if (row.rows.length !== 1) return false;
          if (String(row.rows[0].status || "").toUpperCase() !== "LIQUIDATED") return false;
          if (row.rows[0].pnl == null || row.rows[0].exitPrice == null || !row.rows[0].closeReason) return false;
        }
        return true;
      },
      25000,
      400
    );
    const downResult = await verifyRows(downWave, "DOWN");
    const downPostClose = await getPoolState();
    expectEqual(
      downPostClose.weth18 - downPreClose.weth18,
      downResult.sumBought - downResult.sumSold,
      "DOWN wave makeit weth delta"
    );
    expectTrue(
      downPostClose.usdc6 >= (downPostClose.reserved6 + downPostClose.protocol6),
      "makeit usdc solvency invariant"
    );
    console.log(
      `[e2e] wave UP makeit post-close: usdc=${fmtUsdc6(upPostClose.usdc6)} free=${fmtUsdc6(upPostClose.free6)} ` +
      `reserved=${fmtUsdc6(upPostClose.reserved6)} protocol=${fmtUsdc6(upPostClose.protocol6)} weth=${fmtWeth18(upPostClose.weth18)}`
    );
    console.log(
      `[e2e] wave DOWN makeit post-close: usdc=${fmtUsdc6(downPostClose.usdc6)} free=${fmtUsdc6(downPostClose.free6)} ` +
      `reserved=${fmtUsdc6(downPostClose.reserved6)} protocol=${fmtUsdc6(downPostClose.protocol6)} weth=${fmtWeth18(downPostClose.weth18)}`
    );
    console.log(
      `[e2e] makeit final: usdc=${fmtUsdc6(downPostClose.usdc6)} free=${fmtUsdc6(downPostClose.free6)} reserved=${fmtUsdc6(downPostClose.reserved6)} ` +
      `protocol=${fmtUsdc6(downPostClose.protocol6)} weth=${fmtWeth18(downPostClose.weth18)}`
    );
    return `8 strict matrix trades validated; owner=${ownerAddr}`;
  });

  await runTest("referral volumes positive after trades", results, async () => {
    const refs1 = await fetchJson(`${upstreamBase}/api/users/${wallets[0].address.toLowerCase()}/referrals`);
    const combined = decimalToBigInt(refs1?.totals?.combinedVolume || "0");
    const expectedCombined = 3_900_000_000n;
    expectEqual(combined, expectedCombined, "wallet1 combined referral volume");
    return `wallet1 combinedVolumeRaw=${combined.toString()}`;
  });

  for (const collector of wsByWallet.values()) {
    try { collector?.socket?.close(); } catch {}
  }
  if (pg) {
    try { await pg.end(); } catch {}
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log("\n[e2e] Test Results:");
  for (const row of results) {
    const mark = row.ok
      ? `${COLORS.green}PASS${COLORS.reset}`
      : `${COLORS.red}FAIL${COLORS.reset}`;
    console.log(`- ${mark}: ${row.name}${row.detail ? ` (${row.detail})` : ""}`);
  }
  const summaryColor = failed === 0 ? COLORS.green : COLORS.red;
  console.log(`${summaryColor}[e2e] Summary: ${passed}/${results.length} passed, ${failed} failed${COLORS.reset}`);
  console.log("\n[e2e] Final Checklist:");
  console.log("| Check | Status |");
  console.log("| --- | --- |");
  console.log(`| Stack healthy | ${statusCell(checklist.stack)} |`);
  console.log(`| Faucet funding | ${statusCell(checklist.faucet)} |`);
  console.log(`| Referral linking/tiers | ${statusCell(checklist.referrals)} |`);
  console.log(`| WS connectivity | ${statusCell(checklist.ws)} |`);
  console.log(`| Strict trade matrix | ${statusCell(checklist.matrix)} |`);
  console.log(`| Referral volume updates | ${statusCell(checklist.referral_volume)} |`);

  if (managedStack) {
    console.log("[e2e] stopping managed local stack ...");
    await stopManagedStack(managedStack);
  }

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`[e2e] fatal: ${String(e?.message || e)}`);
  process.exit(1);
});
