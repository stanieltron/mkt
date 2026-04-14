"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { MakeitV4Model, USDC_SCALE, E18, fmtUSDC6, fmtWETH18, fmtPriceE18 } = require("../model-v4/makeitv4");
const { writeScenarioResult } = require("../common/result-writer");

const DATA_DIR = path.resolve(__dirname, "binance-data");
const GROSS_MARGIN_USDC = 10n * USDC_SCALE;
const PROFIT_TARGET_PPM = 1_000_000n;
const MAX_CONCURRENT_TRADES = 10;

const ADDR = {
  owner: "owner",
  trader: "trader",
  longTrader: "longTrader",
  shortTrader: "shortTrader",
};

function normalizeTimestampUs(raw) {
  const ts = BigInt(raw);
  return ts < 10_000_000_000_000n ? ts * 1000n : ts;
}

function toIsoMinute(usMicro) {
  return new Date(Number(normalizeTimestampUs(usMicro) / 1000n)).toISOString();
}

function fmtPct(value) {
  return `${value.toFixed(2)}%`;
}

function fmtPrice(v) {
  return Number(v).toFixed(2);
}

function median(sorted) {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

function parseCandle(line) {
  const parts = line.split(",");
  if (parts.length < 5) return null;
  return {
    openTimeUs: normalizeTimestampUs(parts[0]),
    open: Number(parts[1]),
    high: Number(parts[2]),
    low: Number(parts[3]),
    close: Number(parts[4]),
  };
}

function listHistoricalZipFilesReversed() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((name) => /^ETHUSDT-1m-\d{4}-\d{2}\.zip$/i.test(name))
    .sort()
    .reverse()
    .map((name) => path.join(DATA_DIR, name));
}

async function readZipCsvLines(zipPath) {
  const escaped = zipPath.replace(/'/g, "''");
  const command = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip='${escaped}'`,
    "$archive=[System.IO.Compression.ZipFile]::OpenRead($zip)",
    "$entry=$archive.Entries[0]",
    "$reader=New-Object System.IO.StreamReader($entry.Open())",
    "try { while(-not $reader.EndOfStream){ [Console]::Out.WriteLine($reader.ReadLine()) } } finally { $reader.Dispose(); $archive.Dispose() }",
  ].join("; ");

  const ps = spawn("powershell", ["-NoProfile", "-Command", command], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  ps.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const rl = readline.createInterface({ input: ps.stdout, crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) {
    if (line.trim()) lines.push(line);
  }

  const exitCode = await new Promise((resolve) => ps.on("close", resolve));
  if (exitCode !== 0) {
    throw new Error(`failed to stream zip ${path.basename(zipPath)}: ${stderr.trim() || `exit ${exitCode}`}`);
  }

  return lines;
}

async function* iterateCandlesReversed() {
  const files = listHistoricalZipFilesReversed();
  for (const zipPath of files) {
    const lines = await readZipCsvLines(zipPath);
    for (let i = lines.length - 1; i >= 0; i--) {
      const candle = parseCandle(lines[i]);
      if (candle) yield candle;
    }
  }
}

function usdcValueOfWeth(wethAmount, priceE18) {
  return ((wethAmount * priceE18) / E18) / (10n ** 12n);
}

function classifyOpenFailure(message) {
  if (message === "insufficient ETH coverage") return "insufficientEthCoverage";
  if (message === "no long notional to offset short") return "noLongOffset";
  return "other";
}

function createDexWithFees() {
  const dex = new MakeitV4Model({ owner: ADDR.owner });
  dex.setFeeSplitPpm(ADDR.owner, 70n, 30n);
  return dex;
}

function createOneSliceConfig(leverage) {
  const dex = createDexWithFees();
  const netMarginUsdc = dex._tradeMarginUSDC(GROSS_MARGIN_USDC, leverage);
  const totalFeeUsdc = dex._totalFeeAmountUSDC(GROSS_MARGIN_USDC, leverage);
  const protocolFeeUsdc = dex._protocolFeeAmountUSDC(GROSS_MARGIN_USDC, leverage);
  const lpFeeUsdc = totalFeeUsdc - protocolFeeUsdc;
  return {
    dex,
    leverage,
    netMarginUsdc,
    totalFeeUsdc,
    protocolFeeUsdc,
    lpFeeUsdc,
    notionalUsdc: netMarginUsdc * leverage,
  };
}

async function runReverseModel1() {
  const { dex, leverage, netMarginUsdc, totalFeeUsdc, protocolFeeUsdc, lpFeeUsdc, notionalUsdc } = createOneSliceConfig(100n);

  const stats = {
    files: listHistoricalZipFilesReversed().length,
    candlesProcessed: 0,
    firstMinuteUs: null,
    lastMinuteUs: null,
    tpCount: 0,
    slCount: 0,
    ambiguousBothHitCount: 0,
    totalDurationMinutes: 0,
    totalTraderPnlUSDC: 0n,
    totalProtocolTradePnlUSDC: 0n,
    totalGrossFeesUSDC: 0n,
    totalProtocolFeesUSDC: 0n,
    totalLpFeesUSDC: 0n,
    maxRequiredWETH: 0n,
    maxRequiredWETHAtOpenTimeUs: 0n,
    maxRequiredWETHAtPrice: 0,
    maxRequiredUSDCBacking: notionalUsdc,
  };

  const durations = [];
  let openTrade = null;
  let pendingOpenNextCandle = true;

  for await (const candle of iterateCandlesReversed()) {
    stats.candlesProcessed++;
    if (stats.firstMinuteUs === null) stats.firstMinuteUs = candle.openTimeUs;
    stats.lastMinuteUs = candle.openTimeUs;

    if (openTrade) {
      const hitTP = candle.high >= openTrade.tpPrice;
      const hitSL = candle.low <= openTrade.slPrice;
      if (hitTP || hitSL) {
        if (hitTP && hitSL) stats.ambiguousBothHitCount++;
        const isSl = hitSL;
        const durationMinutes = Number((openTrade.openTimeUs - candle.openTimeUs) / 60000000n);
        durations.push(durationMinutes);
        stats.totalDurationMinutes += durationMinutes;
        stats.totalGrossFeesUSDC += totalFeeUsdc;
        stats.totalProtocolFeesUSDC += protocolFeeUsdc;
        stats.totalLpFeesUSDC += lpFeeUsdc;
        if (isSl) {
          stats.slCount++;
          stats.totalTraderPnlUSDC -= netMarginUsdc;
          stats.totalProtocolTradePnlUSDC += netMarginUsdc;
        } else {
          stats.tpCount++;
          stats.totalTraderPnlUSDC += netMarginUsdc;
          stats.totalProtocolTradePnlUSDC -= netMarginUsdc;
        }
        openTrade = null;
        pendingOpenNextCandle = true;
      }
    }

    if (!openTrade && pendingOpenNextCandle) {
      const entryPriceE18 = BigInt(Math.round(candle.open * 1e18));
      const { tp, sl } = dex._levelsLong(entryPriceE18, PROFIT_TARGET_PPM, leverage);
      const requiredWETH = dex._wethFromUsdcCeil(notionalUsdc, entryPriceE18);
      if (requiredWETH > stats.maxRequiredWETH) {
        stats.maxRequiredWETH = requiredWETH;
        stats.maxRequiredWETHAtOpenTimeUs = candle.openTimeUs;
        stats.maxRequiredWETHAtPrice = candle.open;
      }
      openTrade = {
        openTimeUs: candle.openTimeUs,
        tpPrice: Number(tp) / 1e18,
        slPrice: Number(sl) / 1e18,
      };
      pendingOpenNextCandle = false;
    }
  }

  const tradesClosed = stats.tpCount + stats.slCount;
  const sortedDurations = durations.slice().sort((a, b) => a - b);
  const payload = {
    model: "v4",
    scenarioType: "historical-replay-one-slice-reverse",
    scenarioLabel: "Historical ETH 1m replay in reverse order, one sequential 100x long slice",
    dataset: {
      files: stats.files,
      candlesProcessed: stats.candlesProcessed,
      firstMinuteIso: stats.firstMinuteUs ? toIsoMinute(stats.firstMinuteUs) : null,
      lastMinuteIso: stats.lastMinuteUs ? toIsoMinute(stats.lastMinuteUs) : null,
    },
    config: {
      dataOrder: "reverse-chronological",
      grossMarginUSDC: fmtUSDC6(GROSS_MARGIN_USDC),
      netMarginUSDC: fmtUSDC6(netMarginUsdc),
      totalFeeUSDC: fmtUSDC6(totalFeeUsdc),
      protocolFeeUSDC: fmtUSDC6(protocolFeeUsdc),
      lpFeeUSDC: fmtUSDC6(lpFeeUsdc),
      leverage: Number(leverage),
      notionalUSDC: fmtUSDC6(notionalUsdc),
    },
    results: {
      tradesClosed,
      tpCount: stats.tpCount,
      slCount: stats.slCount,
      tpRatePct: tradesClosed ? (stats.tpCount * 100) / tradesClosed : 0,
      slRatePct: tradesClosed ? (stats.slCount * 100) / tradesClosed : 0,
      ambiguousBothHitCount: stats.ambiguousBothHitCount,
      totalTraderPnlUSDC: fmtUSDC6(stats.totalTraderPnlUSDC),
      totalProtocolTradePnlUSDC: fmtUSDC6(stats.totalProtocolTradePnlUSDC),
      totalGrossFeesUSDC: fmtUSDC6(stats.totalGrossFeesUSDC),
      totalProtocolFeesUSDC: fmtUSDC6(stats.totalProtocolFeesUSDC),
      totalLpFeesUSDC: fmtUSDC6(stats.totalLpFeesUSDC),
      avgDurationMinutes: tradesClosed ? stats.totalDurationMinutes / tradesClosed : 0,
      medianDurationMinutes: median(sortedDurations),
      p95DurationMinutes: percentile(sortedDurations, 0.95),
      maxRequiredWETH: fmtWETH18(stats.maxRequiredWETH),
      maxRequiredUSDCBacking: fmtUSDC6(stats.maxRequiredUSDCBacking),
      maxRequiredWETHAtPrice: fmtPrice(stats.maxRequiredWETHAtPrice),
      maxRequiredWETHAtOpenTimeIso: stats.maxRequiredWETHAtOpenTimeUs ? toIsoMinute(stats.maxRequiredWETHAtOpenTimeUs) : null,
    },
  };

  const resultPath = writeScenarioResult({
    scenarioName: "model-v4-reverse-model1-one-slice-100x",
    payload,
  });
  return { payload, resultPath, startWeth: stats.maxRequiredWETH };
}

async function runReverseModel4() {
  const { dex, leverage, netMarginUsdc, totalFeeUsdc, protocolFeeUsdc, lpFeeUsdc, notionalUsdc } = createOneSliceConfig(300n);

  const stats = {
    files: listHistoricalZipFilesReversed().length,
    candlesProcessed: 0,
    firstMinuteUs: null,
    lastMinuteUs: null,
    tpCount: 0,
    slCount: 0,
    ambiguousBothHitCount: 0,
    totalDurationMinutes: 0,
    totalProtocolTradePnlUSDC: 0n,
    maxRequiredWETH: 0n,
    maxRequiredWETHAtOpenTimeUs: 0n,
    maxRequiredWETHAtPrice: 0,
    maxRequiredUSDCBacking: notionalUsdc,
  };

  const durations = [];
  let openTrade = null;
  let pendingOpenNextCandle = true;

  for await (const candle of iterateCandlesReversed()) {
    stats.candlesProcessed++;
    if (stats.firstMinuteUs === null) stats.firstMinuteUs = candle.openTimeUs;
    stats.lastMinuteUs = candle.openTimeUs;

    if (openTrade) {
      const hitTP = candle.high >= openTrade.tpPrice;
      const hitSL = candle.low <= openTrade.slPrice;
      if (hitTP || hitSL) {
        if (hitTP && hitSL) stats.ambiguousBothHitCount++;
        const isSl = hitSL;
        const durationMinutes = Number((openTrade.openTimeUs - candle.openTimeUs) / 60000000n);
        durations.push(durationMinutes);
        stats.totalDurationMinutes += durationMinutes;
        const pnlUSDC = isSl ? -netMarginUsdc : dex._targetProfitUSDC({ marginUSDC: netMarginUsdc, profitTargetPpm: PROFIT_TARGET_PPM });
        stats.totalProtocolTradePnlUSDC -= pnlUSDC;
        if (isSl) stats.slCount++;
        else stats.tpCount++;
        openTrade = null;
        pendingOpenNextCandle = true;
      }
    }

    if (!openTrade && pendingOpenNextCandle) {
      const entryPriceE18 = BigInt(Math.round(candle.open * 1e18));
      const levels = dex._levelsLong(entryPriceE18, PROFIT_TARGET_PPM, leverage);
      const requiredWETH = dex._wethFromUsdcCeil(notionalUsdc, entryPriceE18);
      if (requiredWETH > stats.maxRequiredWETH) {
        stats.maxRequiredWETH = requiredWETH;
        stats.maxRequiredWETHAtPrice = candle.open;
        stats.maxRequiredWETHAtOpenTimeUs = candle.openTimeUs;
      }
      openTrade = {
        openTimeUs: candle.openTimeUs,
        tpPrice: Number(levels.tp) / 1e18,
        slPrice: Number(levels.sl) / 1e18,
      };
      pendingOpenNextCandle = false;
    }
  }

  const tradesClosed = stats.tpCount + stats.slCount;
  const sortedDurations = durations.slice().sort((a, b) => a - b);
  const payload = {
    model: "v4",
    scenarioType: "historical-replay-model4-one-slice-reverse",
    scenarioLabel: "Historical ETH 1m replay in reverse order, one sequential 300x long slice with capacity ignored",
    dataset: {
      files: stats.files,
      candlesProcessed: stats.candlesProcessed,
      firstMinuteIso: stats.firstMinuteUs ? toIsoMinute(stats.firstMinuteUs) : null,
      lastMinuteIso: stats.lastMinuteUs ? toIsoMinute(stats.lastMinuteUs) : null,
    },
    config: {
      dataOrder: "reverse-chronological",
      grossMarginUSDC: fmtUSDC6(GROSS_MARGIN_USDC),
      netMarginUSDC: fmtUSDC6(netMarginUsdc),
      totalFeeUSDC: fmtUSDC6(totalFeeUsdc),
      protocolFeeUSDC: fmtUSDC6(protocolFeeUsdc),
      lpFeeUSDC: fmtUSDC6(lpFeeUsdc),
      leverage: Number(leverage),
      notionalUSDC: fmtUSDC6(notionalUsdc),
      targetProfitUSDC: fmtUSDC6(dex._targetProfitUSDC({ marginUSDC: netMarginUsdc, profitTargetPpm: PROFIT_TARGET_PPM })),
    },
    results: {
      tradesClosed,
      tpCount: stats.tpCount,
      slCount: stats.slCount,
      tpRatePct: tradesClosed ? (stats.tpCount * 100) / tradesClosed : 0,
      slRatePct: tradesClosed ? (stats.slCount * 100) / tradesClosed : 0,
      ambiguousBothHitCount: stats.ambiguousBothHitCount,
      avgDurationMinutes: tradesClosed ? stats.totalDurationMinutes / tradesClosed : 0,
      medianDurationMinutes: median(sortedDurations),
      p95DurationMinutes: percentile(sortedDurations, 0.95),
      totalProtocolTradePnlUSDC: fmtUSDC6(stats.totalProtocolTradePnlUSDC),
      grossFeesUSDC: fmtUSDC6(totalFeeUsdc * BigInt(tradesClosed)),
      protocolFeesUSDC: fmtUSDC6(protocolFeeUsdc * BigInt(tradesClosed)),
      lpFeesUSDC: fmtUSDC6(lpFeeUsdc * BigInt(tradesClosed)),
      maxRequiredWETH: fmtWETH18(stats.maxRequiredWETH),
      maxRequiredUSDCBacking: fmtUSDC6(stats.maxRequiredUSDCBacking),
      maxRequiredWETHAtPrice: fmtPrice(stats.maxRequiredWETHAtPrice),
      maxRequiredWETHAtOpenTimeIso: stats.maxRequiredWETHAtOpenTimeUs ? toIsoMinute(stats.maxRequiredWETHAtOpenTimeUs) : null,
    },
  };
  const resultPath = writeScenarioResult({
    scenarioName: "model-v4-reverse-model4-one-slice-300x",
    payload,
  });
  return { payload, resultPath, startWeth: stats.maxRequiredWETH };
}

async function runReverseModel2Like(name, label, leverage, startWETH) {
  const { netMarginUsdc, totalFeeUsdc, protocolFeeUsdc, lpFeeUsdc } = createOneSliceConfig(leverage);
  const dex = createDexWithFees();
  dex.mintWETH(ADDR.owner, startWETH);
  dex.fundETH(ADDR.owner, startWETH);
  dex.mintUSDC(ADDR.trader, 10_000_000n * USDC_SCALE);

  const stats = {
    files: listHistoricalZipFilesReversed().length,
    candlesProcessed: 0,
    firstMinuteUs: null,
    lastMinuteUs: null,
    tpCount: 0,
    slCount: 0,
    ambiguousBothHitCount: 0,
    totalDurationMinutes: 0,
    totalTradePnlUSDC: 0n,
    maxRequiredWETH: 0n,
    maxRequiredWETHAtPrice: 0,
    maxRequiredWETHAtOpenTimeUs: 0n,
  };
  const durations = [];
  let openTrade = null;
  let pendingOpenNextCandle = true;
  let startPriceE18 = null;
  let endPriceE18 = null;

  for await (const candle of iterateCandlesReversed()) {
    stats.candlesProcessed++;
    if (stats.firstMinuteUs === null) {
      stats.firstMinuteUs = candle.openTimeUs;
      startPriceE18 = BigInt(Math.round(candle.open * 1e18));
    }
    stats.lastMinuteUs = candle.openTimeUs;
    endPriceE18 = BigInt(Math.round(candle.close * 1e18));

    if (openTrade) {
      const hitTP = candle.high >= openTrade.tpPrice;
      const hitSL = candle.low <= openTrade.slPrice;
      if (hitTP || hitSL) {
        if (hitTP && hitSL) stats.ambiguousBothHitCount++;
        const liquidationPriceE18 = hitSL ? openTrade.slPriceE18 : openTrade.tpPriceE18;
        dex.setMockPriceE18(ADDR.owner, liquidationPriceE18);
        const result = dex.liquidateTrade("liquidator", openTrade.tradeId);
        if (result.status === "CLOSED_TP") stats.tpCount++;
        else stats.slCount++;
        stats.totalTradePnlUSDC -= result.tradePnlUSDC;
        const durationMinutes = Number((openTrade.openTimeUs - candle.openTimeUs) / 60000000n);
        durations.push(durationMinutes);
        stats.totalDurationMinutes += durationMinutes;
        openTrade = null;
        pendingOpenNextCandle = true;
      }
    }

    if (!openTrade && pendingOpenNextCandle) {
      const entryPriceE18 = BigInt(Math.round(candle.open * 1e18));
      dex.setMockPriceE18(ADDR.owner, entryPriceE18);
      const requiredWETH = dex._wethFromUsdcCeil(netMarginUsdc * leverage, entryPriceE18);
      if (requiredWETH > stats.maxRequiredWETH) {
        stats.maxRequiredWETH = requiredWETH;
        stats.maxRequiredWETHAtPrice = candle.open;
        stats.maxRequiredWETHAtOpenTimeUs = candle.openTimeUs;
      }
      const tradeId = dex.openLongTrade(ADDR.trader, entryPriceE18, 0, PROFIT_TARGET_PPM, leverage, GROSS_MARGIN_USDC);
      const trade = dex.trades.get(tradeId);
      openTrade = {
        tradeId,
        openTimeUs: candle.openTimeUs,
        tpPrice: Number(trade.tpPriceE18) / 1e18,
        slPrice: Number(trade.slPriceE18) / 1e18,
        tpPriceE18: trade.tpPriceE18,
        slPriceE18: trade.slPriceE18,
      };
      pendingOpenNextCandle = false;
    }
  }

  const endUSDC = dex.balanceUSDC(dex.dexAddress);
  const endWETH = dex.balanceWETH(dex.dexAddress);
  const startEquity = usdcValueOfWeth(startWETH, startPriceE18);
  const endEquity = endUSDC + usdcValueOfWeth(endWETH, endPriceE18);
  const holdOnlyEnd = usdcValueOfWeth(startWETH, endPriceE18);
  const sortedDurations = durations.slice().sort((a, b) => a - b);
  const tradesClosed = stats.tpCount + stats.slCount;

  const payload = {
    model: "v4",
    scenarioType: `${name}-reverse`,
    scenarioLabel: label,
    dataset: {
      files: stats.files,
      candlesProcessed: stats.candlesProcessed,
      firstMinuteIso: stats.firstMinuteUs ? toIsoMinute(stats.firstMinuteUs) : null,
      lastMinuteIso: stats.lastMinuteUs ? toIsoMinute(stats.lastMinuteUs) : null,
    },
    config: {
      dataOrder: "reverse-chronological",
      startWETH: fmtWETH18(startWETH),
      startWETHSource: leverage === 100n ? "reverse Model 1 max single-slice backing" : "reverse Model 4 max single-slice backing",
      grossMarginUSDC: fmtUSDC6(GROSS_MARGIN_USDC),
      netMarginUSDC: fmtUSDC6(netMarginUsdc),
      totalFeeUSDC: fmtUSDC6(totalFeeUsdc),
      protocolFeeUSDC: fmtUSDC6(protocolFeeUsdc),
      lpFeeUSDC: fmtUSDC6(lpFeeUsdc),
      leverage: Number(leverage),
      notionalUSDC: fmtUSDC6(netMarginUsdc * leverage),
    },
    results: {
      tradesClosed,
      tpCount: stats.tpCount,
      slCount: stats.slCount,
      tpRatePct: tradesClosed ? (stats.tpCount * 100) / tradesClosed : 0,
      slRatePct: tradesClosed ? (stats.slCount * 100) / tradesClosed : 0,
      ambiguousBothHitCount: stats.ambiguousBothHitCount,
      avgDurationMinutes: tradesClosed ? stats.totalDurationMinutes / tradesClosed : 0,
      medianDurationMinutes: median(sortedDurations),
      p95DurationMinutes: percentile(sortedDurations, 0.95),
      startPrice: fmtPriceE18(startPriceE18),
      endPrice: fmtPriceE18(endPriceE18),
      startWETH: fmtWETH18(startWETH),
      startPoolValueUSD: fmtUSDC6(startEquity),
      endWETH: fmtWETH18(endWETH),
      endUSDC: fmtUSDC6(endUSDC),
      endPoolValueUSD: fmtUSDC6(endEquity),
      holdOnlyEndValueUSD: fmtUSDC6(holdOnlyEnd),
      poolVsHoldUSD: fmtUSDC6(endEquity - holdOnlyEnd),
      totalProtocolTradePnlUSDC: fmtUSDC6(stats.totalTradePnlUSDC),
      protocolFeesAccruedUSDC: fmtUSDC6(dex.protocolFeeAccruedUSDC),
      maxRequiredWETH: fmtWETH18(stats.maxRequiredWETH),
      maxRequiredWETHAtPrice: fmtPrice(stats.maxRequiredWETHAtPrice),
      maxRequiredWETHAtOpenTimeIso: stats.maxRequiredWETHAtOpenTimeUs ? toIsoMinute(stats.maxRequiredWETHAtOpenTimeUs) : null,
    },
  };

  const resultPath = writeScenarioResult({
    scenarioName: name,
    payload,
  });
  return { payload, resultPath };
}

async function runReverseModel3Like(name, label, leverage, startWETH) {
  const { netMarginUsdc, totalFeeUsdc, protocolFeeUsdc, lpFeeUsdc, notionalUsdc } = createOneSliceConfig(leverage);
  const dex = createDexWithFees();
  dex.mintWETH(ADDR.owner, startWETH);
  dex.fundETH(ADDR.owner, startWETH);
  dex.mintUSDC(ADDR.longTrader, 50_000_000n * USDC_SCALE);
  dex.mintUSDC(ADDR.shortTrader, 50_000_000n * USDC_SCALE);

  const stats = {
    files: listHistoricalZipFilesReversed().length,
    candlesProcessed: 0,
    firstMinuteUs: null,
    lastMinuteUs: null,
    openedLongs: 0,
    openedShorts: 0,
    closedLongTp: 0,
    closedLongSl: 0,
    closedShortTp: 0,
    closedShortSl: 0,
    ambiguousBothHitCount: 0,
    longOpenFailInsufficientEthCoverage: 0,
    shortOpenFailNoLongOffset: 0,
    otherOpenFailures: 0,
    totalLongDurationMinutes: 0,
    totalShortDurationMinutes: 0,
    totalProtocolTradePnlUSDC: 0n,
    maxSimultaneousOpenTrades: 0,
    maxRequiredWETH: 0n,
    maxRequiredWETHAtOpenTimeUs: 0n,
    maxRequiredWETHAtPrice: 0,
  };
  const longDurations = [];
  const shortDurations = [];
  const liveTrades = [];
  let startPriceE18 = null;
  let endPriceE18 = null;

  for await (const candle of iterateCandlesReversed()) {
    stats.candlesProcessed++;
    if (stats.firstMinuteUs === null) {
      stats.firstMinuteUs = candle.openTimeUs;
      startPriceE18 = BigInt(Math.round(candle.open * 1e18));
    }
    stats.lastMinuteUs = candle.openTimeUs;
    endPriceE18 = BigInt(Math.round(candle.close * 1e18));

    for (let idx = liveTrades.length - 1; idx >= 0; idx--) {
      const live = liveTrades[idx];
      const trade = dex.trades.get(live.tradeId);
      if (!trade || trade.status !== "OPEN") {
        liveTrades.splice(idx, 1);
        continue;
      }
      const hitTP = live.side === "LONG" ? candle.high >= live.tpPrice : candle.low <= live.tpPrice;
      const hitSL = live.side === "LONG" ? candle.low <= live.slPrice : candle.high >= live.slPrice;
      if (!hitTP && !hitSL) continue;
      if (hitTP && hitSL) stats.ambiguousBothHitCount++;
      const liquidationPriceE18 = hitSL ? live.slPriceE18 : live.tpPriceE18;
      dex.setMockPriceE18(ADDR.owner, liquidationPriceE18);
      const result = dex.liquidateTrade("liquidator", live.tradeId);
      liveTrades.splice(idx, 1);
      const durationMinutes = Number((live.openTimeUs - candle.openTimeUs) / 60000000n);
      stats.totalProtocolTradePnlUSDC -= result.tradePnlUSDC;
      if (trade.side === "LONG") {
        longDurations.push(durationMinutes);
        stats.totalLongDurationMinutes += durationMinutes;
        if (result.status === "CLOSED_TP") stats.closedLongTp++;
        else stats.closedLongSl++;
      } else {
        shortDurations.push(durationMinutes);
        stats.totalShortDurationMinutes += durationMinutes;
        if (result.status === "CLOSED_TP") stats.closedShortTp++;
        else stats.closedShortSl++;
      }
    }

    const entryPriceE18 = BigInt(Math.round(candle.open * 1e18));
    dex.setMockPriceE18(ADDR.owner, entryPriceE18);
    const requiredWETH = dex._wethFromUsdcCeil(
      dex.openLongNotionalUSDC > dex.openShortNotionalUSDC
        ? dex.openLongNotionalUSDC - dex.openShortNotionalUSDC + notionalUsdc
        : notionalUsdc,
      entryPriceE18
    );
    if (requiredWETH > stats.maxRequiredWETH) {
      stats.maxRequiredWETH = requiredWETH;
      stats.maxRequiredWETHAtPrice = candle.open;
      stats.maxRequiredWETHAtOpenTimeUs = candle.openTimeUs;
    }

    if (liveTrades.length < MAX_CONCURRENT_TRADES) {
      try {
        const longId = dex.openLongTrade(ADDR.longTrader, entryPriceE18, 0, PROFIT_TARGET_PPM, leverage, GROSS_MARGIN_USDC);
        const trade = dex.trades.get(longId);
        liveTrades.push({
          tradeId: longId,
          openTimeUs: candle.openTimeUs,
          side: "LONG",
          tpPrice: Number(trade.tpPriceE18) / 1e18,
          slPrice: Number(trade.slPriceE18) / 1e18,
          tpPriceE18: trade.tpPriceE18,
          slPriceE18: trade.slPriceE18,
        });
        stats.openedLongs++;
      } catch (err) {
        const kind = classifyOpenFailure(err.message);
        if (kind === "insufficientEthCoverage") stats.longOpenFailInsufficientEthCoverage++;
        else stats.otherOpenFailures++;
      }
    }

    if (liveTrades.length < MAX_CONCURRENT_TRADES) {
      try {
        const shortId = dex.openShortTrade(ADDR.shortTrader, entryPriceE18, 0, PROFIT_TARGET_PPM, leverage, GROSS_MARGIN_USDC);
        const trade = dex.trades.get(shortId);
        liveTrades.push({
          tradeId: shortId,
          openTimeUs: candle.openTimeUs,
          side: "SHORT",
          tpPrice: Number(trade.tpPriceE18) / 1e18,
          slPrice: Number(trade.slPriceE18) / 1e18,
          tpPriceE18: trade.tpPriceE18,
          slPriceE18: trade.slPriceE18,
        });
        stats.openedShorts++;
      } catch (err) {
        const kind = classifyOpenFailure(err.message);
        if (kind === "noLongOffset") stats.shortOpenFailNoLongOffset++;
        else stats.otherOpenFailures++;
      }
    }

    if (liveTrades.length > stats.maxSimultaneousOpenTrades) {
      stats.maxSimultaneousOpenTrades = liveTrades.length;
    }
  }

  const endUSDC = dex.balanceUSDC(dex.dexAddress);
  const endWETH = dex.balanceWETH(dex.dexAddress);
  const startEquity = usdcValueOfWeth(startWETH, startPriceE18);
  const endEquity = endUSDC + usdcValueOfWeth(endWETH, endPriceE18);
  const holdOnlyEnd = usdcValueOfWeth(startWETH, endPriceE18);
  const tradesClosed = stats.closedLongTp + stats.closedLongSl + stats.closedShortTp + stats.closedShortSl;
  const longSorted = longDurations.slice().sort((a, b) => a - b);
  const shortSorted = shortDurations.slice().sort((a, b) => a - b);

  const payload = {
    model: "v4",
    scenarioType: `${name}-reverse`,
    scenarioLabel: label,
    dataset: {
      files: stats.files,
      candlesProcessed: stats.candlesProcessed,
      firstMinuteIso: stats.firstMinuteUs ? toIsoMinute(stats.firstMinuteUs) : null,
      lastMinuteIso: stats.lastMinuteUs ? toIsoMinute(stats.lastMinuteUs) : null,
    },
    config: {
      dataOrder: "reverse-chronological",
      startWETH: fmtWETH18(startWETH),
      startWETHSource: leverage === 100n ? "reverse Model 1 max single-slice backing" : "reverse Model 4 max single-slice backing",
      grossMarginUSDC: fmtUSDC6(GROSS_MARGIN_USDC),
      netMarginUSDC: fmtUSDC6(netMarginUsdc),
      totalFeeUSDC: fmtUSDC6(totalFeeUsdc),
      protocolFeeUSDC: fmtUSDC6(protocolFeeUsdc),
      lpFeeUSDC: fmtUSDC6(lpFeeUsdc),
      leverage: Number(leverage),
      notionalUSDC: fmtUSDC6(notionalUsdc),
      maxConcurrentTrades: MAX_CONCURRENT_TRADES,
    },
    results: {
      startPrice: fmtPriceE18(startPriceE18),
      endPrice: fmtPriceE18(endPriceE18),
      startWETH: fmtWETH18(startWETH),
      startPoolValueUSD: fmtUSDC6(startEquity),
      endWETH: fmtWETH18(endWETH),
      endUSDC: fmtUSDC6(endUSDC),
      endPoolValueUSD: fmtUSDC6(endEquity),
      holdOnlyEndValueUSD: fmtUSDC6(holdOnlyEnd),
      poolVsHoldUSD: fmtUSDC6(endEquity - holdOnlyEnd),
      openedLongs: stats.openedLongs,
      openedShorts: stats.openedShorts,
      tradesClosed,
      closedLongTp: stats.closedLongTp,
      closedLongSl: stats.closedLongSl,
      closedShortTp: stats.closedShortTp,
      closedShortSl: stats.closedShortSl,
      longOpenFailInsufficientEthCoverage: stats.longOpenFailInsufficientEthCoverage,
      shortOpenFailNoLongOffset: stats.shortOpenFailNoLongOffset,
      otherOpenFailures: stats.otherOpenFailures,
      ambiguousBothHitCount: stats.ambiguousBothHitCount,
      maxSimultaneousOpenTrades: stats.maxSimultaneousOpenTrades,
      avgLongDurationMinutes: longDurations.length ? stats.totalLongDurationMinutes / longDurations.length : 0,
      medianLongDurationMinutes: median(longSorted),
      p95LongDurationMinutes: percentile(longSorted, 0.95),
      avgShortDurationMinutes: shortDurations.length ? stats.totalShortDurationMinutes / shortDurations.length : 0,
      medianShortDurationMinutes: median(shortSorted),
      p95ShortDurationMinutes: percentile(shortSorted, 0.95),
      totalProtocolTradePnlUSDC: fmtUSDC6(stats.totalProtocolTradePnlUSDC),
      protocolFeesAccruedUSDC: fmtUSDC6(dex.protocolFeeAccruedUSDC),
      maxRequiredWETH: fmtWETH18(stats.maxRequiredWETH),
      maxRequiredWETHAtPrice: fmtPrice(stats.maxRequiredWETHAtPrice),
      maxRequiredWETHAtOpenTimeIso: stats.maxRequiredWETHAtOpenTimeUs ? toIsoMinute(stats.maxRequiredWETHAtOpenTimeUs) : null,
    },
  };

  const resultPath = writeScenarioResult({
    scenarioName: name,
    payload,
  });
  return { payload, resultPath };
}

function printSummary(title, payload) {
  const r = payload.results;
  console.log("==================================================");
  console.log(title);
  console.log(`range:                      ${payload.dataset.firstMinuteIso} -> ${payload.dataset.lastMinuteIso}`);
  if (r.startPoolValueUSD) {
    console.log(`start pool value:           ${r.startPoolValueUSD} USDC`);
    console.log(`end pool value:             ${r.endPoolValueUSD} USDC`);
    console.log(`hold-only end value:        ${r.holdOnlyEndValueUSD} USDC`);
    console.log(`pool vs hold:               ${r.poolVsHoldUSD} USDC`);
  }
  if (r.tradesClosed) console.log(`trades closed:              ${r.tradesClosed}`);
  if (r.tpCount !== undefined && r.slCount !== undefined) console.log(`TP / SL:                    ${r.tpCount} / ${r.slCount}`);
  if (r.openedLongs !== undefined) console.log(`opened longs / shorts:      ${r.openedLongs} / ${r.openedShorts}`);
  if (r.totalProtocolTradePnlUSDC) console.log(`protocol trade PnL:         ${r.totalProtocolTradePnlUSDC} USDC`);
  if (r.protocolFeesAccruedUSDC) console.log(`protocol fees accrued:      ${r.protocolFeesAccruedUSDC} USDC`);
  if (r.totalProtocolFeesUSDC) console.log(`protocol fees:              ${r.totalProtocolFeesUSDC} USDC`);
  console.log(`max required WETH backing:  ${r.maxRequiredWETH} WETH`);
}

async function main() {
  const model1 = await runReverseModel1();
  printSummary("Reverse Model 1", model1.payload);

  const model2 = await runReverseModel2Like(
    "model-v4-reverse-model2-one-slice-100x",
    "Historical ETH 1m replay in reverse order, one sequential 100x long slice funded with reverse Model 1 max backing",
    100n,
    model1.startWeth
  );
  printSummary("Reverse Model 2", model2.payload);

  const model3 = await runReverseModel3Like(
    "model-v4-reverse-model3-openflow-100x",
    "Historical ETH 1m replay in reverse order, 100x open-flow with reverse Model 1 max backing and 10 concurrent trades",
    100n,
    model1.startWeth
  );
  printSummary("Reverse Model 3", model3.payload);

  const model4 = await runReverseModel4();
  printSummary("Reverse Model 4", model4.payload);

  const model5 = await runReverseModel2Like(
    "model-v4-reverse-model5-one-slice-300x",
    "Historical ETH 1m replay in reverse order, one sequential 300x long slice funded with reverse Model 4 max backing",
    300n,
    model4.startWeth
  );
  printSummary("Reverse Model 5", model5.payload);

  const model6 = await runReverseModel3Like(
    "model-v4-reverse-model6-openflow-300x",
    "Historical ETH 1m replay in reverse order, 300x open-flow with reverse Model 4 max backing and 10 concurrent trades",
    300n,
    model4.startWeth
  );
  printSummary("Reverse Model 6", model6.payload);
  console.log("==================================================");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

