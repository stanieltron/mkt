"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { MakeitV4Model, USDC_SCALE, E18, fmtUSDC6, fmtWETH18, fmtPriceE18 } = require("./makeitv4");
const { writeScenarioResult } = require("../common/result-writer");

const DATA_DIR = path.resolve(__dirname, "binance-data");
const GROSS_MARGIN_USDC = 10n * USDC_SCALE;
const LEVERAGE = 100n;
const PROFIT_TARGET_PPM = 1_000_000n;
const START_WETH = 12n * E18;
const MAX_CONCURRENT_TRADES = 10;
const MAX_CANDLES = (() => {
  const raw = process.env.MAX_CANDLES;
  if (!raw) return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error("MAX_CANDLES must be a positive integer");
  return n;
})();

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

function listHistoricalZipFiles() {
  return fs
    .readdirSync(DATA_DIR)
    .filter((name) => /^ETHUSDT-1m-\d{4}-\d{2}\.zip$/i.test(name))
    .sort()
    .map((name) => path.join(DATA_DIR, name));
}

async function* streamZipCsvLines(zipPath) {
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
  for await (const line of rl) {
    if (line.trim()) yield line;
  }

  const exitCode = await new Promise((resolve) => ps.on("close", resolve));
  if (exitCode !== 0) {
    throw new Error(`failed to stream zip ${path.basename(zipPath)}: ${stderr.trim() || `exit ${exitCode}`}`);
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

async function runHistoricalReplayModel3() {
  const dex = new MakeitV4Model({ owner: "owner" });
  dex.setFeeSplitPpm("owner", 70n, 30n);
  dex.mintWETH("owner", START_WETH);
  dex.fundETH("owner", START_WETH);
  dex.mintUSDC("longTrader", 50_000_000n * USDC_SCALE);
  dex.mintUSDC("shortTrader", 50_000_000n * USDC_SCALE);

  const netMarginUsdc = dex._tradeMarginUSDC(GROSS_MARGIN_USDC, LEVERAGE);
  const totalFeeUsdc = dex._totalFeeAmountUSDC(GROSS_MARGIN_USDC, LEVERAGE);
  const protocolFeeUsdc = dex._protocolFeeAmountUSDC(GROSS_MARGIN_USDC, LEVERAGE);
  const lpFeeUsdc = totalFeeUsdc - protocolFeeUsdc;
  const notionalUsdc = netMarginUsdc * LEVERAGE;

  const stats = {
    datasetFiles: 0,
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

  for (const zipPath of listHistoricalZipFiles()) {
    stats.datasetFiles++;

    for await (const line of streamZipCsvLines(zipPath)) {
      const candle = parseCandle(line);
      if (!candle) continue;

      stats.candlesProcessed++;
      if (stats.candlesProcessed > MAX_CANDLES) break;
      if (stats.firstMinuteUs === null) {
        stats.firstMinuteUs = candle.openTimeUs;
        startPriceE18 = BigInt(Math.round(candle.open * 1e18));
      }
      stats.lastMinuteUs = candle.openTimeUs;
      endPriceE18 = BigInt(Math.round(candle.close * 1e18));

      // 1. Liquidate any already-open trades using this candle.
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
        dex.setMockPriceE18("owner", liquidationPriceE18);
        const result = dex.liquidateTrade("liquidator", live.tradeId);
        liveTrades.splice(idx, 1);

        const durationMinutes = Number((candle.openTimeUs - live.openTimeUs) / 60000000n);
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

      // 2. Open at this candle open. New trades only become eligible starting next candle.
      const entryPriceE18 = BigInt(Math.round(candle.open * 1e18));
      dex.setMockPriceE18("owner", entryPriceE18);

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
          const longId = dex.openLongTrade("longTrader", entryPriceE18, 0, PROFIT_TARGET_PPM, LEVERAGE, GROSS_MARGIN_USDC);
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
          const shortId = dex.openShortTrade("shortTrader", entryPriceE18, 0, PROFIT_TARGET_PPM, LEVERAGE, GROSS_MARGIN_USDC);
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

    if (stats.candlesProcessed >= MAX_CANDLES) break;
  }

  const endUSDC = dex.balanceUSDC(dex.dexAddress);
  const endWETH = dex.balanceWETH(dex.dexAddress);
  const startEquity = usdcValueOfWeth(START_WETH, startPriceE18);
  const endEquity = endUSDC + usdcValueOfWeth(endWETH, endPriceE18);
  const holdOnlyEnd = usdcValueOfWeth(START_WETH, endPriceE18);

  const longSorted = longDurations.slice().sort((a, b) => a - b);
  const shortSorted = shortDurations.slice().sort((a, b) => a - b);
  const tradesClosed = stats.closedLongTp + stats.closedLongSl + stats.closedShortTp + stats.closedShortSl;

  const payload = {
    model: "v4",
    scenarioType: "historical-replay-model3-openflow",
    scenarioLabel: "Historical ETH 1m replay, 12 WETH pool, open long every minute if possible and open short every minute if offset exists",
    dataset: {
      files: stats.datasetFiles,
      candlesProcessed: stats.candlesProcessed,
      firstMinuteIso: stats.firstMinuteUs ? toIsoMinute(stats.firstMinuteUs) : null,
      lastMinuteIso: stats.lastMinuteUs ? toIsoMinute(stats.lastMinuteUs) : null,
    },
    config: {
      startWETH: fmtWETH18(START_WETH),
      grossMarginUSDC: fmtUSDC6(GROSS_MARGIN_USDC),
      netMarginUSDC: fmtUSDC6(netMarginUsdc),
      totalFeeUSDC: fmtUSDC6(totalFeeUsdc),
      protocolFeeUSDC: fmtUSDC6(protocolFeeUsdc),
      lpFeeUSDC: fmtUSDC6(lpFeeUsdc),
      leverage: Number(LEVERAGE),
      notionalUSDC: fmtUSDC6(notionalUsdc),
      openingPolicy: {
        longs: "attempt one new 100x long at every candle open",
        shorts: "attempt one new 100x short at every candle open only if offset is available",
        liquidation: "existing trades checked against current candle high/low; SL first if both hit",
        sameCandleEligibility: "newly opened trades become eligible starting next candle",
        maxConcurrentTrades: MAX_CONCURRENT_TRADES,
      },
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
      maxRequiredWETHAtPrice: Number(stats.maxRequiredWETHAtPrice).toFixed(2),
      maxRequiredWETHAtOpenTimeIso: stats.maxRequiredWETHAtOpenTimeUs ? toIsoMinute(stats.maxRequiredWETHAtOpenTimeUs) : null,
    },
  };

  const filePath = writeScenarioResult({
    scenarioName: "model-v4-historical-model3-openflow-100x-12weth",
    payload,
  });

  console.log("==================================================");
  console.log("Historical Replay Model3: multi-open long/short flow");
  console.log(`dataset files:              ${payload.dataset.files}`);
  console.log(`candles processed:          ${payload.dataset.candlesProcessed}`);
  console.log(`range:                      ${payload.dataset.firstMinuteIso} -> ${payload.dataset.lastMinuteIso}`);
  console.log("");
  console.log(`start WETH:                 ${payload.results.startWETH} WETH`);
  console.log(`start pool value:           ${payload.results.startPoolValueUSD} USDC`);
  console.log(`end WETH:                   ${payload.results.endWETH} WETH`);
  console.log(`end USDC:                   ${payload.results.endUSDC} USDC`);
  console.log(`end pool value:             ${payload.results.endPoolValueUSD} USDC`);
  console.log(`hold-only end value:        ${payload.results.holdOnlyEndValueUSD} USDC`);
  console.log(`pool vs hold:               ${payload.results.poolVsHoldUSD} USDC`);
  console.log("");
  console.log(`opened longs / shorts:      ${stats.openedLongs} / ${stats.openedShorts}`);
  console.log(`closed long TP / SL:        ${stats.closedLongTp} / ${stats.closedLongSl}`);
  console.log(`closed short TP / SL:       ${stats.closedShortTp} / ${stats.closedShortSl}`);
  console.log(`long fail no capacity:      ${stats.longOpenFailInsufficientEthCoverage}`);
  console.log(`short fail no offset:       ${stats.shortOpenFailNoLongOffset}`);
  console.log(`max simultaneous opens:     ${stats.maxSimultaneousOpenTrades}`);
  console.log(`avg long mins:              ${payload.results.avgLongDurationMinutes.toFixed(2)} / median ${payload.results.medianLongDurationMinutes} / p95 ${payload.results.p95LongDurationMinutes}`);
  console.log(`avg short mins:             ${payload.results.avgShortDurationMinutes.toFixed(2)} / median ${payload.results.medianShortDurationMinutes} / p95 ${payload.results.p95ShortDurationMinutes}`);
  console.log(`protocol trade PnL:         ${payload.results.totalProtocolTradePnlUSDC} USDC`);
  console.log(`protocol fees accrued:      ${payload.results.protocolFeesAccruedUSDC} USDC`);
  console.log(`max required WETH backing:  ${payload.results.maxRequiredWETH} WETH`);
  console.log(`at price / time:            ${payload.results.maxRequiredWETHAtPrice} / ${payload.results.maxRequiredWETHAtOpenTimeIso}`);
  console.log(`result file:                ${filePath}`);
  console.log("==================================================");
}

runHistoricalReplayModel3().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

