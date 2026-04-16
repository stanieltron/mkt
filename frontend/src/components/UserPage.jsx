import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, MaxUint256, formatUnits, parseUnits } from "ethers";
import PriceChart from "./PriceChart";
import { ACTIVE_NETWORK } from "../config/contracts";
import { MAKEIT_ABI } from "../abi/makeit";
import { ORACLE_ABI } from "../abi/oracle";
import { ERC20_ABI } from "../abi/erc20";
import { apiGet, apiPost } from "../lib/api";

const RANGE_OPTIONS = ["15m", "1h", "6h", "1d"];
const TRADE_PRESETS = [
  { id: "a", pace: "normal", leverage: 100 },
  { id: "b", pace: "fast", leverage: 200 },
  { id: "c", pace: "faster", leverage: 300 },
];
const PROFIT_TARGET_OPTIONS = [5, 10, 20, 30];
const RANGE_WINDOW_SECONDS = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "1d": 24 * 60 * 60,
};
const OPEN_TRADE_TOLERANCE_BPS = 150;
const PROFIT_PPM_SCALE = 1_000_000n;
const REFERRAL_PENDING_KEY = "willgo.pending_referral_code";
const REFERRAL_REFRESH_INTERVAL_MS = 20_000;
const ONCHAIN_PROTOCOL_POLL_MS = 10_000;
const QUOTE_TOKEN_DECIMALS = Number(ACTIVE_NETWORK.usdcDecimals || 6);

function fmt(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizeReferralCode(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 32);
}

function decodeTxErrorMessage(err) {
  const text = String(err?.shortMessage || err?.message || err || "");
  const revertData =
    err?.data ||
    err?.info?.error?.data ||
    err?.error?.data ||
    err?.error?.error?.data ||
    "";
  const combined = `${text} ${String(revertData || "")}`;
  if (combined.includes("0x7939f424")) {
    return "USD transfer failed. Approve USD first, and make sure the wallet has enough USD balance.";
  }
  if (text.includes("MustUseLiquidation")) {
    return "TP/SL already hit; trade must be liquidated instead of early close.";
  }
  if (text.includes("PriceOutOfTolerance")) {
    return "Price moved outside tolerance. Retry the trade.";
  }
  if (text.includes("NoLongNotionalToOffsetShort")) {
    return "Short capacity is unavailable. Shorts require enough open long notional.";
  }
  if (text.includes("InsufficientEthCoverage")) {
    return "Pool has insufficient ETH coverage for that long trade.";
  }
  return text;
}

function usdc6ToNumber(value) {
  try {
    return Number(formatUnits(BigInt(value), QUOTE_TOKEN_DECIMALS));
  } catch {
    return 0;
  }
}

function fmtTokenUnits(rawValue, decimals = 18) {
  try {
    return Number(formatUnits(BigInt(rawValue || 0), Number(decimals || 18)));
  } catch {
    return 0;
  }
}

function fmtDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

function e18ToNumber(value) {
  try {
    return Number(formatUnits(BigInt(value), 18));
  } catch {
    return 0;
  }
}

function rawToBigInt(value) {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
}

function tradeMarginUsdc(trade) {
  return usdc6ToNumber(trade?.margin || 0);
}

function tradeEntryPriceUsdc(trade) {
  return e18ToNumber(trade?.entryPrice || 0);
}

function tradeTpPriceUsdc(trade) {
  return e18ToNumber(trade?.tpPrice || 0);
}

function tradeSlPriceUsdc(trade) {
  return e18ToNumber(trade?.slPrice || 0);
}

function tradeExitPriceUsdc(trade) {
  return e18ToNumber(trade?.exitPrice || 0);
}

function tradePnlUsdc(trade) {
  return usdc6ToNumber(trade?.pnl || 0);
}

function tradeBoughtEth(trade) {
  return e18ToNumber(trade?.boughtWeth || 0);
}

function tradeSoldEth(trade) {
  return e18ToNumber(trade?.soldWeth || 0);
}

function normalizeDisplayPrice(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  const raw = String(value).trim();
  if (!raw) return 0;

  // Decimal strings are treated as already human-readable prices.
  if (raw.includes(".") || raw.includes("e") || raw.includes("E")) {
    const direct = Number(raw);
    return Number.isFinite(direct) && direct > 0 ? direct : 0;
  }

  try {
    const asBigInt = BigInt(raw);
    const abs = asBigInt < 0n ? -asBigInt : asBigInt;

    // Most oracle values are E18-scaled ints; plain integer prices (e.g. "2000")
    // can exist in older rows and should not be scaled down to near-zero.
    if (abs >= 1_000_000_000_000n) {
      const scaled = Number(formatUnits(asBigInt, 18));
      return Number.isFinite(scaled) && scaled > 0 ? scaled : 0;
    }

    const direct = Number(asBigInt);
    return Number.isFinite(direct) && direct > 0 ? direct : 0;
  } catch {
    const fallback = Number(raw);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
  }
}

function closedStatusToLabel(status) {
  const value = Number(status);
  if (value === 1) return "CLOSED_TP";
  if (value === 2) return "CLOSED_SL";
  if (value === 3) return "CLOSED_EARLY";
  return "CLOSED";
}

function normalizeProtocolVariant(variant) {
  return "default";
}

function grossToNetMarginUsdc6(grossMarginUsdc6, totalFeePpm) {
  const gross = BigInt(grossMarginUsdc6 || 0n);
  const fee = (gross * BigInt(totalFeePpm || 0)) / PROFIT_PPM_SCALE;
  return gross - fee;
}

function targetProfitPpmForDesiredPnl(grossMarginUsdc6, totalFeePpm, desiredPnlUsdc) {
  const gross = BigInt(grossMarginUsdc6 || 0n);
  const feePpm = BigInt(totalFeePpm || 0n);
  if (gross <= 0n) return 1_000_000n;

  const fee = (gross * feePpm) / PROFIT_PPM_SCALE;
  const net = gross - fee;
  if (net <= 0n) return 1_000_000n;

  const desired = Number(desiredPnlUsdc || 0);
  const desiredPnl = desired > 0 ? BigInt(Math.round(desired * 1_000_000)) : gross;
  return (desiredPnl * PROFIT_PPM_SCALE + net - 1n) / net;
}

function scaledFeePpm(baseFeePpm, leverage, feeScaleFactorPpm) {
  const base = BigInt(baseFeePpm || 0n);
  const lev = BigInt(leverage || 0);
  const scale = BigInt(feeScaleFactorPpm || 0n);
  let multiplierPpm = 1_000_000n;
  if (lev >= 100n) {
    multiplierPpm += (scale * (lev - 100n)) / 100n;
  } else {
    const discountPpm = (scale * (100n - lev)) / 100n;
    multiplierPpm = discountPpm >= 1_000_000n ? 0n : 1_000_000n - discountPpm;
  }
  return (base * multiplierPpm) / 1_000_000n;
}

function totalFeePpmForTrade(baseFeePpm, leverage, feeScaleFactorPpm, protocolVariant) {
  const base = BigInt(baseFeePpm || 0n);
  const lev = BigInt(leverage || 0);
  if (base <= 0n || lev <= 0n) return 0n;

  // default protocol uses: fee = margin * leverage * baseFeePpm / 1e6
  if (normalizeProtocolVariant(protocolVariant) === "default") {
    return base * lev;
  }
  return scaledFeePpm(base, leverage, feeScaleFactorPpm);
}

function movePctForDisplay(tpPpm, leverage) {
  const ppm = Number(tpPpm || 0n);
  const lev = Number(leverage || 0);
  if (!Number.isFinite(ppm) || !Number.isFinite(lev) || lev <= 0) return "0%";
  const pct = ppm / 10_000 / lev;
  return `${fmt(pct, pct >= 1 ? 2 : 3)}%`;
}

function moveFractionFromPpm(tpPpm, leverage) {
  const ppm = Number(tpPpm || 0n);
  const lev = Number(leverage || 0);
  if (!Number.isFinite(ppm) || !Number.isFinite(lev) || lev <= 0) return 0;
  return ppm / 1_000_000 / lev;
}

function buildTradePreview(side, leverage, currentPrice, marginUsdc6, totalFeePpm, desiredPnlUsdc = 10) {
  const entryPrice = Number(currentPrice || 0);
  const grossMargin = usdc6ToNumber(marginUsdc6 || 0n);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(grossMargin) || grossMargin <= 0) {
    return null;
  }

  const totalFee = BigInt(totalFeePpm || 0n);
  const tpPpm = targetProfitPpmForDesiredPnl(marginUsdc6, totalFee, desiredPnlUsdc);
  const tpMoveFraction = moveFractionFromPpm(tpPpm, leverage);
  const slMoveFraction = 1 / Number(leverage || 1);
  const netMarginUsdc6 = grossToNetMarginUsdc6(marginUsdc6, totalFee);
  const netMarginUsdc = usdc6ToNumber(netMarginUsdc6);
  const feeUsdc = grossMargin - netMarginUsdc;
  const netProfitUsdc = netMarginUsdc * Number(tpPpm) / 1_000_000;
  const payoutUsdc = netMarginUsdc + netProfitUsdc;
  const notionalUsdc = grossMargin * Number(leverage || 0);
  const feePctOfNotional = notionalUsdc > 0 ? (feeUsdc / notionalUsdc) * 100 : 0;

  const tpPrice =
    side === "SHORT" ? entryPrice * (1 - tpMoveFraction) : entryPrice * (1 + tpMoveFraction);
  const slPrice =
    side === "SHORT" ? entryPrice * (1 + slMoveFraction) : entryPrice * (1 - slMoveFraction);

  return {
    side,
    leverage,
    entryPrice,
    tpPrice,
    slPrice,
    tpMovePct: tpMoveFraction * 100,
    slMovePct: slMoveFraction * 100,
    feeUsdc,
    feePctOfNotional,
    grossMarginUsdc: grossMargin,
    notionalUsdc,
    targetProfitUsdc: desiredPnlUsdc,
    takeProfitPnlUsdc: netProfitUsdc,
    stopLossPnlUsdc: grossMargin,
    payoutUsdc,
    requiredUsdc6: BigInt(marginUsdc6 || 0n).toString(),
  };
}

function resolvePreviewAtPrice(preview, currentPrice) {
  if (!preview) return null;
  const liveEntryPrice = Number(currentPrice || 0);
  if (!Number.isFinite(liveEntryPrice) || liveEntryPrice <= 0) return preview;

  const tpMoveFraction = Number(preview.tpMovePct || 0) / 100;
  const slMoveFraction = Number(preview.slMovePct || 0) / 100;
  const isShort = preview.side === "SHORT";
  const tpPrice = isShort
    ? liveEntryPrice * (1 - tpMoveFraction)
    : liveEntryPrice * (1 + tpMoveFraction);
  const slPrice = isShort
    ? liveEntryPrice * (1 + slMoveFraction)
    : liveEntryPrice * (1 - slMoveFraction);

  return {
    ...preview,
    entryPrice: liveEntryPrice,
    tpPrice,
    slPrice,
  };
}

function buildTradeChartLines(
  trade,
  {
    strong = false,
    includeEntry = false,
    titlePrefix = "",
    tpTitle = null,
    slTitle = null,
    tpCustomLabel = null,
    slCustomLabel = null,
    tpCustomLabelPosition = "above",
    slCustomLabelPosition = "below",
    compactLabel = false,
    showTpLabel = true,
    showSlLabel = true,
  } = {}
) {
  const entry = tradeEntryPriceUsdc(trade);
  const tp = tradeTpPriceUsdc(trade);
  const sl = tradeSlPriceUsdc(trade);
  const tradeId = String(trade?.onChainTradeId || "").trim();
  const prefix = titlePrefix || (tradeId ? `#${tradeId} ` : "");
  const lines = [];
  if (includeEntry && Number.isFinite(entry) && entry > 0) {
    lines.push({
      value: entry,
      color: strong ? "rgba(148, 182, 174, 0.95)" : "rgba(148, 182, 174, 0.4)",
      title: strong ? `${prefix}Entry` : "",
      lineWidth: strong ? 2 : 1,
      axisLabelVisible: strong,
    });
  }
  if (Number.isFinite(tp) && tp > 0) {
    const effectiveTpTitle = tpTitle ?? `${prefix}TP`;
    const tpPnl = tradeTpTargetPnlUsdc(trade);
    const tradeTag = tradeId ? `#${tradeId}` : "trade";
    const tpCompactLabel = compactLabel && showTpLabel ? `${tradeTag} + USD ${fmt(tpPnl, 2)} @ ${fmt(tp, 4)}` : tpCustomLabel;
    lines.push({
      value: tp,
      color: strong ? "rgba(42, 222, 134, 0.95)" : "rgba(42, 222, 134, 0.38)",
      title: compactLabel ? "" : effectiveTpTitle,
      lineWidth: strong ? 3 : 1,
      axisLabelVisible: compactLabel ? false : true,
      lastValueVisible: compactLabel ? false : true,
      customLabel: tpCompactLabel,
      customLabelPosition: tpCustomLabelPosition,
      customLabelSize: compactLabel ? "small" : undefined,
      customLabelOffset: compactLabel ? -10 : undefined,
    });
  }
  if (Number.isFinite(sl) && sl > 0) {
    const effectiveSlTitle = slTitle ?? `${prefix}SL`;
    const margin = tradeMarginUsdc(trade);
    const tradeTag = tradeId ? `#${tradeId}` : "trade";
    const slCompactLabel = compactLabel && showSlLabel ? `${tradeTag} - USD ${fmt(margin, 2)} @ ${fmt(sl, 4)}` : slCustomLabel;
    lines.push({
      value: sl,
      color: strong ? "rgba(255, 107, 99, 0.95)" : "rgba(255, 107, 99, 0.34)",
      title: compactLabel ? "" : effectiveSlTitle,
      lineWidth: strong ? 3 : 1,
      axisLabelVisible: compactLabel ? false : true,
      lastValueVisible: compactLabel ? false : true,
      customLabel: slCompactLabel,
      customLabelPosition: slCustomLabelPosition,
      customLabelSize: compactLabel ? "small" : undefined,
      customLabelOffset: compactLabel ? 10 : undefined,
    });
  }
  return lines;
}

function getErrorMessage(error) {
  return String(error?.message || error || "Unknown error");
}

function isBackendUnreachableError(error) {
  const message = getErrorMessage(error);
  return message.includes("Backend unreachable") || message.includes("Failed to fetch");
}

function mapTradeDirection(side) {
  return Number(side) === 1 ? "SHORT" : "LONG";
}

function getTradeDirection(trade) {
  return String(trade?.direction || "LONG").trim().toUpperCase() === "SHORT" ? "SHORT" : "LONG";
}

function logTxStarted(action, details = {}) {
  console.info(`[tx][${action}] started`, details);
}

function logTxSubmitted(action, txHash) {
  console.info(`[tx][${action}] submitted`, { txHash });
}

function logTxCompleted(action, receipt) {
  console.info(`[tx][${action}] completed`, {
    txHash: receipt?.hash || null,
    blockNumber: receipt?.blockNumber ?? null,
    status: receipt?.status ?? null,
  });
}

function logTxFailed(action, error) {
  console.error(`[tx][${action}] failed`, error);
}

function normalizeChartSeries(points, maxPoints = 9000) {
  const latestByTime = new Map();
  for (const item of points || []) {
    const time = Number(item?.time);
    const value = Number(item?.value);
    if (!Number.isFinite(time) || !Number.isFinite(value) || value <= 0) continue;
    latestByTime.set(time, { time, value });
  }

  const sorted = Array.from(latestByTime.values()).sort((a, b) => a.time - b.time);
  if (sorted.length <= maxPoints) return sorted;
  return sorted.slice(sorted.length - maxPoints);
}

function bucketSecondsForRange(range) {
  const windowSeconds = RANGE_WINDOW_SECONDS[range] || RANGE_WINDOW_SECONDS["1h"];
  const targetBuckets = 60;
  return Math.max(15, Math.floor(windowSeconds / targetBuckets));
}

function maxBucketsForRange(range) {
  const windowSeconds = RANGE_WINDOW_SECONDS[range] || RANGE_WINDOW_SECONDS["1h"];
  const bucketSeconds = bucketSecondsForRange(range);
  return Math.ceil(windowSeconds / bucketSeconds) + 2;
}

function aggregateToCloseTicks(points, range) {
  const bucketSeconds = bucketSecondsForRange(range);
  const latestByBucket = new Map();

  for (const point of points || []) {
    const time = Number(point?.time);
    const value = Number(point?.value);
    if (!Number.isFinite(time) || !Number.isFinite(value)) continue;
    const bucketTime = Math.floor(time / bucketSeconds) * bucketSeconds;
    const prev = latestByBucket.get(bucketTime);
    if (!prev || time >= prev.sourceTime) {
      latestByBucket.set(bucketTime, { time: bucketTime, value, sourceTime: time });
    }
  }

  const sorted = Array.from(latestByBucket.values())
    .sort((a, b) => a.time - b.time)
    .map(({ time, value }) => ({ time, value }));
  return normalizeChartSeries(sorted, maxBucketsForRange(range));
}

function upsertLiveCloseTick(prevTicks, livePoint, range) {
  const bucketSeconds = bucketSecondsForRange(range);
  const bucketTime = Math.floor(Number(livePoint.time) / bucketSeconds) * bucketSeconds;
  const value = Number(livePoint.value);
  if (!Number.isFinite(bucketTime) || !Number.isFinite(value)) return prevTicks || [];

  const ticks = [...(prevTicks || [])];
  if (ticks.length === 0) return [{ time: bucketTime, value }];

  const last = ticks[ticks.length - 1];
  if (last.time === bucketTime) {
    ticks[ticks.length - 1] = { time: bucketTime, value };
    return ticks;
  }
  if (last.time < bucketTime) {
    ticks.push({ time: bucketTime, value });
    return normalizeChartSeries(ticks, maxBucketsForRange(range));
  }

  const at = ticks.findIndex((item) => item.time === bucketTime);
  if (at >= 0) {
    ticks[at] = { time: bucketTime, value };
  } else {
    ticks.push({ time: bucketTime, value });
  }
  return normalizeChartSeries(ticks, maxBucketsForRange(range));
}

function computeLive(trade, currentPrice) {
  if (!currentPrice || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { pnl: 0 };
  }

  const entry = tradeEntryPriceUsdc(trade);
  const tp = tradeTpPriceUsdc(trade);
  const sl = tradeSlPriceUsdc(trade);
  const margin = tradeMarginUsdc(trade);
  const leverage = Number(trade.leverage);
  const notional = margin * leverage;
  const direction = getTradeDirection(trade);
  const tpTargetPnl =
    Number.isFinite(tp) && Number.isFinite(entry) && entry > 0
      ? Math.max(0, notional * (Math.abs(tp - entry) / entry))
      : margin;

  let pnl =
    direction === "SHORT"
      ? notional * ((entry - currentPrice) / entry)
      : notional * ((currentPrice - entry) / entry);
  if (pnl > tpTargetPnl) pnl = tpTargetPnl;
  if (pnl < -margin) pnl = -margin;

  return { pnl };
}

function tradeTpTargetPnlUsdc(trade) {
  const entry = tradeEntryPriceUsdc(trade);
  const tp = tradeTpPriceUsdc(trade);
  const margin = tradeMarginUsdc(trade);
  const leverage = Number(trade?.leverage || 0);
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    !Number.isFinite(tp) ||
    tp <= 0 ||
    !Number.isFinite(margin) ||
    margin <= 0 ||
    !Number.isFinite(leverage) ||
    leverage <= 0
  ) {
    return Math.max(0, margin || 0);
  }
  const notional = margin * leverage;
  return Math.max(0, notional * (Math.abs(tp - entry) / entry));
}

function hasTradePnl(trade) {
  const raw = trade?.pnl;
  if (raw === null || raw === undefined) return false;
  return String(raw).trim().length > 0;
}

function estimateTradePnlFromExitPrice(trade) {
  const entry = tradeEntryPriceUsdc(trade);
  const exit = tradeExitPriceUsdc(trade);
  const tp = tradeTpPriceUsdc(trade);
  const margin = tradeMarginUsdc(trade);
  const leverage = Number(trade.leverage || 0);
  const direction = getTradeDirection(trade);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit) || exit <= 0 || !Number.isFinite(margin) || margin <= 0 || !Number.isFinite(leverage) || leverage <= 0) {
    return 0;
  }

  const notional = margin * leverage;
  const tpTargetPnl =
    Number.isFinite(tp) && tp > 0
      ? Math.max(0, notional * (Math.abs(tp - entry) / entry))
      : margin;
  let pnl =
    direction === "SHORT"
      ? notional * ((entry - exit) / entry)
      : notional * ((exit - entry) / entry);
  if (pnl > tpTargetPnl) pnl = tpTargetPnl;
  if (pnl < -margin) pnl = -margin;
  return pnl;
}

function computeClosedPnl(trade) {
  if (hasTradePnl(trade)) return tradePnlUsdc(trade);
  return estimateTradePnlFromExitPrice(trade);
}

function computeClosedPayout(trade) {
  const margin = tradeMarginUsdc(trade);
  const pnl = computeClosedPnl(trade);
  if (!Number.isFinite(margin) || !Number.isFinite(pnl)) return 0;
  return Math.max(0, margin + pnl);
}

function closedStatusLabel(status) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "LIQUIDATED") return "Closed";
  if (normalized === "CLOSED") return "User Closed";
  return normalized || "Closed";
}

function grossMarginFromNetMarginUsdc(netMarginUsdc, totalFeePpm) {
  const net = Number(netMarginUsdc || 0);
  const feeRate = Number(totalFeePpm || 0n) / 1_000_000;
  if (!Number.isFinite(net) || net <= 0 || !Number.isFinite(feeRate) || feeRate <= 0 || feeRate >= 1) {
    return Math.max(0, net);
  }
  return net / (1 - feeRate);
}

function estimateOpenFeeUsdc(trade, baseTotalFeePpm, feeScaleFactorPpm, protocolVariant) {
  const netMarginUsdc = tradeMarginUsdc(trade);
  const leverage = Number(trade?.leverage || 0);
  const totalFeePpm = totalFeePpmForTrade(baseTotalFeePpm, leverage, feeScaleFactorPpm, protocolVariant);
  const grossMarginUsdc = grossMarginFromNetMarginUsdc(netMarginUsdc, totalFeePpm);
  return Math.max(0, grossMarginUsdc - netMarginUsdc);
}

function displayClosedPnlUsdc(trade, baseTotalFeePpm, feeScaleFactorPpm, protocolVariant) {
  let realizedPnl = computeClosedPnl(trade);
  const hasExit = tradeExitPriceUsdc(trade) > 0;
  const status = String(trade?.status || "").trim().toUpperCase();

  if (!hasTradePnl(trade) && !hasExit && status === "LIQUIDATED") {
    realizedPnl = estimateTradePnlFromExitPrice({
      ...trade,
      exitPrice: trade?.tpPrice ?? trade?.entryPrice,
    });
  }

  const openFee = estimateOpenFeeUsdc(trade, baseTotalFeePpm, feeScaleFactorPpm, protocolVariant);
  return realizedPnl - openFee;
}

function formatTradeTimestamp(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function explainClosedPnlMath(trade, baseTotalFeePpm, feeScaleFactorPpm, protocolVariant) {
  const side = getTradeDirection(trade);
  const entry = tradeEntryPriceUsdc(trade);
  const exit = tradeExitPriceUsdc(trade);
  const margin = tradeMarginUsdc(trade);
  const leverage = Number(trade?.leverage || 0);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit) || exit <= 0 || !Number.isFinite(margin) || margin <= 0 || !Number.isFinite(leverage) || leverage <= 0) {
    return "-";
  }

  const notional = margin * leverage;
  const movePct = side === "SHORT" ? ((entry - exit) / entry) * 100 : ((exit - entry) / entry) * 100;
  const moveExpr = side === "SHORT"
    ? `(${fmt(entry, 4)} - ${fmt(exit, 4)}) / ${fmt(entry, 4)}`
    : `(${fmt(exit, 4)} - ${fmt(entry, 4)}) / ${fmt(entry, 4)}`;
  const grossPnl = notional * (movePct / 100);
  const openFee = estimateOpenFeeUsdc(trade, baseTotalFeePpm, feeScaleFactorPpm, protocolVariant);
  const netPnl = grossPnl - openFee;

  return `${side} -> ${moveExpr} = ${fmt(movePct, 4)}%; ` +
    `notional ${fmt(notional, 2)} = margin ${fmt(margin, 2)} x lev ${leverage}; ` +
    `gross ${fmt(grossPnl, 2)} - open fee ${fmt(openFee, 2)} = net ${fmt(netPnl, 2)} USD`;
}

function closeReasonTag(trade) {
  const reason = String(trade?.closeReason || "").trim().toUpperCase();
  if (reason === "CLOSED_SL") return "SL";
  if (reason === "CLOSED_TP") return "TP";
  if (reason === "CLOSED_EARLY") return "EARLY";
  return "";
}

function closeTriggerPriceUsdc(trade) {
  const tag = closeReasonTag(trade);
  if (tag === "SL") return tradeSlPriceUsdc(trade);
  if (tag === "TP") return tradeTpPriceUsdc(trade);
  return NaN;
}

function closeOvershootText(trade) {
  const tag = closeReasonTag(trade);
  const trigger = closeTriggerPriceUsdc(trade);
  const exit = tradeExitPriceUsdc(trade);
  if (!tag || !Number.isFinite(trigger) || trigger <= 0 || !Number.isFinite(exit) || exit <= 0) return "";

  const side = getTradeDirection(trade);
  let overshoot = 0;
  if (tag === "SL") {
    overshoot = side === "SHORT" ? exit - trigger : trigger - exit;
  } else if (tag === "TP") {
    overshoot = side === "SHORT" ? trigger - exit : exit - trigger;
  }
  if (!Number.isFinite(overshoot) || overshoot <= 0) return "";

  const pct = (overshoot / trigger) * 100;
  return ` overshoot +${fmt(overshoot, 4)} (${fmt(pct, 4)}%)`;
}

function closeAtDisplay(trade) {
  const tag = closeReasonTag(trade);
  const trigger = closeTriggerPriceUsdc(trade);
  const exit = tradeExitPriceUsdc(trade);
  if (!Number.isFinite(exit) || exit <= 0) return "-";
  if (!tag || !Number.isFinite(trigger) || trigger <= 0) return fmt(exit, 3);
  return `${fmt(trigger, 2)} (${fmt(exit, 3)})`;
}

function settlementEthText(trade) {
  const bought = tradeBoughtEth(trade);
  const sold = tradeSoldEth(trade);
  if (Number.isFinite(bought) && bought > 0) return `Bought ${fmt(bought, 6)} ETH`;
  if (Number.isFinite(sold) && sold > 0) return `Sold ${fmt(sold, 6)} ETH`;
  return "-";
}

function computeTpSlBar(trade, currentPrice) {
  const entry = tradeEntryPriceUsdc(trade);
  const tp = tradeTpPriceUsdc(trade);
  const sl = tradeSlPriceUsdc(trade);
  const direction = getTradeDirection(trade);
  if (!Number.isFinite(entry) || !Number.isFinite(tp) || !Number.isFinite(sl) || entry <= 0) {
    return {
      zeroPct: 50,
      fillFromPct: 50,
      fillWidthPct: 0,
      direction: "neutral",
        signedPct: 0,
    };
  }

  const lower = Math.min(tp, sl);
  const upper = Math.max(tp, sl);
  const totalRange = upper - lower;
  const zeroRatio = totalRange > 0 ? clamp((entry - lower) / totalRange, 0, 1) : 0.5;

  let positionRatio = zeroRatio;
  if (Number.isFinite(currentPrice) && currentPrice > 0 && totalRange > 0) {
    positionRatio = clamp((currentPrice - lower) / totalRange, 0, 1);
  }

  const fillFromPct = Math.min(zeroRatio, positionRatio) * 100;
  const fillWidthPct = Math.abs(positionRatio - zeroRatio) * 100;
  let meterDirection = "neutral";
  if (direction === "SHORT") {
    if (positionRatio < zeroRatio - 1e-6) meterDirection = "tp";
    if (positionRatio > zeroRatio + 1e-6) meterDirection = "sl";
  } else {
    if (positionRatio > zeroRatio + 1e-6) meterDirection = "tp";
    if (positionRatio < zeroRatio - 1e-6) meterDirection = "sl";
  }

  let signedPct = 0;
  if (Number.isFinite(currentPrice) && currentPrice > 0) {
    if (direction === "SHORT") {
      if (currentPrice <= entry) {
        const tpRange = entry - tp;
        signedPct = tpRange > 0 ? clamp(((entry - currentPrice) / tpRange) * 100, 0, 100) : 0;
      } else {
        const slRange = sl - entry;
        signedPct = slRange > 0 ? -clamp(((currentPrice - entry) / slRange) * 100, 0, 100) : 0;
      }
    } else {
      if (currentPrice >= entry) {
        const tpRange = tp - entry;
        signedPct = tpRange > 0 ? clamp(((currentPrice - entry) / tpRange) * 100, 0, 100) : 0;
      } else {
        const slRange = entry - sl;
        signedPct = slRange > 0 ? -clamp(((entry - currentPrice) / slRange) * 100, 0, 100) : 0;
      }
    }
  }

  return {
    zeroPct: zeroRatio * 100,
    fillFromPct,
    fillWidthPct,
    direction: meterDirection,
    signedPct,
  };
}

function buildOptimisticOpenTrade(tradeOpenedArgs, side, receipt) {
  if (!tradeOpenedArgs) return null;
  return {
    id: `optimistic-${tradeOpenedArgs.tradeId.toString()}`,
    onChainTradeId: tradeOpenedArgs.tradeId.toString(),
    userId: null,
    direction: side,
    leverage: Number(tradeOpenedArgs.leverage),
    margin: tradeOpenedArgs.marginUSDC.toString(),
    entryPrice: tradeOpenedArgs.entryPriceE18.toString(),
    tpPrice: tradeOpenedArgs.tpPriceE18.toString(),
    slPrice: tradeOpenedArgs.slPriceE18.toString(),
    exitPrice: null,
    soldWeth: null,
    boughtWeth: null,
    status: "OPEN",
    pnl: null,
    createdAt: new Date().toISOString(),
    closedAt: null,
    transactionHash: receipt?.hash || null,
  };
}

function mergeOptimisticOpenTrade(prevTrades, optimisticTrade) {
  if (!optimisticTrade) return prevTrades || [];
  const tradeId = String(optimisticTrade.onChainTradeId);
  return [optimisticTrade, ...(prevTrades || []).filter((item) => String(item?.onChainTradeId) !== tradeId)];
}

function mergeSyncedAndOptimisticOpenTrades(syncedTrades, optimisticTrades, closedTrades = []) {
  const synced = Array.isArray(syncedTrades) ? syncedTrades : [];
  const optimistic = Array.isArray(optimisticTrades) ? optimisticTrades : [];
  const closedIds = new Set((closedTrades || []).map((trade) => String(trade?.onChainTradeId || "")));
  const syncedIds = new Set(synced.map((trade) => String(trade?.onChainTradeId || "")));
  const preservedOptimistic = optimistic.filter((trade) => {
    const id = String(trade?.onChainTradeId || "");
    return id && !syncedIds.has(id) && !closedIds.has(id);
  });
  return [...preservedOptimistic, ...synced];
}

function referralLikeVolumeToNumber(value) {
  return usdc6ToNumber(rawToBigInt(value));
}

export default function UserPage() {
  const readProvider = useMemo(() => new JsonRpcProvider(ACTIVE_NETWORK.rpcUrl), []);
  const oracleRead = useMemo(() => new Contract(ACTIVE_NETWORK.oracle, ORACLE_ABI, readProvider), [readProvider]);
  
  const activeProtocolVariant = ACTIVE_NETWORK.protocolVariant;
  const activeMakeitAddress = ACTIVE_NETWORK.makeit;
  const activeMakeitAbi = MAKEIT_ABI;
  const backendProtocolVariant = "default";

  const makeitRead = useMemo(() => {
    if (!activeMakeitAddress) return null;
    return new Contract(activeMakeitAddress, activeMakeitAbi, readProvider);
  }, [activeMakeitAddress, activeMakeitAbi, readProvider]);

  const [walletProvider, setWalletProvider] = useState(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [range, setRange] = useState("1h");
  const [chartData, setChartData] = useState([]);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [user, setUser] = useState(null);
  const [referrals, setReferrals] = useState(null);
  const [referralsUnavailable, setReferralsUnavailable] = useState(false);
  const [openTrades, setOpenTrades] = useState([]);
  const [closedTrades, setClosedTrades] = useState([]);
  const [optimisticOpenTrades, setOptimisticOpenTrades] = useState([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [usdcBalance, setUsdcBalance] = useState(0);
  const [usdcDecimals, setUsdcDecimals] = useState(QUOTE_TOKEN_DECIMALS);
  const [ethBalance, setEthBalance] = useState(0);
  const [faucetInfo, setFaucetInfo] = useState({ enabled: false });
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [faucetMessage, setFaucetMessage] = useState("");
  const [faucetTone, setFaucetTone] = useState("muted");
  const [pendingTrade, setPendingTrade] = useState(null);
  const [expandedTradeId, setExpandedTradeId] = useState(null);
  const [approvalPrompt, setApprovalPrompt] = useState(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalCustom, setApprovalCustom] = useState("");
  const [referralOpen, setReferralOpen] = useState(false);
  const [targetProfitUsdc, setTargetProfitUsdc] = useState(10);
  const [protocol, setProtocol] = useState({
    marginUsdc6: 0n,
    feeBps: 0,
    liquidityProvisionFeePpm: 0n,
    protocolFeePpm: 0n,
    feeScaleFactorPpm: 1_000_000n,
    usdcAddress: ACTIVE_NETWORK.usdc || "",
    openLongNotionalUsdc6: 0n,
    openShortNotionalUsdc6: 0n,
  });
  const [cachedV4FeeConfig, setCachedV4FeeConfig] = useState(() => ({
    liquidityProvisionFeePpm: BigInt(ACTIVE_NETWORK.v4FeeConfig?.liquidityProvisionFeePpm || 70),
    protocolFeePpm: BigInt(ACTIVE_NETWORK.v4FeeConfig?.protocolFeePpm || 30),
    feeScaleFactorPpm: BigInt(ACTIVE_NETWORK.v4FeeConfig?.feeScaleFactorPpm || 1_000_000),
  }));
  const [pendingReferralCode, setPendingReferralCode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = normalizeReferralCode(params.get("ref"));
    if (fromUrl) return fromUrl;
    return normalizeReferralCode(sessionStorage.getItem(REFERRAL_PENDING_KEY) || "");
  });
  const [manualReferralCode, setManualReferralCode] = useState("");
  const [manualReferralBusy, setManualReferralBusy] = useState(false);
  const referralFetchStateRef = useRef({
    unavailable: false,
    inFlight: false,
    lastAttemptAt: 0,
    wallet: "",
  });
  const wsRef = useRef(null);
  const wsReconnectTimerRef = useRef(null);
  const previousWalletAddressRef = useRef("");
  const approvalCardRef = useRef(null);

  const referralCodeFromUrl = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return normalizeReferralCode(params.get("ref"));
  }, []);

  useEffect(() => {
    if (!referralCodeFromUrl) return;
    sessionStorage.setItem(REFERRAL_PENDING_KEY, referralCodeFromUrl);
    setPendingReferralCode(referralCodeFromUrl);

    const url = new URL(window.location.href);
    if (url.searchParams.has("ref")) {
      url.searchParams.delete("ref");
      const next = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState({}, "", next);
    }
  }, [referralCodeFromUrl]);

  useEffect(() => {
    if (!approvalPrompt || !approvalCardRef.current) return;
    approvalCardRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [approvalPrompt]);

  useEffect(() => {
    let cancelled = false;
    apiGet("/api/config")
      .then((data) => {
        if (cancelled) return;
        setCachedV4FeeConfig({
          liquidityProvisionFeePpm: BigInt(Number(data?.feeConfig?.liquidityProvisionFeePpm || ACTIVE_NETWORK.v4FeeConfig?.liquidityProvisionFeePpm || 70)),
          protocolFeePpm: BigInt(Number(data?.feeConfig?.protocolFeePpm || ACTIVE_NETWORK.v4FeeConfig?.protocolFeePpm || 30)),
          feeScaleFactorPpm: BigInt(Number(data?.feeConfig?.feeScaleFactorPpm || ACTIVE_NETWORK.v4FeeConfig?.feeScaleFactorPpm || 1_000_000)),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const loadProtocol = useCallback(async () => {
    if (!makeitRead) return;
    const [openLongNotionalUsdc6, openShortNotionalUsdc6, usdcAddress] = await Promise.all([
      makeitRead.openLongNotionalUSDC(),
      makeitRead.openShortNotionalUSDC(),
      makeitRead.USDC()
    ]);
    setProtocol({
      marginUsdc6: 10_000_000n, // User requested 10 defaulted explicitly for ui frontend forwards
      feeBps: 0,
      liquidityProvisionFeePpm: cachedV4FeeConfig.liquidityProvisionFeePpm,
      protocolFeePpm: cachedV4FeeConfig.protocolFeePpm,
      feeScaleFactorPpm: 1_000_000n,
      usdcAddress,
      openLongNotionalUsdc6: BigInt(openLongNotionalUsdc6),
      openShortNotionalUsdc6: BigInt(openShortNotionalUsdc6),
    });
  }, [makeitRead, cachedV4FeeConfig]);

  const loadHistory = useCallback(
    async (selectedRange) => {
      const result = await apiGet(`/api/price/history?range=${selectedRange}`);
      const raw = result.samples.map((sample) => ({
        time: Math.floor(new Date(sample.timestamp).getTime() / 1000),
        value: normalizeDisplayPrice(sample.price),
      }));
      const next = aggregateToCloseTicks(raw, selectedRange);
      setChartData(next);
      if (next.length > 0) setCurrentPrice(next[next.length - 1].value);
    },
    []
  );

  const applyTradeSnapshot = useCallback((nextOpenTrades, nextClosedTrades) => {
    const syncedIds = new Set((nextOpenTrades || []).map((item) => String(item?.onChainTradeId || "")));
    const closedIds = new Set((nextClosedTrades || []).map((item) => String(item?.onChainTradeId || "")));
    setClosedTrades(nextClosedTrades || []);
    setOptimisticOpenTrades((prev) => {
      const filtered = prev.filter((trade) => {
        const id = String(trade?.onChainTradeId || "");
        return id && !syncedIds.has(id) && !closedIds.has(id);
      });
      setOpenTrades(mergeSyncedAndOptimisticOpenTrades(nextOpenTrades || [], filtered, nextClosedTrades || []));
      return filtered;
    });
  }, []);

  const applyLatestPrice = useCallback((latest) => {
    const value = normalizeDisplayPrice(latest?.price);
    if (!Number.isFinite(value) || value <= 0) return;
    const point = {
      time: Math.floor(new Date(latest?.timestamp || Date.now()).getTime() / 1000),
      value,
    };
    setCurrentPrice(value);
    setChartData((prev) => upsertLiveCloseTick(prev, point, range));
  }, [range]);

  const loadBootstrap = useCallback(async (wallet) => {
    if (!wallet) return;
    const boot = await apiGet(`/api/bootstrap?wallet=${wallet.toLowerCase()}`);
    applyLatestPrice(boot?.latestPrice || null);
    applyTradeSnapshot(boot?.openTrades || [], boot?.closedTrades || []);
    setReferrals((prev) => ({
      ...(prev || {}),
      totals: boot?.referralSummary || prev?.totals || {
        tier1Volume: "0",
        tier2Volume: "0",
        combinedVolume: "0",
      },
    }));
  }, [applyLatestPrice, applyTradeSnapshot]);

  const loadTrades = useCallback(async (wallet) => {
    if (!wallet) return;
    if (activeProtocolVariant !== backendProtocolVariant) {
      setOpenTrades([]);
      setClosedTrades([]);
      setOptimisticOpenTrades([]);
      return;
    }
    const data = await apiGet(`/api/trades?wallet=${wallet}`);
    applyTradeSnapshot(data.openTrades || [], data.closedTrades || []);
  }, [activeProtocolVariant, backendProtocolVariant, applyTradeSnapshot]);

  const loadReferrals = useCallback(async (wallet) => {
    if (!wallet) return;
    if (referralFetchStateRef.current.wallet !== wallet) {
      referralFetchStateRef.current.wallet = wallet;
      referralFetchStateRef.current.lastAttemptAt = 0;
      referralFetchStateRef.current.unavailable = false;
      referralFetchStateRef.current.inFlight = false;
    }
    const now = Date.now();
    if (referralFetchStateRef.current.inFlight) return;
    if (now - referralFetchStateRef.current.lastAttemptAt < REFERRAL_REFRESH_INTERVAL_MS) return;

    referralFetchStateRef.current.inFlight = true;
    referralFetchStateRef.current.lastAttemptAt = now;
    try {
      const data = await apiGet(`/api/users/${wallet}/referrals`);

      let normalized = data;
      const looksLegacyShape =
        data &&
        data.user &&
        data.user.walletAddress &&
        data.user.id === undefined &&
        !("referrer" in data);

      if (looksLegacyShape) {
        const username = ACTIVE_NETWORK.adminDefaultUser || "";
        const password = ACTIVE_NETWORK.adminDefaultPassword || "";
        if (username && password) {
          try {
            const adminSelf = await apiGet(`/api/admin/users/${wallet}`, {
              auth: { username, password },
            });
            const tier1 = Array.isArray(adminSelf?.referredUsers) ? adminSelf.referredUsers : [];
            const tier2 = [];
            for (const parent of tier1) {
              const childWallet = String(parent?.walletAddress || "").toLowerCase();
              if (!childWallet) continue;
              try {
                const childDetail = await apiGet(`/api/admin/users/${childWallet}`, {
                  auth: { username, password },
                });
                for (const grandChild of childDetail?.referredUsers || []) {
                  tier2.push({
                    ...grandChild,
                    parentWalletAddress: parent.walletAddress,
                    parentReferralCode: parent.referralCode,
                  });
                }
              } catch {
              }
            }

            const tier1Volume = tier1.reduce((sum, item) => sum + rawToBigInt(item?.totalTradingVolume), 0n);
            const tier2Volume = tier2.reduce((sum, item) => sum + rawToBigInt(item?.totalTradingVolume), 0n);

            normalized = {
              user: adminSelf?.user || data?.user || null,
              referrer: adminSelf?.referrer || null,
              tier1,
              tier2,
              totals: {
                tier1Volume: tier1Volume.toString(),
                tier2Volume: tier2Volume.toString(),
                combinedVolume: (tier1Volume + tier2Volume).toString(),
              },
            };
          } catch {
          }
        }
      }

      setReferrals(normalized);
      setReferralsUnavailable(false);
      referralFetchStateRef.current.unavailable = false;
    } catch (referralError) {
      if (referralError?.status === 404) {
        setReferralsUnavailable(false);
        referralFetchStateRef.current.unavailable = false;
        setReferrals({
          user: null,
          tier1: [],
          tier2: [],
          totals: {
            tier1Volume: "0",
            tier2Volume: "0",
            combinedVolume: "0",
          },
        });
        return;
      }
      throw referralError;
    } finally {
      referralFetchStateRef.current.inFlight = false;
    }
  }, []);

  const connectRealtime = useCallback((wallet) => {
    if (!wallet) return () => {};
    const base = String(ACTIVE_NETWORK.backendUrl || "");
    const wsBase = base.replace(/^http/i, "ws").replace(/\/+$/, "");
    if (!wsBase) return () => {};
    const url = `${wsBase}/ws?wallet=${encodeURIComponent(wallet.toLowerCase())}`;

    if (wsReconnectTimerRef.current) {
      clearTimeout(wsReconnectTimerRef.current);
      wsReconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {};
    ws.onerror = () => {};

    ws.onmessage = (evt) => {
      let parsed;
      try {
        parsed = JSON.parse(evt.data);
      } catch {
        return;
      }
      const eventName = parsed?.event;
      const payload = parsed?.payload || {};
      if (eventName === "price_tick") {
        applyLatestPrice(payload);
        return;
      }
      if (eventName === "trade_upsert" || eventName === "trade_closed") {
        const trade = payload?.trade;
        if (!trade) return;
        const isOpen = String(trade?.status || "").toUpperCase() === "OPEN";
        setOptimisticOpenTrades((prev) =>
          prev.filter((item) => String(item?.onChainTradeId || "") !== String(trade?.onChainTradeId || ""))
        );
        if (isOpen) {
          setOpenTrades((prev) => mergeOptimisticOpenTrade(prev, trade));
          setClosedTrades((prev) =>
            prev.filter((item) => String(item?.onChainTradeId || "") !== String(trade?.onChainTradeId || ""))
          );
        } else {
          setOpenTrades((prev) =>
            prev.filter((item) => String(item?.onChainTradeId || "") !== String(trade?.onChainTradeId || ""))
          );
          setClosedTrades((prev) => [trade, ...prev.filter((item) => String(item?.onChainTradeId || "") !== String(trade?.onChainTradeId || ""))]);
        }
        return;
      }
      if (eventName === "referral_summary") {
        setReferrals((prev) => ({
          ...(prev || {}),
          totals: payload || prev?.totals || {
            tier1Volume: "0",
            tier2Volume: "0",
            combinedVolume: "0",
          },
        }));
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      wsReconnectTimerRef.current = setTimeout(() => {
        loadBootstrap(wallet).catch(() => {});
        connectRealtime(wallet);
      }, 1500);
    };

    return () => {
      if (wsReconnectTimerRef.current) {
        clearTimeout(wsReconnectTimerRef.current);
        wsReconnectTimerRef.current = null;
      }
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      try {
        ws.close();
      } catch {}
    };
  }, [applyLatestPrice, loadBootstrap]);

  const requestBackendTradeSync = useCallback(async (tradeId = null) => {
    if (activeProtocolVariant !== backendProtocolVariant) return true;
    try {
      await apiPost("/api/trades/sync", {
        protocolVariant: activeProtocolVariant,
        tradeId: tradeId == null ? undefined : Number(tradeId),
      });
      return true;
    } catch (syncError) {
      console.warn("[trades] backend sync trigger failed", syncError);
      return false;
    }
  }, [activeProtocolVariant, backendProtocolVariant]);

  const loadUsdcBalance = useCallback(
    async (wallet) => {
      const usdcAddress = protocol.usdcAddress || ACTIVE_NETWORK.usdc || "";
      if (!wallet || !usdcAddress) return;
      try {
        const token = new Contract(usdcAddress, ERC20_ABI, readProvider);
        const [balanceRaw, decimals] = await Promise.all([token.balanceOf(wallet), token.decimals()]);
        setUsdcDecimals(Number(decimals));
        setUsdcBalance(Number(formatUnits(balanceRaw, Number(decimals))));
      } catch {
        setUsdcBalance(0);
      }
    },
    [readProvider, protocol.usdcAddress]
  );

  const loadEthBalance = useCallback(
    async (wallet) => {
      if (!wallet) return;
      try {
        const balanceRaw = await readProvider.getBalance(wallet);
        setEthBalance(Number(formatUnits(balanceRaw, 18)));
      } catch {
        setEthBalance(0);
      }
    },
    [readProvider]
  );

  const loadFaucetInfo = useCallback(async () => {
    try {
      const info = await apiGet("/api/faucet/info");
      setFaucetInfo(info || { enabled: false });
      if (!info?.enabled) {
        setFaucetMessage("");
        setFaucetTone("muted");
      }
    } catch {
      setFaucetInfo({ enabled: false });
      setFaucetMessage("");
      setFaucetTone("muted");
    }
  }, []);

  const requestFaucet = useCallback(async () => {
    if (!walletAddress) {
      setFaucetTone("error");
      setFaucetMessage("Connect wallet first.");
      return;
    }
    setFaucetBusy(true);
    setFaucetMessage("");
    setFaucetTone("muted");
    try {
      const result = await apiPost("/api/faucet/claim", { walletAddress });
      const ethAmount = fmtTokenUnits(result?.ethWei || faucetInfo.ethWei || 0, 18);
      const usdcAmount = fmtTokenUnits(result?.usdc6 || faucetInfo.usdc6 || 0, QUOTE_TOKEN_DECIMALS);
      const payoutBits = [];
      if (ethAmount > 0) payoutBits.push(`${fmt(ethAmount, 6)} ETH`);
      if (usdcAmount > 0) payoutBits.push(`${fmt(usdcAmount, 2)} USD`);
      setFaucetTone("success");
      setFaucetMessage(payoutBits.length ? `Sent ${payoutBits.join(" + ")}.` : "Faucet request sent.");
      await Promise.all([loadUsdcBalance(walletAddress), loadEthBalance(walletAddress)]);
    } catch (claimError) {
      const retryAfterMs = Number(claimError?.body?.retryAfterMs || 0);
      if (Number(claimError?.status) === 429 && retryAfterMs > 0) {
        setFaucetMessage(`Cooldown active. Try again in ${fmtDuration(retryAfterMs)}.`);
      } else {
        setFaucetMessage(getErrorMessage(claimError));
      }
      setFaucetTone("error");
    } finally {
      setFaucetBusy(false);
    }
  }, [walletAddress, faucetInfo.ethWei, faucetInfo.usdc6, loadEthBalance, loadUsdcBalance]);

  const refreshAfterTradeAction = useCallback(
      async (wallet, tradeId = null) => {
        const backendSyncOk = await requestBackendTradeSync(tradeId);
        let backendRefreshOk = backendSyncOk;
        try {
          await Promise.all([loadBootstrap(wallet), loadReferrals(wallet)]);
      } catch (refreshError) {
        backendRefreshOk = false;
        console.warn("[backend] post-trade refresh failed", refreshError);
      }
      await Promise.all([loadUsdcBalance(wallet), loadEthBalance(wallet)]);
      return backendRefreshOk;
    },
      [requestBackendTradeSync, loadBootstrap, loadReferrals, loadUsdcBalance, loadEthBalance]
    );

  const handleReferralResult = useCallback((data) => {
    setUser(data.user);
    const referral = data.referral || { attempted: false, status: "none" };
    if (referral.attempted) {
      if (referral.status === "applied") {
        setStatus(`Referral linked: ${referral.code}`);
      } else if (referral.status === "already_set") {
        setStatus("Referral already linked for this wallet.");
      } else if (referral.status === "not_found") {
        setStatus(`Referral code ${referral.code} not found. Continuing without referral.`);
      } else if (referral.status === "self_referral") {
        setStatus("Referral code cannot be your own wallet.");
      } else if (referral.status === "circular_referral") {
        setStatus("Circular referral blocked.");
      }
    }
  }, []);

  const reportBackgroundError = useCallback((backgroundError) => {
    if (isBackendUnreachableError(backgroundError)) {
      console.warn("[backend] background request failed", backgroundError);
      return;
    }
    setError(getErrorMessage(backgroundError));
  }, []);

  const loginUser = useCallback(
    async (wallet) => {
      const code = normalizeReferralCode(pendingReferralCode);
      const base = await apiPost("/api/users/login", {
        walletAddress: wallet,
        referralCode: "",
      });

      let finalResult = base;
      const ownCode = normalizeReferralCode(base?.user?.referralCode || "");
      const hasReferrer = Boolean(base?.user?.referredBy);

      if (code && !hasReferrer && code !== ownCode) {
        finalResult = await apiPost("/api/users/login", {
          walletAddress: wallet,
          referralCode: code,
        });
      } else if (code && !hasReferrer && code === ownCode) {
        setStatus("Referral code cannot be your own wallet.");
      }

      setReferralsUnavailable(false);
      referralFetchStateRef.current.unavailable = false;
      referralFetchStateRef.current.inFlight = false;
      handleReferralResult(finalResult);
      return finalResult;
    },
    [handleReferralResult, loadReferrals, pendingReferralCode]
  );

  const applyManualReferral = useCallback(async () => {
    if (!walletAddress || !user || user.referredBy) return;
    const code = normalizeReferralCode(manualReferralCode);
    if (!code) {
      setStatus("Enter a referral code first.");
      return;
    }

    if (code === normalizeReferralCode(user.referralCode || "")) {
      setStatus("Referral code cannot be your own wallet.");
      return;
    }

    setManualReferralBusy(true);
    setError("");
    setStatus("");
    try {
      const result = await apiPost("/api/users/login", {
        walletAddress,
        referralCode: code,
      });
      handleReferralResult(result);
      setPendingReferralCode(code);
      sessionStorage.setItem(REFERRAL_PENDING_KEY, code);
      setReferralsUnavailable(false);
      referralFetchStateRef.current.unavailable = false;
      referralFetchStateRef.current.inFlight = false;
      await loadReferrals(walletAddress);
      if (result?.referral?.status === "applied" || result?.referral?.status === "already_set") {
        setManualReferralCode("");
      }
    } catch (manualError) {
      setError(getErrorMessage(manualError));
    } finally {
      setManualReferralBusy(false);
    }
  }, [walletAddress, user, manualReferralCode, handleReferralResult, loadReferrals]);

  const connectWallet = useCallback(
    async (requestAccounts = true) => {
      if (!window.ethereum) {
        setError("MetaMask is required");
        return;
      }
      setError("");
      const provider = new BrowserProvider(window.ethereum);
      const method = requestAccounts ? "eth_requestAccounts" : "eth_accounts";
      const accounts = await provider.send(method, []);
      if (!accounts || accounts.length === 0) return;

      const signer = await provider.getSigner();
      const wallet = await signer.getAddress();
      const network = await provider.getNetwork();

      setWalletProvider(provider);
      setWalletAddress(wallet.toLowerCase());
      setChainId(Number(network.chainId));
      localStorage.setItem("makeit.wallet.autoconnect", "1");

      await loginUser(wallet.toLowerCase());
      await Promise.all([
        loadBootstrap(wallet.toLowerCase()),
        loadReferrals(wallet.toLowerCase()).catch(() => {}),
        loadUsdcBalance(wallet.toLowerCase()),
        loadEthBalance(wallet.toLowerCase()),
      ]);
    },
    [loadBootstrap, loadReferrals, loadUsdcBalance, loadEthBalance, loginUser]
  );

  const syncWalletFromMetaMask = useCallback(async () => {
    if (!window.ethereum || !walletProvider) return;
    try {
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      const nextWallet = String(accounts?.[0] || "").toLowerCase();
        if (!nextWallet) {
          setWalletAddress("");
          setUser(null);
          setOpenTrades([]);
          setClosedTrades([]);
          setOptimisticOpenTrades([]);
          setUsdcBalance(0);
          setEthBalance(0);
          return;
      }
      if (nextWallet === walletAddress) return;

      const network = await walletProvider.getNetwork();
      setWalletAddress(nextWallet);
      setChainId(Number(network.chainId));
      await loginUser(nextWallet);
      await Promise.all([
        loadBootstrap(nextWallet).catch(() => {}),
        loadReferrals(nextWallet).catch(() => {}),
        loadUsdcBalance(nextWallet).catch(() => {}),
        loadEthBalance(nextWallet).catch(() => {}),
      ]);
      setStatus("Wallet switched to the account currently selected in MetaMask.");
    } catch {
    }
  }, [walletProvider, walletAddress, loginUser, loadBootstrap, loadReferrals, loadUsdcBalance, loadEthBalance]);

  const switchToConfiguredChain = useCallback(async () => {
    if (!walletProvider || !window.ethereum) {
      setError("Connect wallet first");
      return false;
    }
    const desiredChain = {
      chainId: ACTIVE_NETWORK.chainHex,
      chainName: ACTIVE_NETWORK.chainName,
      rpcUrls: [ACTIVE_NETWORK.rpcUrl],
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    };
    // Proactively refresh MetaMask chain config (especially RPC URL) for local Anvil mode.
    // MetaMask keeps chainId entries; wallet_addEthereumChain can update metadata/rpc for existing chain ids.
    try {
      if (ACTIVE_NETWORK.localMode && /^https?:\/\//i.test(String(ACTIVE_NETWORK.rpcUrl || ""))) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [desiredChain],
        });
      }
    } catch (error) {
      // User may reject the update prompt; we still try to switch below.
      if (error?.code === 4001) {
        setStatus("MetaMask network update was skipped by user; trying chain switch with current settings.");
      }
    }
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ACTIVE_NETWORK.chainHex }],
      });
    } catch (error) {
      if (error?.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [desiredChain],
          });
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: ACTIVE_NETWORK.chainHex }],
          });
        } catch (addError) {
          setError(addError?.message || "Failed to add or switch chain");
          return false;
        }
      } else {
        setError(error?.message || "Failed to switch chain");
        return false;
      }
    }

    try {
      const network = await walletProvider.getNetwork();
      const nextChainId = Number(network.chainId);
      setChainId(nextChainId);
      if (nextChainId !== ACTIVE_NETWORK.chainId) {
        setError(`Switch to ${ACTIVE_NETWORK.chainName} to continue.`);
        return false;
      }
      return true;
    } catch (error) {
      setError(error?.message || "Failed to verify active chain");
      return false;
    }
  }, [walletProvider]);

  const ensureAllowance = useCallback(
    async (signer, minimumAllowanceUsdc6) => {
      if (!activeMakeitAddress || !makeitRead) return false;
      const usdcAddress = protocol.usdcAddress || (await makeitRead.USDC());
      const usdc = new Contract(usdcAddress, ERC20_ABI, signer);
      const owner = await signer.getAddress();
      const allowance = BigInt(await usdc.allowance(owner, activeMakeitAddress));
      return allowance >= minimumAllowanceUsdc6;
    },
    [protocol.usdcAddress, makeitRead, activeMakeitAddress]
  );

  const getUsdcSpendState = useCallback(
    async (signer, ownerAddress = "") => {
      if (!activeMakeitAddress || !makeitRead) {
        return { balance: 0n, allowance: 0n };
      }
      const usdcAddress = protocol.usdcAddress || (await makeitRead.USDC());
      const usdc = new Contract(usdcAddress, ERC20_ABI, signer);
      const owner = ownerAddress || (await signer.getAddress());
      const [balance, allowance] = await Promise.all([
        usdc.balanceOf(owner),
        usdc.allowance(owner, activeMakeitAddress),
      ]);
      return {
        balance: BigInt(balance),
        allowance: BigInt(allowance),
      };
    },
    [protocol.usdcAddress, makeitRead, activeMakeitAddress]
  );

  const getDisplayedWalletUsdcState = useCallback(
    async (ownerAddress) => {
      if (!ownerAddress || !activeMakeitAddress) {
        return { balance: 0n, allowance: 0n };
      }
      const usdcAddress = protocol.usdcAddress || ACTIVE_NETWORK.usdc || (makeitRead ? await makeitRead.USDC() : "");
      if (!usdcAddress) {
        return { balance: 0n, allowance: 0n };
      }
      const usdc = new Contract(usdcAddress, ERC20_ABI, readProvider);
      const [balance, allowance] = await Promise.all([
        usdc.balanceOf(ownerAddress),
        usdc.allowance(ownerAddress, activeMakeitAddress),
      ]);
      return {
        balance: BigInt(balance),
        allowance: BigInt(allowance),
      };
    },
    [activeMakeitAddress, protocol.usdcAddress, makeitRead, readProvider]
  );

  const protocolSupportsShorts = true;
  const tradeActionsBlockedByBackendVariant = activeProtocolVariant !== backendProtocolVariant;
  const baseTotalFeePpm = protocol.liquidityProvisionFeePpm + protocol.protocolFeePpm;
  const shortCapacityUsdc6 = useMemo(() => {
    if (!protocolSupportsShorts) return 0n;
    if (protocol.openLongNotionalUsdc6 <= protocol.openShortNotionalUsdc6) return 0n;
    return protocol.openLongNotionalUsdc6 - protocol.openShortNotionalUsdc6;
  }, [protocolSupportsShorts, protocol.openLongNotionalUsdc6, protocol.openShortNotionalUsdc6]);

  const executeTrade = useCallback(
    async (signer, side, leverage) => {
      const makeit = new Contract(activeMakeitAddress, activeMakeitAbi, signer);
      const trader = await signer.getAddress();
      const fetchExpectedPrice = async () => {
        try {
          const onchainPrice = await oracleRead.getPriceE18();
          if (BigInt(onchainPrice) > 0n) return BigInt(onchainPrice);
        } catch {
        }
        return parseUnits(String(currentPrice || 0), 18);
      };

      const submitOpenTrade = async (expectedPriceE18) => {
        const totalFeePpm = totalFeePpmForTrade(
          baseTotalFeePpm,
          leverage,
          protocol.feeScaleFactorPpm,
          activeProtocolVariant
        );
        const profitTargetArg = targetProfitPpmForDesiredPnl(
          protocol.marginUsdc6,
          totalFeePpm,
          targetProfitUsdc
        );
        if (side === "SHORT") {
          return makeit.openShortTrade(
            expectedPriceE18,
            OPEN_TRADE_TOLERANCE_BPS,
            profitTargetArg,
            leverage,
            protocol.marginUsdc6
          );
        }
        return makeit.openLongTrade(
          expectedPriceE18,
          OPEN_TRADE_TOLERANCE_BPS,
          profitTargetArg,
          leverage,
          protocol.marginUsdc6
        );
      };

      const expectedPriceE18 = await fetchExpectedPrice();
      const totalFeePpm = totalFeePpmForTrade(
        baseTotalFeePpm,
        leverage,
        protocol.feeScaleFactorPpm,
        activeProtocolVariant
      );
      logTxStarted(side === "SHORT" ? "openShortTrade" : "openLongTrade", {
        trader,
        side,
        variant: activeProtocolVariant,
        leverage,
        expectedPriceE18: expectedPriceE18.toString(),
        toleranceBps: OPEN_TRADE_TOLERANCE_BPS,
        profitTarget: targetProfitPpmForDesiredPnl(protocol.marginUsdc6, totalFeePpm, targetProfitUsdc).toString(),
      });
      try {
        let tx;
        try {
          tx = await submitOpenTrade(expectedPriceE18);
        } catch (firstError) {
          const firstMessage = decodeTxErrorMessage(firstError);
          if (firstMessage.includes("Price moved outside tolerance")) {
            const refreshedPriceE18 = await fetchExpectedPrice();
            setStatus("Price moved, retrying trade with latest oracle price...");
            tx = await submitOpenTrade(refreshedPriceE18);
          } else {
            throw firstError;
          }
        }
        logTxSubmitted(side === "SHORT" ? "openShortTrade" : "openLongTrade", tx.hash);
        setStatus("Trade submitted. Waiting for confirmation...");
        const receipt = await tx.wait();
        logTxCompleted(side === "SHORT" ? "openShortTrade" : "openLongTrade", receipt);
        if (!receipt || Number(receipt.status) !== 1) {
          throw new Error("Trade transaction reverted on-chain");
        }
        let optimisticTrade = null;
        for (const log of receipt.logs || []) {
          try {
            const parsed = makeit.interface.parseLog(log);
            if (parsed?.name !== "TradeOpened") continue;
            optimisticTrade = buildOptimisticOpenTrade(parsed.args, side, receipt);
            break;
          } catch {
          }
        }
        return { receipt, optimisticTrade };
      } catch (error) {
        logTxFailed(side === "SHORT" ? "openShortTrade" : "openLongTrade", error);
        throw error;
      }
    },
    [activeMakeitAddress, activeMakeitAbi, activeProtocolVariant, baseTotalFeePpm, currentPrice, oracleRead, protocol.feeScaleFactorPpm, protocol.marginUsdc6, targetProfitUsdc]
  );

  const openTrade = useCallback(
    async (side, leverage) => {
      if (!walletProvider || !walletAddress) return;
      if (activeProtocolVariant !== backendProtocolVariant) {
        setError(`Backend sync is running for ${backendProtocolVariant.toUpperCase()}. Switch back to that protocol to trade.`);
        return;
      }
      if (chainId !== ACTIVE_NETWORK.chainId) {
        const switched = await switchToConfiguredChain();
        if (!switched) return;
      }

      setBusy(true);
      setError("");
      setStatus("");
      let signer;
      try {
        const currentWalletAddress = walletAddress.toLowerCase();
        const displayedSpendState = await getDisplayedWalletUsdcState(currentWalletAddress);
        const marginUsdc6 = protocol.marginUsdc6 > 0n ? protocol.marginUsdc6 : (activeProtocolVariant === 'v4' ? 10_000_000n : BigInt(await makeitRead.marginUSDC()));
        if (displayedSpendState.balance < marginUsdc6) {
          setError(
            `Insufficient USD balance. Need ${formatUnits(marginUsdc6, usdcDecimals)} USD, wallet has ${formatUnits(displayedSpendState.balance, usdcDecimals)} USD.`
          );
          return;
        }
        if (displayedSpendState.allowance < marginUsdc6) {
          setError("");
          setApprovalCustom(formatUnits(marginUsdc6, usdcDecimals));
          setApprovalPrompt({
            side,
            leverage,
            requiredUsdc6: marginUsdc6.toString(),
          });
          setStatus("");
          return;
        }

        signer = await walletProvider.getSigner();
        const signerAddress = (await signer.getAddress()).toLowerCase();
        if (currentWalletAddress && signerAddress !== currentWalletAddress) {
          setWalletAddress(signerAddress);
          await Promise.all([
            loadTrades(signerAddress).catch(() => {}),
            loadUsdcBalance(signerAddress).catch(() => {}),
            loadEthBalance(signerAddress).catch(() => {}),
          ]);
          setError("Active wallet changed in MetaMask. Retry the trade with the currently selected wallet.");
          return;
        }

        const { optimisticTrade } = await executeTrade(signer, side, leverage);
        if (optimisticTrade) {
          setOptimisticOpenTrades((prev) => mergeOptimisticOpenTrade(prev, optimisticTrade));
          setOpenTrades((prev) => mergeOptimisticOpenTrade(prev, optimisticTrade));
        }
          const backendRefreshOk = await refreshAfterTradeAction(walletAddress, optimisticTrade?.onChainTradeId || null);
          setPendingTrade(null);
          setStatus(
            backendRefreshOk
              ? `${side === "SHORT" ? "Short" : "Long"} trade opened.`
            : `${side === "SHORT" ? "Short" : "Long"} trade opened on-chain. Backend refresh pending.`
        );
      } catch (tradeError) {
        const decoded = decodeTxErrorMessage(tradeError);
        if (signer && decoded.includes("USD transfer failed")) {
          const signerAddress = (await signer.getAddress()).toLowerCase();
          const marginUsdc6 = protocol.marginUsdc6 > 0n ? protocol.marginUsdc6 : 10_000_000n;
          const spendState = await getUsdcSpendState(signer, signerAddress);
          if (spendState.balance < marginUsdc6) {
            setError(
              `Insufficient USD balance. Need ${formatUnits(marginUsdc6, usdcDecimals)} USD, wallet has ${formatUnits(spendState.balance, usdcDecimals)} USD.`
            );
            return;
          }
          if (spendState.allowance < marginUsdc6) {
            setError("");
            setApprovalCustom(formatUnits(marginUsdc6, usdcDecimals));
            setApprovalPrompt({
              side,
              leverage,
              requiredUsdc6: marginUsdc6.toString(),
            });
            setStatus("");
            return;
          }
        }
        setError(decoded);
      } finally {
        setBusy(false);
      }
    },
    [
      walletProvider,
      walletAddress,
      chainId,
      activeProtocolVariant,
      backendProtocolVariant,
      switchToConfiguredChain,
      getUsdcSpendState,
      getDisplayedWalletUsdcState,
      protocol.marginUsdc6,
      usdcDecimals,
      executeTrade,
      refreshAfterTradeAction,
    ]
  );

  const closeTrade = useCallback(
    async (onChainTradeId) => {
      if (!walletProvider || !walletAddress) return;
      if (activeProtocolVariant !== backendProtocolVariant) {
        setError(`Backend sync is running for ${backendProtocolVariant.toUpperCase()}. Switch back to that protocol to manage trades.`);
        return;
      }
      if (chainId !== ACTIVE_NETWORK.chainId) {
        const switched = await switchToConfiguredChain();
        if (!switched) return;
      }

      setBusy(true);
      setError("");
      setStatus("");
      try {
        const signer = await walletProvider.getSigner();
        const makeit = new Contract(activeMakeitAddress, activeMakeitAbi, signer);
        const trader = await signer.getAddress();
        const tradeId = BigInt(onChainTradeId);
        logTxStarted("closeTrade", { trader, tradeId: tradeId.toString(), variant: activeProtocolVariant });

        let tx;
        try {
          tx = await makeit.close(tradeId);
        } catch (closeError) {
          const decoded = decodeTxErrorMessage(closeError);
          if (decoded.includes("must be liquidated")) {
            setStatus("TP/SL hit. Submitting liquidation...");
            tx = await makeit.liquidateTrade(tradeId);
          } else {
            throw closeError;
          }
        }

        logTxSubmitted("closeTrade", tx.hash);
        setStatus(`Close submitted: ${tx.hash}`);
        const receipt = await tx.wait();
        logTxCompleted("closeTrade", receipt);
        if (!receipt || Number(receipt.status) !== 1) {
          throw new Error("Close transaction reverted on-chain");
        }

        const backendRefreshOk = await refreshAfterTradeAction(walletAddress, onChainTradeId);
        setStatus(backendRefreshOk ? "Trade close confirmed on-chain." : "Trade close confirmed on-chain. Backend refresh pending.");
      } catch (closeError) {
        logTxFailed("closeTrade", closeError);
        setError(decodeTxErrorMessage(closeError));
      } finally {
        setBusy(false);
      }
    },
    [
      walletProvider,
      walletAddress,
      chainId,
      activeMakeitAddress,
      activeMakeitAbi,
      activeProtocolVariant,
      backendProtocolVariant,
      switchToConfiguredChain,
      refreshAfterTradeAction,
    ]
  );

  const approveAndContinueTrade = useCallback(
    async (mode) => {
      if (!approvalPrompt || !walletProvider || !walletAddress) return;
      if (chainId !== ACTIVE_NETWORK.chainId) {
        const switched = await switchToConfiguredChain();
        if (!switched) return;
      }

      setApprovalBusy(true);
      setError("");
      try {
        const signer = await walletProvider.getSigner();
        const usdcAddress = protocol.usdcAddress || (await makeitRead.USDC());
        const usdc = new Contract(usdcAddress, ERC20_ABI, signer);
        let amount;
        if (mode === "required") {
          amount = BigInt(approvalPrompt.requiredUsdc6);
        } else if (mode === "max") {
          amount = MaxUint256;
        } else {
          amount = parseUnits(String(approvalCustom || "0"), usdcDecimals);
          if (amount <= 0n) {
            throw new Error("Custom approval amount must be greater than 0.");
          }
        }

        logTxStarted("approveUSDC", {
          owner: walletAddress,
          spender: activeMakeitAddress,
          amount: amount.toString(),
          mode,
        });
        const tx = await usdc.approve(activeMakeitAddress, amount);
        logTxSubmitted("approveUSDC", tx.hash);
        setStatus(`Approving USD... ${tx.hash}`);
        const receipt = await tx.wait();
        logTxCompleted("approveUSDC", receipt);
        if (!receipt || Number(receipt.status) !== 1) {
          throw new Error("USD approval transaction reverted.");
        }

          if (mode === "required") {
            setStatus("Approval confirmed. Submitting trade...");
            const { optimisticTrade } = await executeTrade(signer, approvalPrompt.side || "LONG", approvalPrompt.leverage);
            if (optimisticTrade) {
              setOptimisticOpenTrades((prev) => mergeOptimisticOpenTrade(prev, optimisticTrade));
              setOpenTrades((prev) => mergeOptimisticOpenTrade(prev, optimisticTrade));
            }
            const backendRefreshOk = await refreshAfterTradeAction(walletAddress, optimisticTrade?.onChainTradeId || null);
            setPendingTrade(null);
            setStatus(
              backendRefreshOk
                ? `${approvalPrompt.side === "SHORT" ? "Short" : "Long"} trade opened.`
              : `${approvalPrompt.side === "SHORT" ? "Short" : "Long"} trade opened on-chain. Backend refresh pending.`
          );
        } else {
          setStatus("Preapproval confirmed. You can open future trades without approving each time.");
        }
        setApprovalPrompt(null);
      } catch (approvalError) {
        logTxFailed("approveUSDC", approvalError);
        setError(decodeTxErrorMessage(approvalError));
      } finally {
        setApprovalBusy(false);
      }
    },
    [
      approvalPrompt,
      walletProvider,
      walletAddress,
      chainId,
      switchToConfiguredChain,
      protocol.usdcAddress,
      makeitRead,
      activeMakeitAddress,
      approvalCustom,
      usdcDecimals,
      executeTrade,
      refreshAfterTradeAction,
    ]
  );

  const totalOpenPnl = useMemo(
    () => openTrades.reduce((sum, trade) => sum + computeLive(trade, currentPrice).pnl, 0),
    [openTrades, currentPrice]
  );

  useEffect(() => {
    loadProtocol().catch(reportBackgroundError);
    loadHistory(range).catch(reportBackgroundError);
  }, [loadProtocol, loadHistory, range, reportBackgroundError]);

  useEffect(() => {
    setOpenTrades([]);
    setClosedTrades([]);
    setOptimisticOpenTrades([]);
    if (walletAddress) {
      loadBootstrap(walletAddress).catch(reportBackgroundError);
    }
  }, [activeProtocolVariant, walletAddress, loadBootstrap, reportBackgroundError]);

    useEffect(() => {
      if (!walletAddress) {
        setApprovalPrompt(null);
        setPendingTrade(null);
        setExpandedTradeId(null);
        setUser(null);
        setReferrals(null);
        setReferralsUnavailable(false);
        setOpenTrades([]);
        setClosedTrades([]);
        setOptimisticOpenTrades([]);
        setUsdcBalance(0);
        setEthBalance(0);
        referralFetchStateRef.current.wallet = "";
        referralFetchStateRef.current.lastAttemptAt = 0;
        referralFetchStateRef.current.unavailable = false;
        referralFetchStateRef.current.inFlight = false;
        previousWalletAddressRef.current = "";
        return;
      }
      if (previousWalletAddressRef.current && previousWalletAddressRef.current !== walletAddress) {
        setApprovalPrompt(null);
        setPendingTrade(null);
        setExpandedTradeId(null);
        setUser(null);
        setReferrals(null);
        setReferralsUnavailable(false);
        setOpenTrades([]);
        setClosedTrades([]);
        setOptimisticOpenTrades([]);
        setUsdcBalance(0);
        setEthBalance(0);
        referralFetchStateRef.current.wallet = walletAddress;
        referralFetchStateRef.current.lastAttemptAt = 0;
        referralFetchStateRef.current.unavailable = false;
        referralFetchStateRef.current.inFlight = false;
      }
      previousWalletAddressRef.current = walletAddress;
    }, [walletAddress]);

    useEffect(() => {
      setApprovalPrompt(null);
      setPendingTrade(null);
      setExpandedTradeId(null);
    }, [activeProtocolVariant]);

  useEffect(() => {
    const timer = setInterval(() => {
      loadProtocol().catch(() => {});
      if (walletAddress) {
        loadUsdcBalance(walletAddress).catch(() => {});
        loadEthBalance(walletAddress).catch(() => {});
      }
    }, ONCHAIN_PROTOCOL_POLL_MS);
    return () => clearInterval(timer);
  }, [loadProtocol, walletAddress, loadUsdcBalance, loadEthBalance]);

  useEffect(() => {
    if (!walletAddress) return undefined;
    return connectRealtime(walletAddress);
  }, [walletAddress, connectRealtime]);

  useEffect(() => {
    if (!window.ethereum) return undefined;
    const onAccountsChanged = () => connectWallet(false).catch(() => {});
    const onChainChanged = () => window.location.reload();

    window.ethereum.on("accountsChanged", onAccountsChanged);
    window.ethereum.on("chainChanged", onChainChanged);
    return () => {
      window.ethereum.removeListener("accountsChanged", onAccountsChanged);
      window.ethereum.removeListener("chainChanged", onChainChanged);
    };
  }, [connectWallet]);

  useEffect(() => {
    if (!window.ethereum || !walletProvider) return undefined;
    const onFocus = () => syncWalletFromMetaMask().catch(() => {});
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        syncWalletFromMetaMask().catch(() => {});
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [walletProvider, syncWalletFromMetaMask]);

  useEffect(() => {
    if (localStorage.getItem("makeit.wallet.autoconnect") === "1") {
      connectWallet(false).catch(() => {});
    }
  }, [connectWallet]);

  useEffect(() => {
    loadFaucetInfo().catch(() => {});
    const timer = setInterval(() => {
      loadFaucetInfo().catch(() => {});
    }, 60000);
    return () => clearInterval(timer);
  }, [loadFaucetInfo]);

  const referralLink = user ? `${window.location.origin}/?ref=${user.referralCode}` : "";
  const referralPairingNote = useMemo(() => {
    if (!walletAddress) return "";
    if (user?.referredBy) return "Referral pairing locked for this wallet.";
    if (pendingReferralCode) {
      return `Auto-pairing active from referral link (${pendingReferralCode}). Each connected wallet will be linked if not already paired.`;
    }
    return "No referral code pending. Share your code to invite others.";
  }, [walletAddress, user?.referredBy, pendingReferralCode]);
  const canManuallyAddReferrer = Boolean(walletAddress && user && !user.referredBy);

  const presetViews = useMemo(
    () =>
      TRADE_PRESETS.map((preset) => ({
        ...preset,
        notionalUsdc: Number(formatUnits(protocol.marginUsdc6 || 0n, usdcDecimals)) * Number(preset.leverage || 0),
      })),
    [protocol.marginUsdc6]
  );
  const previewTradeSelection = useCallback(
    (side, leverage) => {
      const totalFeePpm = totalFeePpmForTrade(
        baseTotalFeePpm,
        leverage,
        protocol.feeScaleFactorPpm,
        activeProtocolVariant
      );
      const preview = buildTradePreview(
        side,
        leverage,
        currentPrice,
        protocol.marginUsdc6,
        totalFeePpm,
        targetProfitUsdc
      );
      if (!preview) {
        setError("Price preview is not ready yet. Wait for the live price to load and try again.");
        return;
      }
      setError("");
      setStatus("");
      setApprovalPrompt(null);
      setPendingTrade(preview);
    },
    [activeProtocolVariant, baseTotalFeePpm, currentPrice, protocol.feeScaleFactorPpm, protocol.marginUsdc6, targetProfitUsdc]
  );
  const chartPriceLines = useMemo(() => {
    const livePendingTrade = resolvePreviewAtPrice(pendingTrade, currentPrice);
    const showOpenTradeLabels = !livePendingTrade;
    let closestTpTradeId = null;
    let closestSlTradeId = null;
    if (showOpenTradeLabels && Number.isFinite(currentPrice) && currentPrice > 0) {
      let minTpDistance = Infinity;
      let minSlDistance = Infinity;
      for (const trade of openTrades) {
        const tradeId = String(trade?.onChainTradeId || "").trim();
        const tp = tradeTpPriceUsdc(trade);
        const sl = tradeSlPriceUsdc(trade);
        if (tradeId && Number.isFinite(tp) && tp > 0) {
          const d = Math.abs(tp - currentPrice);
          if (d < minTpDistance) {
            minTpDistance = d;
            closestTpTradeId = tradeId;
          }
        }
        if (tradeId && Number.isFinite(sl) && sl > 0) {
          const d = Math.abs(sl - currentPrice);
          if (d < minSlDistance) {
            minSlDistance = d;
            closestSlTradeId = tradeId;
          }
        }
      }
    }
    const openTradeLines = openTrades.flatMap((trade) => {
      const tradeId = String(trade?.onChainTradeId || "").trim();
      return buildTradeChartLines(trade, {
        compactLabel: true,
        showTpLabel: showOpenTradeLabels && tradeId !== "" && tradeId === closestTpTradeId,
        showSlLabel: showOpenTradeLabels && tradeId !== "" && tradeId === closestSlTradeId,
      });
    });
    if (!livePendingTrade) return openTradeLines;
    const marginUsd = Number(livePendingTrade?.grossMarginUsdc || 0);
    const profitUsd = Number(livePendingTrade?.targetProfitUsdc || 0);
    const profitTag = Number.isFinite(profitUsd) && profitUsd > 0 ? fmt(profitUsd, 0) : "0";
    const lossTag = Number.isFinite(marginUsd) && marginUsd > 0 ? fmt(marginUsd, 0) : "0";
    return [
      ...openTradeLines,
      ...buildTradeChartLines(
        {
          entryPrice: parseUnits(String(livePendingTrade.entryPrice), 18),
          tpPrice: parseUnits(String(livePendingTrade.tpPrice), 18),
          slPrice: parseUnits(String(livePendingTrade.slPrice), 18),
        },
        {
          strong: true,
          includeEntry: false,
          tpTitle: "",
          slTitle: "",
          tpCustomLabel: `+USD ${profitTag}`,
          slCustomLabel: `-USD ${lossTag}`,
          tpCustomLabelPosition: "above",
          slCustomLabelPosition: "below",
        }
      ),
    ];
  }, [currentPrice, openTrades, pendingTrade]);
  const displayPendingTrade = useMemo(
    () => resolvePreviewAtPrice(pendingTrade, currentPrice),
    [currentPrice, pendingTrade]
  );
  useEffect(() => {
    if (!pendingTrade) return;
    const side = pendingTrade.side || "LONG";
    const leverage = Number(pendingTrade.leverage || 100);
    const totalFeePpm = totalFeePpmForTrade(
      baseTotalFeePpm,
      leverage,
      protocol.feeScaleFactorPpm,
      activeProtocolVariant
    );
    const next = buildTradePreview(
      side,
      leverage,
      currentPrice,
      protocol.marginUsdc6,
      totalFeePpm,
      targetProfitUsdc
    );
    if (next) setPendingTrade(next);
  }, [targetProfitUsdc]);
  const anyShortPresetAvailable = useMemo(() => {
    if (!protocolSupportsShorts || protocol.marginUsdc6 <= 0n) return false;
    return TRADE_PRESETS.some((preset) => protocol.marginUsdc6 * BigInt(preset.leverage) <= shortCapacityUsdc6);
  }, [protocolSupportsShorts, protocol.marginUsdc6, shortCapacityUsdc6]);
  const profitTargetCarousel = useMemo(() => {
    const selectedIndex = Math.max(0, PROFIT_TARGET_OPTIONS.indexOf(targetProfitUsdc));
    return PROFIT_TARGET_OPTIONS.map((amount, index) => {
      const offset = index - selectedIndex;
      const distance = Math.abs(offset);
      return { amount, offset, distance };
    });
  }, [targetProfitUsdc]);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1 className="brand-title">makeit</h1>
          <p className="muted" style={{ fontSize: "0.68rem", marginTop: "0.2rem" }}>
            build {String(ACTIVE_NETWORK.updatedAt || "").replace("T", " ").replace("Z", " UTC")}
          </p>
        </div>
        <div className="topbar-actions">
          <span className={`badge ${chainId === ACTIVE_NETWORK.chainId ? "ok" : "warn"}`}>
            {walletAddress ? `Chain ${chainId}` : "Wallet disconnected"}
          </span>
          {walletAddress ? (
            <button className="btn ghost wallet-chip" onClick={switchToConfiguredChain}>
              <span className="wallet-chip-address">
                {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
              </span>
              <span className="wallet-chip-balance">
                {fmt(usdcBalance, Math.min(6, Math.max(2, usdcDecimals)))} USD | {fmt(ethBalance, 4)} ETH
              </span>
            </button>
          ) : (
            <button className="btn solid" onClick={() => connectWallet(true)}>
              Connect Wallet
            </button>
          )}
          {walletAddress && faucetInfo?.enabled ? (
            <div
              style={{
                marginTop: "0.35rem",
                display: "flex",
                flexDirection: "column",
                gap: "0.25rem",
                alignItems: "flex-end",
              }}
            >
              <button className="btn tiny ghost" disabled={faucetBusy} onClick={requestFaucet}>
                {faucetBusy ? "Requesting..." : "Faucet"}
              </button>
              <span className={`muted ${faucetTone === "error" ? "danger" : faucetTone === "success" ? "success" : ""}`}>
                {faucetMessage ||
                  `Faucet: ${fmt(fmtTokenUnits(faucetInfo.ethWei || 0, 18), 6)} ETH + ${fmt(
                    fmtTokenUnits(faucetInfo.usdc6 || 0, QUOTE_TOKEN_DECIMALS),
                    2
                  )} USD`}
              </span>
            </div>
          ) : null}
        </div>
      </header>

      <section className="card chart-card chart-card-wide">
        <div className="card-head">
          <h2 className="hero-copy">ETH</h2>
          <strong className="hero-copy">{currentPrice ? `${fmt(currentPrice, 4)} USD` : "Loading..."}</strong>
        </div>
        <div className="range-switch">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option}
              className={`btn tiny ${range === option ? "solid" : "ghost"}`}
              onClick={() => setRange(option)}
            >
              {option}
            </button>
          ))}
        </div>
        <PriceChart data={chartData} priceLines={chartPriceLines} />
      </section>

      <section className="card trade-panel">
        <div className="trade-headline-row">
          <p className="quick-copy">put in USD 10</p>
          <p className="quick-copy quick-copy-right">
            open trades:{" "}
            <span className={totalOpenPnl >= 0 ? "success" : "danger"}>
              {totalOpenPnl >= 0 ? "+" : ""}
              {fmt(totalOpenPnl, 2)} USD
            </span>
          </p>
        </div>
        {tradeActionsBlockedByBackendVariant ? (
          <p className="warning">
            Backend sync is active for {backendProtocolVariant.toUpperCase()}. Switch back to that protocol to trade and view synced trades.
          </p>
        ) : null}
        {displayPendingTrade ? (
          <div className="trade-preview-card">
            <div className="card-head">
              <h3 className="preview-topline">
                put in USD {fmt(displayPendingTrade.grossMarginUsdc, 0)}
                <span className="preview-fee-note">(-fee*)</span> and trade with {displayPendingTrade.leverage}x more
              </h3>
            </div>
            <div className="profit-target-row">
              <span className="profit-target-inline">
                {profitTargetCarousel.map(({ amount, offset, distance }) => (
                  <button
                    key={`profit-${amount}`}
                    className={`profit-target-btn ${targetProfitUsdc === amount ? "profit-target-selected" : "profit-target-unselected"}`}
                    onClick={() => setTargetProfitUsdc(amount)}
                    disabled={busy || approvalBusy}
                    style={{
                      transform: `translate(calc(-50% + ${offset * 190}px), -50%) scale(${
                        distance === 0 ? 1.15 : distance === 1 ? 0.72 : 0.56
                      })`,
                      opacity: distance === 0 ? 1 : distance === 1 ? 0.62 : 0.32,
                      zIndex: distance === 0 ? 3 : distance === 1 ? 2 : 1,
                    }}
                  >
                    + USD {amount}
                  </button>
                ))}
              </span>
            </div>
            <p className="preview-simple preview-simple-main preview-rise-line">
              if price raises{" "}
              <strong className="preview-profit-number">{fmt(displayPendingTrade.tpMovePct, displayPendingTrade.tpMovePct >= 1 ? 2 : 3)}%</strong> to{" "}
              <strong className="preview-profit-number">{fmt(displayPendingTrade.tpPrice, 4)}</strong>
            </p>
            <p className="preview-simple preview-simple-small preview-loss-line">
              <strong className="preview-loss-number">- USD {fmt(displayPendingTrade.grossMarginUsdc, 2)}</strong> if price falls{" "}
              <strong className="preview-loss-number">{fmt(displayPendingTrade.slMovePct, displayPendingTrade.slMovePct >= 1 ? 2 : 3)}%</strong> to{" "}
              <strong className="preview-loss-number">{fmt(displayPendingTrade.slPrice, 4)}</strong>
            </p>
            <div className="trade-preview-actions trade-preview-actions-centered">
              <button
                className="btn solid makeit-cta"
                disabled={busy || approvalBusy || !walletAddress}
                onClick={() => openTrade(displayPendingTrade.side, displayPendingTrade.leverage)}
              >
                {busy ? "Submitting..." : "MAKEIT"}
              </button>
              <button className="btn ghost cancel-corner-btn" disabled={busy || approvalBusy} onClick={() => setPendingTrade(null)}>
                Cancel Preview
              </button>
            </div>
          </div>
        ) : (
          <p className="muted hero-copy trade-preview-placeholder">click trade for preview</p>
        )}
        <div className="trade-direction-grid">
          <div className="trade-direction-group">
            <div className="trade-speed-row">
              {presetViews.map((preset) => (
                <span key={`${preset.id}-pace`}>{preset.pace}</span>
              ))}
            </div>
              <div className="trade-preset-grid">
                {presetViews.map((preset) => (
                  <button
                    key={`long-${preset.id}`}
                    className="btn trade-option trade-option-long"
                    disabled={!walletAddress || busy || tradeActionsBlockedByBackendVariant}
                    onClick={() => previewTradeSelection("LONG", preset.leverage)}
                    aria-label={`Open long ${preset.leverage}x`}
                  >
                    <span className="trade-card-graph" aria-hidden="true">
                      <svg viewBox="0 0 120 70" role="presentation">
                        <path d="M8 58 C22 44, 34 33, 44 26 C50 34, 57 40, 64 45 C74 34, 88 25, 108 10" />
                        <path d="M94 9 L108 10 L106 24" />
                      </svg>
                    </span>
                    <span className="trade-card-bottom">trade with USD {fmt(preset.notionalUsdc, 0)}</span>
                  </button>
                ))}
              </div>
            </div>
          {protocolSupportsShorts ? (
            <div className="trade-direction-group">
              <div className="trade-speed-row">
                {presetViews.map((preset) => (
                  <span key={`${preset.id}-pace-short`}>{preset.pace}</span>
                ))}
              </div>
              <div className="trade-preset-grid">
                {presetViews.map((preset) => (
                  <button
                    key={`short-${preset.id}`}
                    className="btn trade-option trade-option-short"
                    disabled={
                      !walletAddress ||
                      busy ||
                      tradeActionsBlockedByBackendVariant ||
                      protocol.marginUsdc6 * BigInt(preset.leverage) > shortCapacityUsdc6
                    }
                    onClick={() => previewTradeSelection("SHORT", preset.leverage)}
                    aria-label={`Open short ${preset.leverage}x`}
                  >
                    <span className="trade-card-graph short" aria-hidden="true">
                      <svg viewBox="0 0 120 70" role="presentation">
                        <path d="M8 12 C22 26, 34 37, 44 44 C50 36, 57 30, 64 25 C74 36, 88 45, 108 60" />
                        <path d="M94 61 L108 60 L106 46" />
                      </svg>
                    </span>
                    <span className="trade-card-bottom">trade with USD {fmt(preset.notionalUsdc, 0)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        {approvalPrompt ? (
          <div ref={approvalCardRef} className="card trade-inline-card">
            <div className="card-head">
              <h2 style={{ fontSize: "0.95rem" }}>USD Approval Required</h2>
            </div>
            <p className="muted">
              Approve USD for this {approvalPrompt.side === "SHORT" ? "short" : "long"} trade first. Required now:{" "}
              {fmt(Number(formatUnits(BigInt(approvalPrompt.requiredUsdc6), usdcDecimals)), 4)} USD
            </p>
            <div className="approve-row">
              <button className="btn ghost" disabled={approvalBusy} onClick={() => approveAndContinueTrade("required")}>
                {approvalBusy ? "Approving..." : "Approve Trade Amount + Trade"}
              </button>
            </div>
            <p className="muted">Preapprove for future trades</p>
            <div className="approve-row">
              <button className="btn ghost" disabled={approvalBusy} onClick={() => approveAndContinueTrade("max")}>
                {approvalBusy ? "Approving..." : "Approve Max"}
              </button>
              <input
                value={approvalCustom}
                onChange={(e) => setApprovalCustom(e.target.value)}
                placeholder="Custom USD amount"
              />
              <button className="btn ghost" disabled={approvalBusy} onClick={() => approveAndContinueTrade("custom")}>
                {approvalBusy ? "Approving..." : "Approve Custom"}
              </button>
            </div>
            <div className="approve-row">
              <button className="btn ghost" disabled={approvalBusy} onClick={() => setApprovalPrompt(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {status ? <p className="success">{status}</p> : null}
        {error ? <p className="danger">{error}</p> : null}
      </section>

      <section className="card">
        <button className="referral-toggle" onClick={() => setReferralOpen((prev) => !prev)}>
          <span>Recommend to friends, get bonuses together</span>
          <span className={`referral-toggle-arrow ${referralOpen ? "open" : ""}`}>{">"}</span>
        </button>
        {referralOpen ? (
          <div className="referral-panel">
            {!walletAddress || !user ? (
              <p className="muted">Connect wallet to load referral data.</p>
            ) : (
              <>
                <p className="muted">{referralPairingNote}</p>
                <p className="muted">
                  Showing referral tree for wallet: <span className="mono">{walletAddress}</span>
                </p>
                <div className="referral-box">
                  <div>
                    <span>Your code</span>
                    <strong className="mono">{user.referralCode}</strong>
                    <small className="muted">
                      gain bonuses from your friends trading volume and from friends of friends
                    </small>
                  </div>
                  <div className="ref-link">
                    <span>Your link</span>
                    <strong className="mono">{referralLink}</strong>
                  </div>
                  <button
                    className="btn ghost tiny"
                    onClick={() => navigator.clipboard.writeText(referralLink).catch(() => {})}
                  >
                    Copy Link
                  </button>
                </div>
                {canManuallyAddReferrer ? (
                  <div className="referral-manual">
                    <p className="muted">I was referred to makeit by:</p>
                    <div className="approve-row">
                      <input
                        value={manualReferralCode}
                        onChange={(e) => setManualReferralCode(normalizeReferralCode(e.target.value))}
                        placeholder="Enter referral code"
                        maxLength={32}
                      />
                      <button
                        className="btn ghost"
                        disabled={manualReferralBusy}
                        onClick={applyManualReferral}
                      >
                        {manualReferralBusy ? "Applying..." : "Apply Referral Code"}
                      </button>
                    </div>
                  </div>
                ) : null}
                {user?.referredBy && referrals?.referrer ? (
                  <div className="referral-manual">
                    <p className="muted">I was referred to makeit by:</p>
                    <div className="sub-list-item">
                      <span className="mono">
                        {referrals.referrer.walletAddress}
                      </span>
                      <strong className="mono">
                        code {referrals.referrer.referralCode}
                      </strong>
                    </div>
                  </div>
                ) : null}
                {user?.referredBy && !(referrals?.tier1?.length > 0) ? (
                  <p className="muted">
                    This wallet is a referred account. Friends/Friends of friends list users referred by the current wallet.
                    Switch to your referrer wallet to see this account under Friends.
                  </p>
                ) : null}
                <div className="stats">
                  <div>
                    <span>Friends volume</span>
                    <strong>{fmt(referralLikeVolumeToNumber(referrals?.totals?.tier1Volume), 2)} USD</strong>
                  </div>
                  <div>
                    <span>Friends of friends volume</span>
                    <strong>{fmt(referralLikeVolumeToNumber(referrals?.totals?.tier2Volume), 2)} USD</strong>
                  </div>
                  <div>
                    <span>Total volume</span>
                    <strong>{fmt(referralLikeVolumeToNumber(referrals?.totals?.combinedVolume), 2)} USD</strong>
                  </div>
                  <div>
                    <span>Direct referrals</span>
                    <strong>{referrals?.tier1?.length || 0}</strong>
                  </div>
                </div>
                <div className="grid two">
                  <div className="sub-list">
                    <h3>Friends</h3>
                    {!referrals?.tier1?.length ? (
                      <p className="muted">No friends yet.</p>
                    ) : (
                      referrals.tier1.map((item) => (
                        <div key={item.walletAddress} className="sub-list-item">
                          <span className="mono">{item.walletAddress}</span>
                          <strong>{fmt(referralLikeVolumeToNumber(item.totalTradingVolume), 2)} USD</strong>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="sub-list">
                    <h3>Friends of friends</h3>
                    {!referrals?.tier2?.length ? (
                      <p className="muted">No friends of friends yet.</p>
                    ) : (
                      referrals.tier2.map((item) => (
                        <div key={`${item.parentWalletAddress}-${item.walletAddress}`} className="sub-list-item">
                          <span className="mono">{item.walletAddress}</span>
                          <strong>{fmt(referralLikeVolumeToNumber(item.totalTradingVolume), 2)} USD</strong>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        ) : null}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Open Trades ({openTrades.length})</h2>
        </div>
        {openTrades.length === 0 ? (
          <p className="muted">No open trades.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Side</th>
                  <th>Margin</th>
                  <th>Leverage</th>
                  <th>Entry</th>
                  <th>TP / SL</th>
                  <th>Live PnL</th>
                  <th>Progress to TP/SL</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {openTrades.map((trade) => {
                  const live = computeLive(trade, currentPrice);
                  const bar = computeTpSlBar(trade, currentPrice);
                  const direction = getTradeDirection(trade);
                  const tradeId = String(trade.onChainTradeId);
                  const isExpanded = expandedTradeId === tradeId;
                  const detailLines = buildTradeChartLines(trade, { strong: true, includeEntry: true, titlePrefix: "" });
                  return (
                    <Fragment key={tradeId}>
                      <tr key={tradeId}>
                        <td className="mono">{trade.onChainTradeId}</td>
                        <td>
                          <span className={`tag ${direction === "SHORT" ? "tag-short" : "tag-long"}`}>{direction}</span>
                        </td>
                        <td>{fmt(tradeMarginUsdc(trade), 2)}</td>
                        <td>{trade.leverage}x</td>
                        <td>{fmt(tradeEntryPriceUsdc(trade), 4)}</td>
                        <td>
                          <span className="mono">
                            TP {fmt(tradeTpPriceUsdc(trade), 4)} / SL {fmt(tradeSlPriceUsdc(trade), 4)}
                          </span>
                        </td>
                        <td className={live.pnl >= 0 ? "success" : "danger"}>
                          {live.pnl >= 0 ? "+" : ""}
                          {fmt(live.pnl, 2)} USD
                        </td>
                        <td>
                          <div className="tp-sl-meter">
                            <div className="tp-sl-track" />
                            <div
                              className={`tp-sl-fill ${bar.direction}`}
                              style={{ left: `${bar.fillFromPct}%`, width: `${bar.fillWidthPct}%` }}
                            />
                            <div className="tp-sl-zero" style={{ left: `${bar.zeroPct}%` }} />
                            <div className="tp-sl-zero-label" style={{ left: `${bar.zeroPct}%` }}>
                              0
                            </div>
                          </div>
                          <div className="tp-sl-labels">
                            <small className="muted">{direction === "SHORT" ? "PT" : "SL"}</small>
                            <small className="muted">{direction === "SHORT" ? "SL" : "PT"}</small>
                          </div>
                          <small className={bar.signedPct >= 0 ? "success" : "danger"}>
                            {bar.signedPct >= 0 ? "+" : ""}
                            {fmt(bar.signedPct, 1)}%
                          </small>
                        </td>
                        <td>
                          <div className="trade-row-actions">
                            <button
                              className="btn ghost tiny"
                              onClick={() => setExpandedTradeId(isExpanded ? null : tradeId)}
                            >
                              {isExpanded ? "Hide" : "Details"}
                            </button>
                            <button
                              className="btn ghost tiny"
                              disabled={busy}
                              onClick={() => closeTrade(trade.onChainTradeId)}
                            >
                              Close
                            </button>
                          </div>
                        </td>
                      </tr>
                      {isExpanded ? (
                        <tr key={`${tradeId}-details`} className="trade-detail-row">
                          <td colSpan={9}>
                            <div className="trade-detail-card">
                              <div className="trade-detail-meta">
                                <div>
                                  <span>Current Price</span>
                                  <strong>{fmt(currentPrice, 4)} USD</strong>
                                </div>
                                <div>
                                  <span>Entry / TP / SL</span>
                                  <strong>
                                    {fmt(tradeEntryPriceUsdc(trade), 4)} / {fmt(tradeTpPriceUsdc(trade), 4)} / {fmt(tradeSlPriceUsdc(trade), 4)}
                                  </strong>
                                </div>
                                <div>
                                  <span>Notional</span>
                                  <strong>{fmt(tradeMarginUsdc(trade) * Number(trade.leverage || 0), 2)} USD</strong>
                                </div>
                                <div>
                                  <span>Live PnL</span>
                                  <strong className={live.pnl >= 0 ? "success" : "danger"}>
                                    {live.pnl >= 0 ? "+" : ""}
                                    {fmt(live.pnl, 2)} USD
                                  </strong>
                                </div>
                              </div>
                              <PriceChart data={chartData} priceLines={detailLines} height={220} />
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Closed Trades ({closedTrades.length})</h2>
        </div>
        {closedTrades.length === 0 ? (
          <p className="muted">No closed trades yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Side</th>
                  <th>Leverage</th>
                  <th>Status</th>
                  <th>Opened</th>
                  <th>Closed</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>PnL</th>
                  <th>PnL Math</th>
                </tr>
              </thead>
              <tbody>
                {closedTrades.map((trade) => {
                  const closedPnl = displayClosedPnlUsdc(
                    trade,
                    baseTotalFeePpm,
                    protocol.feeScaleFactorPpm,
                    activeProtocolVariant
                  );
                  const pnlMath = explainClosedPnlMath(
                    trade,
                    baseTotalFeePpm,
                    protocol.feeScaleFactorPpm,
                    activeProtocolVariant
                  );
                  return (
                  <tr key={trade.onChainTradeId}>
                    <td className="mono">{trade.onChainTradeId}</td>
                    <td>
                      <span className={`tag ${getTradeDirection(trade) === "SHORT" ? "tag-short" : "tag-long"}`}>
                        {getTradeDirection(trade)}
                      </span>
                    </td>
                    <td>{trade.leverage}x</td>
                    <td>
                      <span className="tag">{closedStatusLabel(trade.status)}</span>
                    </td>
                    <td className="mono">{formatTradeTimestamp(trade.createdAt)}</td>
                    <td className="mono">{formatTradeTimestamp(trade.closedAt)}</td>
                    <td>{fmt(tradeEntryPriceUsdc(trade), 4)}</td>
                    <td className="mono" title={closeAtDisplay(trade)}>{closeAtDisplay(trade)}</td>
                    <td className={closedPnl >= 0 ? "success" : "danger"}>
                      {fmt(closedPnl, 2)}
                    </td>
                    <td className="muted">{pnlMath}</td>
                  </tr>
                )})}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
