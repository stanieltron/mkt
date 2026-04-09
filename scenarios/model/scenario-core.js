"use strict";

const { LongShortOffsetDexModelV4, SIDE, STATUS, toE18, fmtUSDC6, fmtWETH18, fmtPriceE18, USDC_SCALE, E18 } = require("./dex-model");
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

function moveBpsToProfitTargetPpm(moveBps, leverage = 300n) {
  return BigInt(moveBps) * 100n * BigInt(leverage);
}

function defaultProfitTargetPpm(dex) {
  const gross = dex.marginUSDC;
  const fee = dex._feeAmountUSDC();
  const net = dex._effectiveMarginUSDC();
  return ((gross + fee) * 1_000_000n) / net;
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
  const dex = new LongShortOffsetDexModelV4({ owner: ADDR.owner });
  dex.setFeeSplitPpm(ADDR.owner, 0n, 0n);

  dex.mintWETH(ADDR.owner, 100n * E18);
  dex.fundETH(ADDR.owner, 100n * E18);

  dex.mintUSDC(ADDR.alice, 50_000n * USDC_SCALE);
  dex.mintUSDC(ADDR.bob, 50_000n * USDC_SCALE);
  dex.mintUSDC(ADDR.charlie, 50_000n * USDC_SCALE);
  return dex;
}

function setupDexWithTraders(traders) {
  const dex = new LongShortOffsetDexModelV4({ owner: ADDR.owner });
  dex.setFeeSplitPpm(ADDR.owner, 0n, 0n);

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
  console.log(`openNotionalNet:     ${fmtUSDC6(s.openNotionalUSDC)} USDC`);
  console.log(`openNotionalLong:    ${fmtUSDC6(s.openLongNotionalUSDC)} USDC`);
  console.log(`openNotionalShort:   ${fmtUSDC6(s.openShortNotionalUSDC)} USDC`);
  console.log(`trades open/tp/sl:   ${s.open}/${s.tp}/${s.sl}`);
  console.log(`open longs/shorts:   ${s.openLong}/${s.openShort}`);
}

function printFinalSummary(title, summary) {
  console.log("==================================================");
  console.log(`Final Results (${title})`);
  console.log(`numberLongsOpened:                 ${summary.openedLongs}`);
  console.log(`numberShortsOpened:                ${summary.openedShorts}`);
  console.log(`longsRealizedPnL:                  ${fmtUSDC6(summary.longTradePnl)} USDC`);
  console.log(`shortsRealizedPnL:                 ${fmtUSDC6(summary.shortTradePnl)} USDC`);
  console.log(`poolRealizedTradePnL:              ${fmtUSDC6(summary.poolTradePnl)} USDC`);
  console.log(`feesCollected:                     0.000000 USDC`);
  console.log(`rebalancingTxCosts:                0.000000 USDC`);
  console.log(`hedgingCosts:                      0.000000 USDC`);
  console.log(`openFailInsufficientLiquidity:     ${summary.openFailInsufficientLiquidity}`);
  console.log(`openFailNoShortOffset:             ${summary.openFailNoOffset}`);
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

    const side = closed.result.side;
    const tradePnl = closed.result.tradePnlUSDC ?? 0n;
    counters.poolTradePnl -= tradePnl;
    if (side === SIDE.LONG) counters.longTradePnl += tradePnl;
    else counters.shortTradePnl += tradePnl;
  }
}

function updateUtilization(dex, counters) {
  const snap = dex.poolStats();
  if (snap.ethValueUSDC > 0n) {
    const util = (snap.openNotionalUSDC * 10_000n) / snap.ethValueUSDC;
    if (util > counters.maxUtilizationBps) counters.maxUtilizationBps = util;
  }
}

function settlementTargetsForTrade(trade) {
  if (trade.side === SIDE.SHORT) return { high: trade.slPriceE18, low: trade.tpPriceE18 };
  return { high: trade.tpPriceE18, low: trade.slPriceE18 };
}

function settleRemainingTrades(dex, liveTrades, counters) {
  while (liveTrades.size > 0) {
    let highTarget = null;
    let lowTarget = null;

    for (const tradeId of liveTrades) {
      const trade = dex.trades.get(tradeId);
      if (!trade || trade.status !== STATUS.OPEN) continue;
      const targets = settlementTargetsForTrade(trade);

      if (highTarget === null || targets.high > highTarget) highTarget = targets.high;
      if (lowTarget === null || targets.low < lowTarget) lowTarget = targets.low;
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
      dex.setMockPriceE18(ADDR.owner, 1_000_000_000n * E18);
      closeSweep(dex, liveTrades, ADDR.owner, counters);
      updateUtilization(dex, counters);
      if (liveTrades.size === 0) break;

      dex.setMockPriceE18(ADDR.owner, 1n);
      closeSweep(dex, liveTrades, ADDR.owner, counters);
      updateUtilization(dex, counters);

      if (liveTrades.size === beforeLow) {
        throw new Error("failed to settle remaining trades");
      }
    }
  }
}

function tryOpenLong(dex, trader, price, profitTargetPpm) {
  return dex.tryOpenTrade(trader, toE18(price), 0, profitTargetPpm);
}

function tryOpenShort(dex, trader, price, profitTargetPpm) {
  return dex.tryOpenShortTrade(trader, toE18(price), 0, profitTargetPpm);
}

function recordOpenFailure(counters, error) {
  if (error === "insufficient ETH coverage") counters.openFailInsufficientLiquidity++;
  else if (error === "no long notional to offset short") counters.openFailNoOffset++;
  else counters.openFailOther++;
}

function applyOpenResult(dex, opened, liveTrades, counters) {
  if (!opened.ok) {
    recordOpenFailure(counters, opened.error);
    return false;
  }
  liveTrades.add(opened.tradeId);
  const t = dex.trades.get(opened.tradeId);
  if (t.side === SIDE.LONG) counters.openedLongs++;
  else counters.openedShorts++;
  return true;
}

function runVerbose10TradesModelV4() {
  const dex = setupDexSimple();
  const traders = [ADDR.alice, ADDR.bob, ADDR.charlie];

  const startUSDC = dex.balanceUSDC(dex.dexAddress);
  const startWETH = dex.balanceWETH(dex.dexAddress);
  const startPrice = dex.getOraclePriceE18();
  const startEquity = dex.holdOnlyEquityUSDC6(startUSDC, startWETH, startPrice);

  const entryPrices = [3000, 3015, 2990, 3030, 2970, 3045, 2960, 3060, 2950, 3075];
  const movePrices = [3018, 2980, 3005, 2960, 3055, 2940, 3070, 2930, 3090, 2920];
  const tpMoveBps = [40, 55, 50, 65, 45, 60, 50, 70, 55, 65];
  const defaultTpPpm = defaultProfitTargetPpm(dex);

  const counters = {
    openedLongs: 0,
    openedShorts: 0,
    openFailInsufficientLiquidity: 0,
    openFailNoOffset: 0,
    openFailOther: 0,
    closeAttempts: 0,
    closeSuccess: 0,
    longTradePnl: 0n,
    shortTradePnl: 0n,
    poolTradePnl: 0n,
    maxUtilizationBps: 0n,
  };

  const liveTrades = new Set();

  console.log("==================================================");
  console.log("Scenario: Verbose 10 Trades (Model V4)");
  logPoolState(dex, "S0 initial");

  for (let i = 0; i < entryPrices.length; i++) {
    const longTrader = traders[i % traders.length];
    const shortTrader = traders[(i + 1) % traders.length];
    const entry = entryPrices[i];
    const move = movePrices[i];
    const targetMoveBps = tpMoveBps[i];
    const targetProfitPpm = defaultTpPpm;

    dex.setMockPriceE18(ADDR.owner, toE18(entry));
    logPoolState(dex, `Step ${i + 1}.1 price set to ${entry}`);

    const openedLong = tryOpenLong(dex, longTrader, entry, targetProfitPpm);
    if (applyOpenResult(dex, openedLong, liveTrades, counters)) {
      const t = dex.trades.get(openedLong.tradeId);
      console.log(
        `OPEN  side=LONG tradeId=${openedLong.tradeId} trader=${longTrader} entry=${entry} targetPresetBps=${targetMoveBps} tpPpm=${targetProfitPpm} tp=${fmtPriceE18(
          t.tpPriceE18
        )} sl=${fmtPriceE18(t.slPriceE18)}`
      );
    } else {
      console.log(`OPEN  side=LONG failed trader=${longTrader} reason=${openedLong.error}`);
    }

    const openedShort = tryOpenShort(dex, shortTrader, entry, targetProfitPpm);
    if (applyOpenResult(dex, openedShort, liveTrades, counters)) {
      const t = dex.trades.get(openedShort.tradeId);
      console.log(
        `OPEN  side=SHORT tradeId=${openedShort.tradeId} trader=${shortTrader} entry=${entry} targetPresetBps=${targetMoveBps} tpPpm=${targetProfitPpm} tp=${fmtPriceE18(
          t.tpPriceE18
        )} sl=${fmtPriceE18(t.slPriceE18)}`
      );
    } else {
      console.log(`OPEN  side=SHORT failed trader=${shortTrader} reason=${openedShort.error}`);
    }

    logPoolState(dex, `Step ${i + 1}.2 after opens`);

    dex.setMockPriceE18(ADDR.owner, toE18(move));
    logPoolState(dex, `Step ${i + 1}.3 price moved to ${move}`);

    closeSweep(dex, liveTrades, traders[(i + 2) % traders.length], counters);
    logPoolState(dex, `Step ${i + 1}.4 after liquidation sweep`);
    updateUtilization(dex, counters);
  }

  dex.setMockPriceE18(ADDR.owner, toE18(10_000));
  closeSweep(dex, liveTrades, ADDR.owner, counters);

  const summary = calculateFinalSummary(dex, counters, startUSDC, startWETH, startPrice, startEquity);
  const bottomLine = summarizeBottomLine(summary);
  printFinalSummary("Model V4", summary);
  const resultPath = writeScenarioResult({
    scenarioName: "model-v4-verbose-10-trades",
    payload: {
      model: "v4",
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

function tryOpenRandomSideWithFallback(dex, trader, price, profitTargetPpm, rng) {
  const preferShort = rng() < 0.5;

  if (preferShort) {
    const shortTry = tryOpenShort(dex, trader, price, profitTargetPpm);
    if (shortTry.ok) return shortTry;
    if (shortTry.error === "no long notional to offset short") {
      return tryOpenLong(dex, trader, price, profitTargetPpm);
    }
    return shortTry;
  }

  const longTry = tryOpenLong(dex, trader, price, profitTargetPpm);
  if (longTry.ok) return longTry;
  if (longTry.error === "insufficient ETH coverage") {
    const shortTry = tryOpenShort(dex, trader, price, profitTargetPpm);
    if (shortTry.ok) return shortTry;
  }
  return longTry;
}

function simulateRandom10000TrendModelV4({
  regime,
  priceSeed,
  tradeSeed,
  targetTrades = 10_000,
  pathSteps = 3000,
  traderCount = 250,
  settlementSteps = 800,
  ptBpsMin = 30,
  ptBpsMax = 120,
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
    openedShorts: 0,
    openFailInsufficientLiquidity: 0,
    openFailNoOffset: 0,
    openFailOther: 0,
    closeAttempts: 0,
    closeSuccess: 0,
    longTradePnl: 0n,
    shortTradePnl: 0n,
    poolTradePnl: 0n,
    maxUtilizationBps: 0n,
  };

  const liveTrades = new Set();
  const fixedProfitTargetPpm = defaultProfitTargetPpm(dex);

  for (let i = 0; i < path.length; i++) {
    const price = path[i];
    dex.setMockPriceE18(ADDR.owner, toE18(price));

    const opens = openSchedule[i];
    for (let j = 0; j < opens; j++) {
      const trader = traders[randomInt(rng, 0, traders.length - 1)];
      randomInt(rng, ptBpsMin, ptBpsMax);
      const opened = tryOpenRandomSideWithFallback(dex, trader, price, fixedProfitTargetPpm, rng);
      applyOpenResult(dex, opened, liveTrades, counters);
    }

    const closer = traders[randomInt(rng, 0, traders.length - 1)];
    closeSweep(dex, liveTrades, closer, counters);
    updateUtilization(dex, counters);
  }

  settleRemainingTrades(dex, liveTrades, counters);

  const summary = calculateFinalSummary(dex, counters, startUSDC, startWETH, startPrice, startEquity);
  return { summary, pathLength: path.length, targetTrades };
}

function runRandom10000TrendModelV4({ regime, title, priceSeed, tradeSeed }) {
  const { summary, pathLength, targetTrades } = simulateRandom10000TrendModelV4({
    regime,
    priceSeed,
    tradeSeed,
  });
  const bottomLine = summarizeBottomLine(summary);

  console.log("==================================================");
  console.log(`Scenario: ${title}`);
  console.log(`Regime:   ${regime}`);
  console.log(`Model:    V4`);
  console.log(`PathPts:  ${pathLength}`);
  console.log(`Trades:   ${targetTrades}`);
  printFinalSummary("Model V4", summary);
  const resultPath = writeScenarioResult({
    scenarioName: `model-v4-random-10000-${regime}`,
    payload: {
      model: "v4",
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
  runVerbose10TradesModelV4,
  runRandom10000TrendModelV4,
  simulateRandom10000TrendModelV4,
};
