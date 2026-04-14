"use strict";

const { LongOnlyKnockoutDexModelV2, STATUS, toE18, fmtUSDC6, fmtWETH18, fmtPriceE18, USDC_SCALE, E18 } = require("./dex-model");
const { buildRegimePath, createRng } = require("../common/price-simulator");
const { writeScenarioResult } = require("../common/result-writer");
const { summarizeBottomLine } = require("../common/bottomline");
const E12 = 10n ** 12n;

const ADDR = {
  owner: "owner",
  alice: "alice",
  bob: "bob",
  charlie: "charlie",
};

function fmtPctFromBps(bps) {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

function randomInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

function calculateRebalanceToStartEth(startWETH, endWETH, endUSDC, endPrice) {
  const targetWETH = startWETH;
  const valueDenominator = E18 * E12;

  if (endWETH >= targetWETH) {
    const postValue = endUSDC + ((endWETH * endPrice) / E18) / E12;
    return {
      rebalanceTargetWETH: targetWETH,
      rebalanceNeededWETH: 0n,
      rebalanceBoughtWETH: 0n,
      rebalanceUSDCSpent: 0n,
      rebalancePostWETH: endWETH,
      rebalancePostUSDC: endUSDC,
      rebalanceRemainingMissingWETH: 0n,
      rebalanceFullyReachedTarget: true,
      rebalancePostValueUSD: postValue,
    };
  }

  const missingWETH = targetWETH - endWETH;
  const usdcNeeded = ceilDiv(missingWETH * endPrice, valueDenominator);

  if (endUSDC >= usdcNeeded) {
    const postWETH = targetWETH;
    const postUSDC = endUSDC - usdcNeeded;
    const postValue = postUSDC + ((postWETH * endPrice) / E18) / E12;
    return {
      rebalanceTargetWETH: targetWETH,
      rebalanceNeededWETH: missingWETH,
      rebalanceBoughtWETH: missingWETH,
      rebalanceUSDCSpent: usdcNeeded,
      rebalancePostWETH: postWETH,
      rebalancePostUSDC: postUSDC,
      rebalanceRemainingMissingWETH: 0n,
      rebalanceFullyReachedTarget: true,
      rebalancePostValueUSD: postValue,
    };
  }

  const usdcSpent = endUSDC;
  const boughtWETH = (usdcSpent * E12 * E18) / endPrice;
  const postWETH = endWETH + boughtWETH;
  const postUSDC = 0n;
  const remainingMissing = targetWETH > postWETH ? targetWETH - postWETH : 0n;
  const postValue = ((postWETH * endPrice) / E18) / E12;

  return {
    rebalanceTargetWETH: targetWETH,
    rebalanceNeededWETH: missingWETH,
    rebalanceBoughtWETH: boughtWETH,
    rebalanceUSDCSpent: usdcSpent,
    rebalancePostWETH: postWETH,
    rebalancePostUSDC: postUSDC,
    rebalanceRemainingMissingWETH: remainingMissing,
    rebalanceFullyReachedTarget: remainingMissing === 0n,
    rebalancePostValueUSD: postValue,
  };
}

function setupDexSimple() {
  const dex = new LongOnlyKnockoutDexModelV2({ owner: ADDR.owner });

  dex.mintWETH(ADDR.owner, 100n * E18);
  dex.fundETH(ADDR.owner, 100n * E18);

  dex.mintUSDC(ADDR.alice, 50_000n * USDC_SCALE);
  dex.mintUSDC(ADDR.bob, 50_000n * USDC_SCALE);
  dex.mintUSDC(ADDR.charlie, 50_000n * USDC_SCALE);
  return dex;
}

function setupDexWithTraders(traders) {
  const dex = new LongOnlyKnockoutDexModelV2({ owner: ADDR.owner });

  dex.mintWETH(ADDR.owner, 100n * E18);
  dex.fundETH(ADDR.owner, 100n * E18);

  for (const t of traders) dex.mintUSDC(t, 1_000_000n * USDC_SCALE);
  return dex;
}

function createTraders(count) {
  const traders = new Array(count);
  for (let i = 0; i < count; i++) traders[i] = `trader_${i + 1}`;
  return traders;
}

function logPoolState(dex, label) {
  const s = dex.poolStats();
  console.log("--------------------------------------------------");
  console.log(label);
  console.log(`price:               ${fmtPriceE18(s.oraclePriceE18)} USDC/ETH`);
  console.log(`poolUSDC:            ${fmtUSDC6(s.poolUSDC)} USDC`);
  console.log(`poolWETH:            ${fmtWETH18(s.poolWETH)} WETH`);
  console.log(`poolWETHValue:       ${fmtUSDC6(s.ethValueUSDC)} USDC`);
  console.log(`poolEquity:          ${fmtUSDC6(s.equityUSDC)} USDC`);
  console.log(`openMargin:          ${fmtUSDC6(s.openMarginUSDC)} USDC`);
  console.log(`openNotional:        ${fmtUSDC6(s.openNotionalUSDC)} USDC`);
  console.log(`trades open/tp/sl:   ${s.open}/${s.tp}/${s.sl}`);
}

function printFinalSummary(title, summary) {
  console.log("==================================================");
  console.log(`Final Results (${title})`);
  console.log(`numberLongsOpened:                 ${summary.openedLongs}`);
  console.log(`numberShortsOpened:                0`);
  console.log(`longsRealizedPnL:                  ${fmtUSDC6(summary.longTradePnl)} USDC`);
  console.log(`shortsRealizedPnL:                 0.000000 USDC`);
  console.log(`poolRealizedTradePnL:              ${fmtUSDC6(summary.poolTradePnl)} USDC`);
  console.log(`feesCollected:                     0.000000 USDC`);
  console.log(`rebalancingTxCosts:                0.000000 USDC`);
  console.log(`hedgingCosts:                      0.000000 USDC`);
  console.log(`openFailInsufficientLiquidity:     ${summary.openFailInsufficientLiquidity}`);
  console.log(`openFailOther:                     ${summary.openFailOther}`);
  console.log(`closeAttempts:                     ${summary.closeAttempts}`);
  console.log(`closeSuccess:                      ${summary.closeSuccess}`);
  console.log(`maxPoolUtilization:                ${fmtPctFromBps(summary.maxUtilizationBps)}`);
  console.log("");
  console.log("Assets");
  console.log(`startUSDC:                         ${fmtUSDC6(summary.startUSDC)} USDC`);
  console.log(`endUSDC:                           ${fmtUSDC6(summary.endUSDC)} USDC`);
  console.log(`deltaUSDC:                         ${fmtUSDC6(summary.endUSDC - summary.startUSDC)} USDC`);
  console.log(`startWETH:                         ${fmtWETH18(summary.startWETH)} WETH`);
  console.log(`endWETH:                           ${fmtWETH18(summary.endWETH)} WETH`);
  console.log(`deltaWETH:                         ${fmtWETH18(summary.endWETH - summary.startWETH)} WETH`);
  console.log("");
  console.log("USD Value");
  console.log(`startPrice:                        ${fmtPriceE18(summary.startPrice)} USDC/ETH`);
  console.log(`endPrice:                          ${fmtPriceE18(summary.endPrice)} USDC/ETH`);
  console.log(`startPoolValueUSD:                 ${fmtUSDC6(summary.startEquity)} USDC`);
  console.log(`endPoolValueUSD:                   ${fmtUSDC6(summary.endEquity)} USDC`);
  console.log(`poolTotalPnL:                      ${fmtUSDC6(summary.endEquity - summary.startEquity)} USDC`);
  console.log(`holdOnlyEndValueUSD:               ${fmtUSDC6(summary.holdOnlyEnd)} USDC`);
  console.log(`poolVsHold:                        ${fmtUSDC6(summary.endEquity - summary.holdOnlyEnd)} USDC`);
  console.log("");
  console.log("End Rebalance To Start ETH");
  console.log(`rebalanceTargetWETH:               ${fmtWETH18(summary.rebalanceTargetWETH)} WETH`);
  console.log(`rebalanceNeededWETH:               ${fmtWETH18(summary.rebalanceNeededWETH)} WETH`);
  console.log(`rebalanceUSDCSpent:                ${fmtUSDC6(summary.rebalanceUSDCSpent)} USDC`);
  console.log(`rebalanceBoughtWETH:               ${fmtWETH18(summary.rebalanceBoughtWETH)} WETH`);
  console.log(`rebalancePostWETH:                 ${fmtWETH18(summary.rebalancePostWETH)} WETH`);
  console.log(`rebalancePostUSDC:                 ${fmtUSDC6(summary.rebalancePostUSDC)} USDC`);
  console.log(`rebalanceRemainingMissingWETH:     ${fmtWETH18(summary.rebalanceRemainingMissingWETH)} WETH`);
  console.log(`rebalanceFullyReachedTarget:       ${summary.rebalanceFullyReachedTarget}`);
  console.log(`rebalancePostPoolValueUSD:         ${fmtUSDC6(summary.rebalancePostValueUSD)} USDC`);
  const bottomLine = summarizeBottomLine(summary);
  console.log("");
  console.log("Bottomline");
  console.log(`endWETH / deltaWETH:               ${fmtWETH18(bottomLine.endWETH)} / ${fmtWETH18(bottomLine.deltaWETH)} WETH`);
  console.log(`endUSDC / deltaUSDC:               ${fmtUSDC6(bottomLine.endUSDC)} / ${fmtUSDC6(bottomLine.deltaUSDC)} USDC`);
  console.log(`valueUSDPlusETHVsHold:             ${fmtUSDC6(bottomLine.poolVsHoldUSDC)} USDC`);
  console.log(
    `rebalanceTrade:                    ${bottomLine.rebalanceAction} ${fmtWETH18(bottomLine.rebalanceBoughtWETH)} bought, ${fmtWETH18(
      bottomLine.rebalanceSoldWETH
    )} sold for ${fmtUSDC6(bottomLine.rebalanceUSDCSpent)} spent, ${fmtUSDC6(bottomLine.rebalanceUSDCReceived)} received USDC`
  );
  console.log(
    `postRebalanceWETH / deltaWETH:     ${fmtWETH18(bottomLine.postRebalanceWETH)} / ${fmtWETH18(bottomLine.postRebalanceDeltaWETH)} WETH`
  );
  console.log(
    `postRebalanceUSDC / deltaUSDC:     ${fmtUSDC6(bottomLine.postRebalanceUSDC)} / ${fmtUSDC6(bottomLine.postRebalanceDeltaUSDC)} USDC`
  );
  console.log(`postRebalanceValueVsHold:          ${fmtUSDC6(bottomLine.postRebalanceVsHoldUSDC)} USDC`);
  console.log("==================================================");
}

function calculateFinalSummary(dex, counters, startUSDC, startWETH, startPrice, startEquity) {
  const endPrice = dex.getOraclePriceE18();
  const endUSDC = dex.balanceUSDC(dex.dexAddress);
  const endWETH = dex.balanceWETH(dex.dexAddress);
  const endWETHValue = ((endWETH * endPrice) / E18) / (10n ** 12n);
  const endEquity = endUSDC + endWETHValue;
  const holdOnlyEnd = dex.holdOnlyEquityUSDC6(startUSDC, startWETH, endPrice);
  const rebalance = calculateRebalanceToStartEth(startWETH, endWETH, endUSDC, endPrice);

  return {
    ...counters,
    startUSDC,
    endUSDC,
    startWETH,
    endWETH,
    startPrice,
    endPrice,
    startEquity,
    endEquity,
    holdOnlyEnd,
    ...rebalance,
  };
}

function closeSweep(dex, liveTrades, closingTrader, counters) {
  for (const tradeId of Array.from(liveTrades)) {
    counters.closeAttempts++;
    const closed = dex.tryClose(closingTrader, tradeId);
    if (!closed.ok) continue;

    counters.closeSuccess++;
    liveTrades.delete(tradeId);

    if (closed.result.status === STATUS.CLOSED_TP) {
      counters.longTradePnl += closed.result.payoutProfitUSDC;
      counters.poolTradePnl -= closed.result.payoutProfitUSDC;
    } else if (closed.result.status === STATUS.CLOSED_SL) {
      counters.longTradePnl -= dex.marginUSDC;
      counters.poolTradePnl += dex.marginUSDC;
    }
  }
}

function updateUtilization(dex, counters) {
  const snap = dex.poolStats();
  if (snap.ethValueUSDC > 0n) {
    const util = (snap.openNotionalUSDC * 10_000n) / snap.ethValueUSDC;
    if (util > counters.maxUtilizationBps) counters.maxUtilizationBps = util;
  }
}

function settleRemainingTrades(dex, liveTrades, counters) {
  while (liveTrades.size > 0) {
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
    closeSweep(dex, liveTrades, ADDR.owner, counters);
    updateUtilization(dex, counters);
    if (liveTrades.size === 0) break;

    const beforeLow = liveTrades.size;
    dex.setMockPriceE18(ADDR.owner, lowTarget);
    closeSweep(dex, liveTrades, ADDR.owner, counters);
    updateUtilization(dex, counters);

    if (liveTrades.size === beforeHigh && liveTrades.size === beforeLow) {
      throw new Error("failed to settle remaining trades");
    }
  }
}

function runVerbose10TradesModelV2() {
  const dex = setupDexSimple();
  const traders = [ADDR.alice, ADDR.bob, ADDR.charlie];

  const startUSDC = dex.balanceUSDC(dex.dexAddress);
  const startWETH = dex.balanceWETH(dex.dexAddress);
  const startPrice = dex.getOraclePriceE18();
  const startEquity = dex.holdOnlyEquityUSDC6(startUSDC, startWETH, startPrice);

  const entryPrices = [3000, 3015, 2990, 3030, 2970, 3045, 2960, 3060, 2950, 3075];
  const movePrices = [3018, 2980, 3005, 2960, 3055, 2940, 3070, 2930, 3090, 2920];
  const ptBps = [40, 55, 50, 65, 45, 60, 50, 70, 55, 65];

  const counters = {
    openedLongs: 0,
    openFailInsufficientLiquidity: 0,
    openFailOther: 0,
    closeAttempts: 0,
    closeSuccess: 0,
    longTradePnl: 0n,
    poolTradePnl: 0n,
    maxUtilizationBps: 0n,
  };

  const liveTrades = new Set();

  console.log("==================================================");
  console.log("Scenario: Verbose 10 Trades (Model V2)");
  logPoolState(dex, "S0 initial");

  for (let i = 0; i < entryPrices.length; i++) {
    const trader = traders[i % traders.length];
    const entry = entryPrices[i];
    const move = movePrices[i];
    const target = ptBps[i];

    dex.setMockPriceE18(ADDR.owner, toE18(entry));
    logPoolState(dex, `Step ${i + 1}.1 price set to ${entry}`);

    const opened = dex.tryOpenTrade(trader, toE18(entry), 0, target);
    if (opened.ok) {
      counters.openedLongs++;
      liveTrades.add(opened.tradeId);
      const t = dex.trades.get(opened.tradeId);
      console.log(
        `OPEN  tradeId=${opened.tradeId} trader=${trader} entry=${entry} ptBps=${target} tp=${fmtPriceE18(
          t.tpPriceE18
        )} sl=${fmtPriceE18(t.slPriceE18)}`
      );
    } else {
      if (opened.error === "insufficient ETH coverage") counters.openFailInsufficientLiquidity++;
      else counters.openFailOther++;
      console.log(`OPEN  failed trader=${trader} reason=${opened.error}`);
    }
    logPoolState(dex, `Step ${i + 1}.2 after open`);

    dex.setMockPriceE18(ADDR.owner, toE18(move));
    logPoolState(dex, `Step ${i + 1}.3 price moved to ${move}`);

    closeSweep(dex, liveTrades, traders[(i + 1) % traders.length], counters);
    logPoolState(dex, `Step ${i + 1}.4 after liquidation sweep`);
    updateUtilization(dex, counters);
  }

  dex.setMockPriceE18(ADDR.owner, toE18(10_000));
  closeSweep(dex, liveTrades, ADDR.owner, counters);

  const summary = calculateFinalSummary(dex, counters, startUSDC, startWETH, startPrice, startEquity);
  const bottomLine = summarizeBottomLine(summary);
  printFinalSummary("Model V2", summary);
  const resultPath = writeScenarioResult({
    scenarioName: "model-v2-verbose-10-trades",
    payload: {
      model: "v2",
      scenarioType: "verbose10",
      summary,
      bottomLine,
    },
  });
  console.log(`Result file: ${resultPath}`);
  return { summary, bottomLine, resultPath };
}

function buildOpenSchedule(steps, targetTrades, seed) {
  const rng = createRng(seed);
  const schedule = new Array(steps).fill(0);
  for (let i = 0; i < targetTrades; i++) {
    const idx = randomInt(rng, 0, steps - 1);
    schedule[idx]++;
  }
  return schedule;
}

function simulateRandom10000TrendModelV2({
  regime,
  priceSeed,
  tradeSeed,
  targetTrades = 10_000,
  pathSteps = 3000,
  traderCount = 250,
  settlementSteps = 800,
  ptBpsMin = 100,
  ptBpsMax = 100,
}) {
  const traders = createTraders(traderCount);
  const dex = setupDexWithTraders(traders);
  const rng = createRng(tradeSeed);

  const path = buildRegimePath({
    regime,
    startPrice: 3000,
    steps: pathSteps,
    seed: priceSeed,
  });

  const openSchedule = buildOpenSchedule(path.length, targetTrades, `${tradeSeed}-opens`);

  const startUSDC = dex.balanceUSDC(dex.dexAddress);
  const startWETH = dex.balanceWETH(dex.dexAddress);
  const startPrice = dex.getOraclePriceE18();
  const startEquity = dex.holdOnlyEquityUSDC6(startUSDC, startWETH, startPrice);

  const counters = {
    openedLongs: 0,
    openFailInsufficientLiquidity: 0,
    openFailOther: 0,
    closeAttempts: 0,
    closeSuccess: 0,
    longTradePnl: 0n,
    poolTradePnl: 0n,
    maxUtilizationBps: 0n,
  };

  const liveTrades = new Set();

  for (let i = 0; i < path.length; i++) {
    const price = path[i];
    dex.setMockPriceE18(ADDR.owner, toE18(price));

    const opens = openSchedule[i];
    for (let j = 0; j < opens; j++) {
      const trader = traders[randomInt(rng, 0, traders.length - 1)];
      const ptBps = randomInt(rng, ptBpsMin, ptBpsMax);
      const opened = dex.tryOpenTrade(trader, toE18(price), 0, ptBps);
      if (!opened.ok) {
        if (opened.error === "insufficient ETH coverage") counters.openFailInsufficientLiquidity++;
        else counters.openFailOther++;
        continue;
      }
      counters.openedLongs++;
      liveTrades.add(opened.tradeId);
    }

    const closer = traders[randomInt(rng, 0, traders.length - 1)];
    closeSweep(dex, liveTrades, closer, counters);
    updateUtilization(dex, counters);
  }

  settleRemainingTrades(dex, liveTrades, counters);

  const summary = calculateFinalSummary(dex, counters, startUSDC, startWETH, startPrice, startEquity);
  return { summary, pathLength: path.length, targetTrades };
}

function runRandom10000TrendModelV2({ regime, title, priceSeed, tradeSeed }) {
  const { summary, pathLength, targetTrades } = simulateRandom10000TrendModelV2({
    regime,
    priceSeed,
    tradeSeed,
  });
  const bottomLine = summarizeBottomLine(summary);

  console.log("==================================================");
  console.log(`Scenario: ${title}`);
  console.log(`Regime:   ${regime}`);
  console.log(`Model:    V2`);
  console.log(`PathPts:  ${pathLength}`);
  console.log(`Trades:   ${targetTrades}`);
  printFinalSummary("Model V2", summary);
  const resultPath = writeScenarioResult({
    scenarioName: `model-v2-random-10000-${regime}`,
    payload: {
      model: "v2",
      scenarioType: "random10000",
      regime,
      title,
      pathLength,
      targetTrades,
      summary,
      bottomLine,
    },
  });
  console.log(`Result file: ${resultPath}`);
  return { summary, bottomLine, pathLength, targetTrades, resultPath };
}

module.exports = {
  runVerbose10TradesModelV2,
  runRandom10000TrendModelV2,
  simulateRandom10000TrendModelV2,
};
