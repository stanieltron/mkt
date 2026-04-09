"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { MakeitV4Model, USDC_SCALE, E18, fmtUSDC6, fmtWETH18 } = require("./makeitv4");
const { writeScenarioResult } = require("../common/result-writer");

const DATA_DIR = path.resolve(__dirname, "..", "..", "temp_binance");
const GROSS_MARGIN_USDC = 10n * USDC_SCALE;
const LEVERAGE = 100n;
const PROFIT_TARGET_PPM = 1_000_000n;

function fmtPrice(v) {
  return Number(v).toFixed(2);
}

function fmtPct(value) {
  return `${value.toFixed(2)}%`;
}

function normalizeTimestampUs(raw) {
  const ts = BigInt(raw);
  // Older Binance monthly files in this archive use milliseconds, newer ones microseconds.
  return ts < 10_000_000_000_000n ? ts * 1000n : ts;
}

function toIsoMinute(usMicro) {
  const ms = Number(normalizeTimestampUs(usMicro) / 1000n);
  return new Date(ms).toISOString();
}

function median(sorted) {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
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
    if (line.trim().length === 0) continue;
    yield line;
  }

  const exitCode = await new Promise((resolve) => ps.on("close", resolve));
  if (exitCode !== 0) {
    throw new Error(`failed to stream zip ${path.basename(zipPath)}: ${stderr.trim() || `exit ${exitCode}`}`);
  }
}

async function runHistoricalReplay() {
  const dex = new MakeitV4Model({ owner: "owner" });
  dex.setFeeSplitPpm("owner", 70n, 30n);

  const netMarginUsdc = dex._tradeMarginUSDC(GROSS_MARGIN_USDC, LEVERAGE);
  const totalFeeUsdc = dex._totalFeeAmountUSDC(GROSS_MARGIN_USDC, LEVERAGE);
  const protocolFeeUsdc = dex._protocolFeeAmountUSDC(GROSS_MARGIN_USDC, LEVERAGE);
  const lpFeeUsdc = totalFeeUsdc - protocolFeeUsdc;
  const notionalUsdc = netMarginUsdc * LEVERAGE;

  const stats = {
    dataset: {
      files: 0,
      firstMinute: null,
      lastMinute: null,
      candlesProcessed: 0,
    },
    config: {
      grossMarginUSDC: GROSS_MARGIN_USDC,
      netMarginUSDC: netMarginUsdc,
      totalFeeUSDC: totalFeeUsdc,
      protocolFeeUSDC: protocolFeeUsdc,
      lpFeeUSDC: lpFeeUsdc,
      leverage: LEVERAGE,
      notionalUSDC: notionalUsdc,
      profitTargetPpm: PROFIT_TARGET_PPM,
      assumptions: {
        side: "LONG_ONLY",
        openRule: "open at candle open after previous trade is closed",
        liquidationRule: "first future candle whose high hits TP or low hits SL",
        ambiguousHitRule: "SL first if TP and SL are both inside the same candle",
        capacityRule: "always allow opening; track required ETH backing separately",
      },
    },
    tradesOpened: 0,
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
    maxRequiredUSDC: notionalUsdc,
    maxActualUsdcEquivalentFromWethBacking: 0n,
  };

  const durations = [];

  let openTrade = null;
  let pendingOpenNextCandle = true;

  for (const zipPath of listHistoricalZipFiles()) {
    stats.dataset.files++;

    for await (const line of streamZipCsvLines(zipPath)) {
      const candle = parseCandle(line);
      if (!candle) continue;

      stats.dataset.candlesProcessed++;
      if (stats.dataset.firstMinute === null) stats.dataset.firstMinute = candle.openTimeUs;
      stats.dataset.lastMinute = candle.openTimeUs;

      if (openTrade) {
        const hitTP = candle.high >= openTrade.tpPrice;
        const hitSL = candle.low <= openTrade.slPrice;

        if (hitTP || hitSL) {
          const bothHit = hitTP && hitSL;
          if (bothHit) stats.ambiguousBothHitCount++;

          const status = hitSL ? "SL" : "TP";
          const durationMinutes = Number((candle.openTimeUs - openTrade.openTimeUs) / 60000000n);
          durations.push(durationMinutes);
          stats.totalDurationMinutes += durationMinutes;
          stats.tradesOpened++;
          stats.totalGrossFeesUSDC += totalFeeUsdc;
          stats.totalProtocolFeesUSDC += protocolFeeUsdc;
          stats.totalLpFeesUSDC += lpFeeUsdc;

          if (status === "TP") {
            stats.tpCount++;
            stats.totalTraderPnlUSDC += netMarginUsdc;
            stats.totalProtocolTradePnlUSDC -= netMarginUsdc;
          } else {
            stats.slCount++;
            stats.totalTraderPnlUSDC -= netMarginUsdc;
            stats.totalProtocolTradePnlUSDC += netMarginUsdc;
          }

          openTrade = null;
          pendingOpenNextCandle = true;
        }
      }

      if (!openTrade && pendingOpenNextCandle) {
        const entryPrice = candle.open;
        if (entryPrice > 0) {
          const entryPriceE18 = BigInt(Math.round(entryPrice * 1e18));
          const { tp, sl } = dex._levelsLong(entryPriceE18, PROFIT_TARGET_PPM, LEVERAGE);
          const requiredWETH = dex._wethFromUsdcCeil(notionalUsdc, entryPriceE18);
          const actualUsdcEquivalent = dex._usdcFromWeth(requiredWETH, entryPriceE18);

          if (requiredWETH > stats.maxRequiredWETH) {
            stats.maxRequiredWETH = requiredWETH;
            stats.maxRequiredWETHAtOpenTimeUs = candle.openTimeUs;
            stats.maxRequiredWETHAtPrice = entryPrice;
            stats.maxActualUsdcEquivalentFromWethBacking = actualUsdcEquivalent;
          }

          openTrade = {
            openTimeUs: candle.openTimeUs,
            entryPrice,
            tpPrice: Number(tp) / 1e18,
            slPrice: Number(sl) / 1e18,
          };
          pendingOpenNextCandle = false;
        }
      }
    }
  }

  const closedTrades = stats.tpCount + stats.slCount;
  const sortedDurations = durations.slice().sort((a, b) => a - b);

  const payload = {
    model: "v4",
    scenarioType: "historical-replay-one-slice",
    scenarioLabel: "Historical ETH 1m replay, one sequential 100x long slice",
    dataset: {
      files: stats.dataset.files,
      candlesProcessed: stats.dataset.candlesProcessed,
      firstMinuteIso: stats.dataset.firstMinute ? toIsoMinute(stats.dataset.firstMinute) : null,
      lastMinuteIso: stats.dataset.lastMinute ? toIsoMinute(stats.dataset.lastMinute) : null,
    },
    config: {
      grossMarginUSDC: fmtUSDC6(GROSS_MARGIN_USDC),
      netMarginUSDC: fmtUSDC6(netMarginUsdc),
      totalFeeUSDC: fmtUSDC6(totalFeeUsdc),
      protocolFeeUSDC: fmtUSDC6(protocolFeeUsdc),
      lpFeeUSDC: fmtUSDC6(lpFeeUsdc),
      leverage: Number(LEVERAGE),
      notionalUSDC: fmtUSDC6(notionalUsdc),
      tpMovePct: "1.00%",
      slMovePct: "1.00%",
      assumptions: stats.config.assumptions,
    },
    results: {
      tradesClosed: closedTrades,
      tpCount: stats.tpCount,
      slCount: stats.slCount,
      tpRatePct: closedTrades ? (stats.tpCount * 100) / closedTrades : 0,
      slRatePct: closedTrades ? (stats.slCount * 100) / closedTrades : 0,
      ambiguousBothHitCount: stats.ambiguousBothHitCount,
      totalTraderPnlUSDC: fmtUSDC6(stats.totalTraderPnlUSDC),
      totalProtocolTradePnlUSDC: fmtUSDC6(stats.totalProtocolTradePnlUSDC),
      totalGrossFeesUSDC: fmtUSDC6(stats.totalGrossFeesUSDC),
      totalProtocolFeesUSDC: fmtUSDC6(stats.totalProtocolFeesUSDC),
      totalLpFeesUSDC: fmtUSDC6(stats.totalLpFeesUSDC),
      netProtocolEconomicsUSDC: fmtUSDC6(stats.totalProtocolTradePnlUSDC + stats.totalGrossFeesUSDC),
      avgDurationMinutes: closedTrades ? stats.totalDurationMinutes / closedTrades : 0,
      medianDurationMinutes: median(sortedDurations),
      p95DurationMinutes: percentile(sortedDurations, 0.95),
      maxRequiredWETH: fmtWETH18(stats.maxRequiredWETH),
      maxRequiredUSDC: fmtUSDC6(stats.maxRequiredUSDC),
      maxActualUsdcEquivalentFromWethBacking: fmtUSDC6(stats.maxActualUsdcEquivalentFromWethBacking),
      maxRequiredWETHAtPrice: fmtPrice(stats.maxRequiredWETHAtPrice),
      maxRequiredWETHAtOpenTimeIso: stats.maxRequiredWETHAtOpenTimeUs ? toIsoMinute(stats.maxRequiredWETHAtOpenTimeUs) : null,
    },
  };

  const scenarioName = "model-v4-historical-one-slice-100x";
  const filePath = writeScenarioResult({ scenarioName, payload });

  console.log("==================================================");
  console.log("Historical Replay: one sequential 100x long slice");
  console.log(`dataset files:              ${payload.dataset.files}`);
  console.log(`candles processed:          ${payload.dataset.candlesProcessed}`);
  console.log(`range:                      ${payload.dataset.firstMinuteIso} -> ${payload.dataset.lastMinuteIso}`);
  console.log("");
  console.log(`gross margin:               ${payload.config.grossMarginUSDC} USDC`);
  console.log(`net margin:                 ${payload.config.netMarginUSDC} USDC`);
  console.log(`notional:                   ${payload.config.notionalUSDC} USDC`);
  console.log(`gross fee / trade:          ${payload.config.totalFeeUSDC} USDC`);
  console.log("");
  console.log(`trades closed:              ${payload.results.tradesClosed}`);
  console.log(`TP / SL:                    ${payload.results.tpCount} / ${payload.results.slCount} (${fmtPct(payload.results.tpRatePct)} / ${fmtPct(payload.results.slRatePct)})`);
  console.log(`ambiguous candles:          ${payload.results.ambiguousBothHitCount}`);
  console.log(`avg / median / p95 mins:    ${payload.results.avgDurationMinutes.toFixed(2)} / ${payload.results.medianDurationMinutes} / ${payload.results.p95DurationMinutes}`);
  console.log("");
  console.log(`trader PnL:                 ${payload.results.totalTraderPnlUSDC} USDC`);
  console.log(`protocol trade PnL:         ${payload.results.totalProtocolTradePnlUSDC} USDC`);
  console.log(`gross fees:                 ${payload.results.totalGrossFeesUSDC} USDC`);
  console.log(`protocol fees:              ${payload.results.totalProtocolFeesUSDC} USDC`);
  console.log(`LP fees:                    ${payload.results.totalLpFeesUSDC} USDC`);
  console.log(`net protocol economics:     ${payload.results.netProtocolEconomicsUSDC} USDC`);
  console.log("");
  console.log(`max required WETH backing:  ${payload.results.maxRequiredWETH} WETH`);
  console.log(`max required USDC backing:  ${payload.results.maxRequiredUSDC} USDC`);
  console.log(`USDC equiv of ceil WETH:    ${payload.results.maxActualUsdcEquivalentFromWethBacking} USDC`);
  console.log(`at price / time:            ${payload.results.maxRequiredWETHAtPrice} / ${payload.results.maxRequiredWETHAtOpenTimeIso}`);
  console.log(`result file:                ${filePath}`);
  console.log("==================================================");
}

runHistoricalReplay().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
