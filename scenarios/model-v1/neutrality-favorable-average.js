"use strict";

const { LongOnlyKnockoutDexModelV1, STATUS, toE18, USDC_SCALE } = require("./dex-model");
const { buildRegimePath, createRng } = require("../common/price-simulator");
const { writeScenarioResult } = require("../common/result-writer");

const E18 = 10n ** 18n;
const E12 = 10n ** 12n;
const ADDR = { owner: "owner" };

function randomInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function createTraders(count) {
  return Array.from({ length: count }, (_, i) => `trader_${i + 1}`);
}

function setupDexWithTraders(traders, leverage) {
  const dex = new LongOnlyKnockoutDexModelV1({ owner: ADDR.owner });
  dex.feeBps = 0n;
  dex.leverage = BigInt(leverage);
  dex.mintWETH(ADDR.owner, 100n * E18);
  dex.fundETH(ADDR.owner, 100n * E18);
  for (const trader of traders) dex.mintUSDC(trader, 1_000_000n * USDC_SCALE);
  return dex;
}

function buildOpenSchedule(steps, targetTrades, seed) {
  const rng = createRng(seed);
  const schedule = new Array(steps).fill(0);
  for (let i = 0; i < targetTrades; i++) schedule[randomInt(rng, 0, steps - 1)]++;
  return schedule;
}

function closeSweep(dex, liveTrades, closingTrader, stats) {
  for (const tradeId of Array.from(liveTrades)) {
    const closed = dex.tryClose(closingTrader, tradeId);
    if (!closed.ok) continue;
    liveTrades.delete(tradeId);
    if (closed.result.status === STATUS.CLOSED_TP) {
      stats.tp += 1;
      const px = Number(closed.result.closePriceE18) / 1e18;
      if (px > 3000) stats.tpAbove3000 += 1;
      else if (px < 3000) stats.tpBelow3000 += 1;
      else stats.tpAt3000 += 1;
      stats.longTradePnl += Number(closed.result.payoutProfitUSDC) / 1e6;
      stats.poolTradePnl -= Number(closed.result.payoutProfitUSDC) / 1e6;
    } else if (closed.result.status === STATUS.CLOSED_SL) {
      stats.sl += 1;
      stats.longTradePnl -= Number(dex.marginUSDC) / 1e6;
      stats.poolTradePnl += Number(dex.marginUSDC) / 1e6;
    }
  }
}

function settleRemainingTrades(dex, liveTrades, stats) {
  const snapPrice = toE18(3000);
  while (liveTrades.size > 0) {
    if (liveTrades.size < 100) {
      dex.setMockPriceE18(ADDR.owner, snapPrice);
      closeSweep(dex, liveTrades, ADDR.owner, stats);
      for (const tradeId of Array.from(liveTrades)) {
        dex.cancelOpenTrade(tradeId);
        liveTrades.delete(tradeId);
        stats.canceled += 1;
      }
      break;
    }

    let highTarget = null;
    let lowTarget = null;
    for (const tradeId of liveTrades) {
      const trade = dex.trades.get(tradeId);
      if (!trade || trade.status !== STATUS.OPEN) continue;
      if (highTarget === null || trade.tpPriceE18 > highTarget) highTarget = trade.tpPriceE18;
      if (lowTarget === null || trade.slPriceE18 < lowTarget) lowTarget = trade.slPriceE18;
    }

    if (highTarget === null || lowTarget === null) break;

    const beforeHigh = liveTrades.size;
    dex.setMockPriceE18(ADDR.owner, highTarget);
    closeSweep(dex, liveTrades, ADDR.owner, stats);
    if (liveTrades.size === 0) break;

    const beforeLow = liveTrades.size;
    dex.setMockPriceE18(ADDR.owner, lowTarget);
    closeSweep(dex, liveTrades, ADDR.owner, stats);

    if (liveTrades.size === beforeHigh && liveTrades.size === beforeLow) {
      throw new Error("failed to settle remaining trades");
    }
  }
}

function runOne(seed, leverage) {
  const traders = createTraders(250);
  const dex = setupDexWithTraders(traders, leverage);
  const rng = createRng(`favorable-trades-${seed}`);
  const path = buildRegimePath({ regime: "neutral", startPrice: 3000, steps: 3000, seed: `favorable-price-${seed}` });
  const openSchedule = buildOpenSchedule(path.length, 10_000, `favorable-trades-${seed}-opens`);
  const liveTrades = new Set();
  const stats = {
    tp: 0,
    sl: 0,
    tpAbove3000: 0,
    tpBelow3000: 0,
    tpAt3000: 0,
    canceled: 0,
    longTradePnl: 0,
    poolTradePnl: 0,
  };

  for (let i = 0; i < path.length; i++) {
    const price = path[i];
    dex.setMockPriceE18(ADDR.owner, toE18(price));
    const opens = openSchedule[i];
    for (let j = 0; j < opens; j++) {
      const trader = traders[randomInt(rng, 0, traders.length - 1)];
      const opened = dex.tryOpenTrade(trader, toE18(price), 0, 100);
      if (!opened.ok) continue;
      liveTrades.add(opened.tradeId);
    }
    const closer = traders[randomInt(rng, 0, traders.length - 1)];
    closeSweep(dex, liveTrades, closer, stats);
  }

  settleRemainingTrades(dex, liveTrades, stats);

  const endPrice = dex.getOraclePriceE18();
  const endUSDC = dex.balanceUSDC(dex.dexAddress);
  const endWETH = dex.balanceWETH(dex.dexAddress);
  const endEquity = endUSDC + ((endWETH * endPrice) / E18) / E12;
  const holdOnlyEnd = ((100n * E18 * endPrice) / E18) / E12;

  return {
    openedLongs: stats.tp + stats.sl + stats.canceled,
    closeSuccess: stats.tp + stats.sl,
    endPrice,
    endUSDC,
    endWETH,
    endEquity,
    holdOnlyEnd,
    poolVsHold: endEquity - holdOnlyEnd,
    ...stats,
  };
}

function averageRuns(runs, leverage) {
  const sums = {
    openedLongs: 0,
    closeSuccess: 0,
    tp: 0,
    sl: 0,
    tpAbove3000: 0,
    tpBelow3000: 0,
    tpAt3000: 0,
    canceled: 0,
    endPrice: 0,
    endUSDC: 0,
    endWETH: 0,
    endEquity: 0,
    holdOnlyEnd: 0,
    poolVsHold: 0,
    longTradePnl: 0,
    poolTradePnl: 0,
  };

  for (let i = 0; i < runs; i++) {
    const result = runOne(i, leverage);
    for (const key of Object.keys(sums)) sums[key] += Number(result[key]);
  }

  const averages = {};
  for (const [key, value] of Object.entries(sums)) averages[key] = value / runs;
  return averages;
}

const leverage = 300;
const runs = 100;
const averages = averageRuns(runs, leverage);

const resultPath = writeScenarioResult({
  scenarioName: "model-v1-neutrality-favorable-300x-average-100",
  payload: {
    model: "v1",
    scenarioType: "neutrality_favorable_average100",
    regime: "neutral",
    leverage,
    feeBps: 0,
    targetProfitUSDC: 10,
    targetTrades: 10000,
    constrainedEnding: {
      snapPrice: 3000,
      snapThresholdOpenTrades: 100,
      cancelRemainingOpenTrades: true,
    },
    averages,
  },
});

console.log(`Result file: ${resultPath}`);
