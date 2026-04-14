"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { MakeitV4Model, USDC_SCALE, E18, fmtUSDC6, fmtWETH18, fmtPriceE18 } = require("./makeitv4");
const { writeScenarioResult } = require("../common/result-writer");

const DATA_DIR = path.resolve(__dirname, "binance-data");
const GROSS_MARGIN_USDC = 10n * USDC_SCALE;
const LEVERAGE = 300n;
const PROFIT_TARGET_PPM = 1_000_000n;
const START_WETH = 36n * E18;

function normalizeTimestampUs(raw) {
  const ts = BigInt(raw);
  return ts < 10_000_000_000_000n ? ts * 1000n : ts;
}

function toIsoMinute(usMicro) {
  return new Date(Number(normalizeTimestampUs(usMicro) / 1000n)).toISOString();
}

function fmtPrice(v) {
  return Number(v).toFixed(2);
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

async function runHistoricalReplayModel5() {
  const dex = new MakeitV4Model({ owner: "owner" });
  dex.setFeeSplitPpm("owner", 70n, 30n);
  dex.mintWETH("owner", START_WETH);
  dex.fundETH("owner", START_WETH);
  dex.mintUSDC("trader", 10_000_000n * USDC_SCALE);

  const netMarginUsdc = dex._tradeMarginUSDC(GROSS_MARGIN_USDC, LEVERAGE);
  const totalFeeUsdc = dex._totalFeeAmountUSDC(GROSS_MARGIN_USDC, LEVERAGE);
  const protocolFeeUsdc = dex._protocolFeeAmountUSDC(GROSS_MARGIN_USDC, LEVERAGE);
  const lpFeeUsdc = totalFeeUsdc - protocolFeeUsdc;

  const stats = {
    datasetFiles: 0,
    candlesProcessed: 0,
    firstMinuteUs: null,
    lastMinuteUs: null,
    openedTrades: 0,
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

  for (const zipPath of listHistoricalZipFiles()) {
    stats.datasetFiles++;

    for await (const line of streamZipCsvLines(zipPath)) {
      const candle = parseCandle(line);
      if (!candle) continue;

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
          const bothHit = hitTP && hitSL;
          if (bothHit) stats.ambiguousBothHitCount++;

          const liquidationPriceE18 = hitSL ? openTrade.slPriceE18 : openTrade.tpPriceE18;
          dex.setMockPriceE18("owner", liquidationPriceE18);
          const result = dex.liquidateTrade("liquidator", openTrade.tradeId);

          stats.openedTrades++;
          if (result.status === "CLOSED_TP") stats.tpCount++;
          else stats.slCount++;
          stats.totalTradePnlUSDC -= result.tradePnlUSDC;

          const durationMinutes = Number((candle.openTimeUs - openTrade.openTimeUs) / 60000000n);
          durations.push(durationMinutes);
          stats.totalDurationMinutes += durationMinutes;

          openTrade = null;
          pendingOpenNextCandle = true;
        }
      }

      if (!openTrade && pendingOpenNextCandle) {
        const entryPriceE18 = BigInt(Math.round(candle.open * 1e18));
        dex.setMockPriceE18("owner", entryPriceE18);
        const requiredWETH = dex._wethFromUsdcCeil(netMarginUsdc * LEVERAGE, entryPriceE18);
        if (requiredWETH > stats.maxRequiredWETH) {
          stats.maxRequiredWETH = requiredWETH;
          stats.maxRequiredWETHAtPrice = candle.open;
          stats.maxRequiredWETHAtOpenTimeUs = candle.openTimeUs;
        }

        const tradeId = dex.openLongTrade("trader", entryPriceE18, 0, PROFIT_TARGET_PPM, LEVERAGE, GROSS_MARGIN_USDC);
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
  }

  const endUSDC = dex.balanceUSDC(dex.dexAddress);
  const endWETH = dex.balanceWETH(dex.dexAddress);
  const startWETH = START_WETH;
  const startEquity = usdcValueOfWeth(startWETH, startPriceE18);
  const endEquity = endUSDC + usdcValueOfWeth(endWETH, endPriceE18);
  const holdOnlyEnd = usdcValueOfWeth(startWETH, endPriceE18);

  const sortedDurations = durations.slice().sort((a, b) => a - b);

  const payload = {
    model: "v4",
    scenarioType: "historical-replay-model5-one-slice",
    scenarioLabel: "Historical ETH 1m replay, one sequential 300x long slice, protocol funded with 36 WETH",
    dataset: {
      files: stats.datasetFiles,
      candlesProcessed: stats.candlesProcessed,
      firstMinuteIso: stats.firstMinuteUs ? toIsoMinute(stats.firstMinuteUs) : null,
      lastMinuteIso: stats.lastMinuteUs ? toIsoMinute(stats.lastMinuteUs) : null,
    },
    config: {
      startWETH: fmtWETH18(startWETH),
      grossMarginUSDC: fmtUSDC6(GROSS_MARGIN_USDC),
      netMarginUSDC: fmtUSDC6(netMarginUsdc),
      totalFeeUSDC: fmtUSDC6(totalFeeUsdc),
      protocolFeeUSDC: fmtUSDC6(protocolFeeUsdc),
      lpFeeUSDC: fmtUSDC6(lpFeeUsdc),
      leverage: Number(LEVERAGE),
      notionalUSDC: fmtUSDC6(netMarginUsdc * LEVERAGE),
      tpMovePct: "0.33%",
      slMovePct: "0.33%",
    },
    results: {
      tradesClosed: stats.openedTrades,
      tpCount: stats.tpCount,
      slCount: stats.slCount,
      tpRatePct: stats.openedTrades ? (stats.tpCount * 100) / stats.openedTrades : 0,
      slRatePct: stats.openedTrades ? (stats.slCount * 100) / stats.openedTrades : 0,
      ambiguousBothHitCount: stats.ambiguousBothHitCount,
      avgDurationMinutes: stats.openedTrades ? stats.totalDurationMinutes / stats.openedTrades : 0,
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

  const filePath = writeScenarioResult({
    scenarioName: "model-v4-historical-model5-one-slice-300x-36weth",
    payload,
  });

  console.log("==================================================");
  console.log("Historical Replay Model5: one sequential 300x long slice");
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
  console.log(`trades closed:              ${payload.results.tradesClosed}`);
  console.log(`TP / SL:                    ${stats.tpCount} / ${stats.slCount} (${fmtPct(payload.results.tpRatePct)} / ${fmtPct(payload.results.slRatePct)})`);
  console.log(`avg / median / p95 mins:    ${payload.results.avgDurationMinutes.toFixed(2)} / ${payload.results.medianDurationMinutes} / ${payload.results.p95DurationMinutes}`);
  console.log(`protocol trade PnL:         ${payload.results.totalProtocolTradePnlUSDC} USDC`);
  console.log(`protocol fees accrued:      ${payload.results.protocolFeesAccruedUSDC} USDC`);
  console.log(`max required WETH backing:  ${payload.results.maxRequiredWETH} WETH`);
  console.log(`at price / time:            ${payload.results.maxRequiredWETHAtPrice} / ${payload.results.maxRequiredWETHAtOpenTimeIso}`);
  console.log(`result file:                ${filePath}`);
  console.log("==================================================");
}

runHistoricalReplayModel5().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

