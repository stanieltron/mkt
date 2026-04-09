"use strict";

const { MakeitV4Model, USDC_SCALE, E18, fmtUSDC6, fmtWETH18, fmtPriceE18 } = require("../model-v4/makeitv4");
const { writeScenarioResult } = require("../common/result-writer");

const ADDR = {
  owner: "owner",
  trader: "trader",
};

const START_PRICE = 3000;
const END_PRICE = 3195;
const TARGET_TRADES = 780;
const START_WETH = 12n * E18;
const GROSS_MARGIN_USDC = 10n * USDC_SCALE;
const LEVERAGE = 100n;
const PROFIT_TARGET_PPM = 1_000_000n;
const TP_PROBABILITY = 0.4934;
const RNG_SEED = 1337;

function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function usdcValueOfWeth(wethAmount, priceE18) {
  return ((wethAmount * priceE18) / E18) / (10n ** 12n);
}

function fmtPct(value) {
  return `${value.toFixed(2)}%`;
}

function toPriceE18(price) {
  return BigInt(Math.round(price * 1e18));
}

async function runSyntheticCrawlModel2Small() {
  const dex = new MakeitV4Model({ owner: ADDR.owner });
  dex.setFeeSplitPpm(ADDR.owner, 70n, 30n);
  dex.mintWETH(ADDR.owner, START_WETH);
  dex.fundETH(ADDR.owner, START_WETH);
  dex.mintUSDC(ADDR.trader, 10_000_000n * USDC_SCALE);

  const rng = createRng(RNG_SEED);
  const netMarginUsdc = dex._tradeMarginUSDC(GROSS_MARGIN_USDC, LEVERAGE);
  const totalFeeUsdc = dex._totalFeeAmountUSDC(GROSS_MARGIN_USDC, LEVERAGE);
  const protocolFeeUsdc = dex._protocolFeeAmountUSDC(GROSS_MARGIN_USDC, LEVERAGE);
  const lpFeeUsdc = totalFeeUsdc - protocolFeeUsdc;
  const priceStep = (END_PRICE - START_PRICE) / TARGET_TRADES;

  const stats = {
    tradesClosed: 0,
    tpCount: 0,
    slCount: 0,
    totalDurationSteps: 0,
    totalTradePnlUSDC: 0n,
    maxRequiredWETH: 0n,
    maxRequiredWETHAtPrice: 0,
  };

  let baseline = START_PRICE;

  for (let i = 0; i < TARGET_TRADES; i++) {
    const entryPrice = baseline;
    const entryPriceE18 = toPriceE18(entryPrice);
    dex.setMockPriceE18(ADDR.owner, entryPriceE18);

    const requiredWETH = dex._wethFromUsdcCeil(netMarginUsdc * LEVERAGE, entryPriceE18);
    if (requiredWETH > stats.maxRequiredWETH) {
      stats.maxRequiredWETH = requiredWETH;
      stats.maxRequiredWETHAtPrice = entryPrice;
    }

    const tradeId = dex.openLongTrade(ADDR.trader, entryPriceE18, 0, PROFIT_TARGET_PPM, LEVERAGE, GROSS_MARGIN_USDC);
    const trade = dex.trades.get(tradeId);

    const isTp = rng() < TP_PROBABILITY;
    const closePriceE18 = isTp ? trade.tpPriceE18 : trade.slPriceE18;
    dex.setMockPriceE18(ADDR.owner, closePriceE18);
    const result = dex.liquidateTrade("liquidator", tradeId);

    stats.tradesClosed++;
    stats.totalTradePnlUSDC -= result.tradePnlUSDC;
    if (result.status === "CLOSED_TP") stats.tpCount++;
    else stats.slCount++;
    stats.totalDurationSteps += 1;

    baseline += priceStep;
  }

  const startPriceE18 = toPriceE18(START_PRICE);
  const endPriceE18 = toPriceE18(END_PRICE);
  const endUSDC = dex.balanceUSDC(dex.dexAddress);
  const endWETH = dex.balanceWETH(dex.dexAddress);
  const startEquity = usdcValueOfWeth(START_WETH, startPriceE18);
  const endEquity = endUSDC + usdcValueOfWeth(endWETH, endPriceE18);
  const holdOnlyEnd = usdcValueOfWeth(START_WETH, endPriceE18);

  const payload = {
    model: "v4",
    scenarioType: "synthetic-crawl-model2-small",
    scenarioLabel: "Synthetic crawl bridge: 780 sequential 100x long trades across a +6.5% baseline rise",
    config: {
      startPrice: START_PRICE,
      endPrice: END_PRICE,
      targetTrades: TARGET_TRADES,
      startWETH: fmtWETH18(START_WETH),
      grossMarginUSDC: fmtUSDC6(GROSS_MARGIN_USDC),
      netMarginUSDC: fmtUSDC6(netMarginUsdc),
      totalFeeUSDC: fmtUSDC6(totalFeeUsdc),
      protocolFeeUSDC: fmtUSDC6(protocolFeeUsdc),
      lpFeeUSDC: fmtUSDC6(lpFeeUsdc),
      leverage: Number(LEVERAGE),
      profitTargetPpm: Number(PROFIT_TARGET_PPM),
      tpProbability: TP_PROBABILITY,
      priceStepPerTrade: priceStep,
      pathDescription: "one trade opens at each baseline point, closes at its exact TP or SL, then the baseline drifts upward by a fixed increment",
    },
    results: {
      startPrice: fmtPriceE18(startPriceE18),
      endPrice: fmtPriceE18(endPriceE18),
      startWETH: fmtWETH18(START_WETH),
      startPoolValueUSD: fmtUSDC6(startEquity),
      endWETH: fmtWETH18(endWETH),
      endUSDC: fmtUSDC6(endUSDC),
      endPoolValueUSD: fmtUSDC6(endEquity),
      holdOnlyEndValueUSD: fmtUSDC6(holdOnlyEnd),
      poolVsHoldUSD: fmtUSDC6(endEquity - holdOnlyEnd),
      tradesClosed: stats.tradesClosed,
      tpCount: stats.tpCount,
      slCount: stats.slCount,
      tpRatePct: (stats.tpCount * 100) / stats.tradesClosed,
      slRatePct: (stats.slCount * 100) / stats.tradesClosed,
      avgDurationSteps: stats.totalDurationSteps / stats.tradesClosed,
      totalProtocolTradePnlUSDC: fmtUSDC6(stats.totalTradePnlUSDC),
      protocolFeesAccruedUSDC: fmtUSDC6(dex.protocolFeeAccruedUSDC),
      maxRequiredWETH: fmtWETH18(stats.maxRequiredWETH),
      maxRequiredWETHAtPrice: stats.maxRequiredWETHAtPrice.toFixed(2),
    },
  };

  const filePath = writeScenarioResult({
    scenarioName: "model-v4-synthetic-crawl-model2-small",
    payload,
  });

  console.log("==================================================");
  console.log("Synthetic Crawl Model2 Small");
  console.log(`Trades:                     ${payload.results.tradesClosed}`);
  console.log(`Start -> end price:         ${payload.results.startPrice} -> ${payload.results.endPrice}`);
  console.log(`TP / SL:                    ${stats.tpCount} / ${stats.slCount} (${fmtPct(payload.results.tpRatePct)} / ${fmtPct(payload.results.slRatePct)})`);
  console.log(`Start pool value:           ${payload.results.startPoolValueUSD} USDC`);
  console.log(`End WETH:                   ${payload.results.endWETH} WETH`);
  console.log(`End USDC:                   ${payload.results.endUSDC} USDC`);
  console.log(`End pool value:             ${payload.results.endPoolValueUSD} USDC`);
  console.log(`Hold-only end value:        ${payload.results.holdOnlyEndValueUSD} USDC`);
  console.log(`Pool vs hold:               ${payload.results.poolVsHoldUSD} USDC`);
  console.log(`Protocol trade PnL:         ${payload.results.totalProtocolTradePnlUSDC} USDC`);
  console.log(`Protocol fees accrued:      ${payload.results.protocolFeesAccruedUSDC} USDC`);
  console.log(`Max required WETH backing:  ${payload.results.maxRequiredWETH} WETH`);
  console.log(`Result file:                ${filePath}`);
  console.log("==================================================");
}

runSyntheticCrawlModel2Small().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
