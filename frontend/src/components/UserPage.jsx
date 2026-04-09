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
  { pace: "Slow", leverage: 100 },
  { pace: "Fast", leverage: 200 },
  { pace: "Faster", leverage: 300 },
];
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
const BACKEND_PRICE_POLL_MS = 1_000;
const BACKEND_TRADES_POLL_MS = 1_000;
const ONCHAIN_PROTOCOL_POLL_MS = 1_000;

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
    return "USDC transfer failed. Approve USDC first, and make sure the wallet has enough USDC balance.";
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
    return Number(formatUnits(BigInt(value), 6));
  } catch {
    return 0;
  }
}

function e18ToNumber(value) {
  try {
    return Number(formatUnits(BigInt(value), 18));
  } catch {
    return 0;
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
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const human = numeric > 1_000_000_000 ? numeric / 1e18 : numeric;
  return Number(human.toFixed(4));
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

function targetProfitPpmForGrossPlusTen(grossMarginUsdc6, totalFeePpm) {
  const gross = BigInt(grossMarginUsdc6 || 0n);
  const feePpm = BigInt(totalFeePpm || 0n);
  if (gross <= 0n) return 1_000_000n;

  // Fee is charged from gross margin on open, so TP must be scaled from net margin.
  const fee = (gross * feePpm) / PROFIT_PPM_SCALE;
  const net = gross - fee;
  if (net <= 0n) return 1_000_000n;

  // We target payout ~= 2x gross margin (net + pnl = 2 * gross), so desired pnl is gross + fee.
  const desiredPnl = gross + fee;
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

function buildTradePreview(side, leverage, currentPrice, marginUsdc6, totalFeePpm) {
  const entryPrice = Number(currentPrice || 0);
  const grossMargin = usdc6ToNumber(marginUsdc6 || 0n);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(grossMargin) || grossMargin <= 0) {
    return null;
  }

  const totalFee = BigInt(totalFeePpm || 0n);
  const tpPpm = targetProfitPpmForGrossPlusTen(marginUsdc6, totalFee);
  const tpMoveFraction = moveFractionFromPpm(tpPpm, leverage);
  const slMoveFraction = 1 / Number(leverage || 1);
  const netMarginUsdc6 = grossToNetMarginUsdc6(marginUsdc6, totalFee);
  const netMarginUsdc = usdc6ToNumber(netMarginUsdc6);
  const feeUsdc = grossMargin - netMarginUsdc;
  const netProfitUsdc = netMarginUsdc * Number(tpPpm) / 1_000_000;
  const payoutUsdc = netMarginUsdc + netProfitUsdc;

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
    grossMarginUsdc: grossMargin,
    takeProfitPnlUsdc: netProfitUsdc,
    stopLossPnlUsdc: grossMargin,
    payoutUsdc,
    requiredUsdc6: BigInt(marginUsdc6 || 0n).toString(),
  };
}

function buildTradeChartLines(trade, { strong = false, includeEntry = false, titlePrefix = "" } = {}) {
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
    lines.push({
      value: tp,
      color: strong ? "rgba(42, 222, 134, 0.95)" : "rgba(42, 222, 134, 0.38)",
      title: strong ? `${prefix}TP` : `${prefix}TP`,
      lineWidth: strong ? 3 : 1,
      axisLabelVisible: true,
      lastValueVisible: true,
    });
  }
  if (Number.isFinite(sl) && sl > 0) {
    lines.push({
      value: sl,
      color: strong ? "rgba(255, 107, 99, 0.95)" : "rgba(255, 107, 99, 0.34)",
      title: strong ? `${prefix}SL` : `${prefix}SL`,
      lineWidth: strong ? 3 : 1,
      axisLabelVisible: true,
      lastValueVisible: true,
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
    if (!Number.isFinite(time) || !Number.isFinite(value)) continue;
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
  const [usdcDecimals, setUsdcDecimals] = useState(6);
  const [ethBalance, setEthBalance] = useState(0);
  const [pendingTrade, setPendingTrade] = useState(null);
  const [expandedTradeId, setExpandedTradeId] = useState(null);
  const [approvalPrompt, setApprovalPrompt] = useState(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalCustom, setApprovalCustom] = useState("");
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
  const referralFetchStateRef = useRef({
    unavailable: false,
    inFlight: false,
    lastAttemptAt: 0,
  });
  const backendPollStateRef = useRef({
    lastPriceAt: 0,
    lastTradesAt: 0,
  });
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

  const pollLatestPrice = useCallback(async () => {
    const latest = await apiGet("/api/price/latest");
    const value = normalizeDisplayPrice(latest.price);
    if (!Number.isFinite(value) || value <= 0) return;
    const point = {
      time: Math.floor(new Date(latest.timestamp).getTime() / 1000),
      value,
    };

    setCurrentPrice(value);
    setChartData((prev) => {
      return upsertLiveCloseTick(prev, point, range);
    });
  }, [range]);

  const loadTrades = useCallback(async (wallet) => {
    if (!wallet) return;
    if (activeProtocolVariant !== backendProtocolVariant) {
      setOpenTrades([]);
      setClosedTrades([]);
      setOptimisticOpenTrades([]);
      return;
    }
    const data = await apiGet(`/api/trades?wallet=${wallet}`);
    const nextClosedTrades = data.closedTrades || [];
    const nextOpenTrades = data.openTrades || [];
    const syncedIds = new Set(nextOpenTrades.map((item) => String(item?.onChainTradeId || "")));
    const closedIds = new Set(nextClosedTrades.map((item) => String(item?.onChainTradeId || "")));
    setClosedTrades(nextClosedTrades);
    setOptimisticOpenTrades((prev) => {
      const filtered = prev.filter((trade) => {
        const id = String(trade?.onChainTradeId || "");
        return id && !syncedIds.has(id) && !closedIds.has(id);
      });
      setOpenTrades(mergeSyncedAndOptimisticOpenTrades(nextOpenTrades, filtered, nextClosedTrades));
      return filtered;
    });
  }, [activeProtocolVariant, backendProtocolVariant]);

  const loadReferrals = useCallback(async (wallet) => {
    if (!wallet) return;
    const now = Date.now();
    if (referralsUnavailable || referralFetchStateRef.current.unavailable || referralFetchStateRef.current.inFlight) return;
    if (now - referralFetchStateRef.current.lastAttemptAt < REFERRAL_REFRESH_INTERVAL_MS) return;

    referralFetchStateRef.current.inFlight = true;
    referralFetchStateRef.current.lastAttemptAt = now;
    try {
      const data = await apiGet(`/api/users/${wallet}/referrals`);
      setReferrals(data);
      setReferralsUnavailable(false);
      referralFetchStateRef.current.unavailable = false;
    } catch (referralError) {
      if (referralError?.status === 404) {
        setReferralsUnavailable(true);
        referralFetchStateRef.current.unavailable = true;
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
  }, [referralsUnavailable]);

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

  const refreshAfterTradeAction = useCallback(
      async (wallet, tradeId = null) => {
        const backendSyncOk = await requestBackendTradeSync(tradeId);
        let backendRefreshOk = backendSyncOk;
        try {
          await Promise.all([loadTrades(wallet), loadReferrals(wallet)]);
      } catch (refreshError) {
        backendRefreshOk = false;
        console.warn("[backend] post-trade refresh failed", refreshError);
      }
      await Promise.all([loadUsdcBalance(wallet), loadEthBalance(wallet)]);
      return backendRefreshOk;
    },
      [requestBackendTradeSync, loadTrades, loadReferrals, loadUsdcBalance, loadEthBalance]
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
        loadTrades(wallet.toLowerCase()),
        loadUsdcBalance(wallet.toLowerCase()),
        loadEthBalance(wallet.toLowerCase()),
      ]);
    },
    [loadTrades, loadUsdcBalance, loadEthBalance, loginUser]
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
        loadTrades(nextWallet).catch(() => {}),
        loadUsdcBalance(nextWallet).catch(() => {}),
        loadEthBalance(nextWallet).catch(() => {}),
      ]);
      setStatus("Wallet switched to the account currently selected in MetaMask.");
    } catch {
    }
  }, [walletProvider, walletAddress, loginUser, loadTrades, loadUsdcBalance, loadEthBalance]);

  const switchToConfiguredChain = useCallback(async () => {
    if (!walletProvider || !window.ethereum) {
      setError("Connect wallet first");
      return false;
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
            params: [
              {
                chainId: ACTIVE_NETWORK.chainHex,
                chainName: ACTIVE_NETWORK.chainName,
                rpcUrls: [ACTIVE_NETWORK.rpcUrl],
                nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
              },
            ],
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
        const profitTargetArg = targetProfitPpmForGrossPlusTen(
          protocol.marginUsdc6,
          totalFeePpm
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
        profitTarget: targetProfitPpmForGrossPlusTen(protocol.marginUsdc6, totalFeePpm).toString(),
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
    [activeMakeitAddress, activeMakeitAbi, activeProtocolVariant, baseTotalFeePpm, currentPrice, oracleRead, protocol.feeScaleFactorPpm, protocol.marginUsdc6]
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
            `Insufficient USDC balance. Need ${formatUnits(marginUsdc6, usdcDecimals)} USDC, wallet has ${formatUnits(displayedSpendState.balance, usdcDecimals)} USDC.`
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
        if (signer && decoded.includes("USDC transfer failed")) {
          const signerAddress = (await signer.getAddress()).toLowerCase();
          const marginUsdc6 = protocol.marginUsdc6 > 0n ? protocol.marginUsdc6 : 10_000_000n;
          const spendState = await getUsdcSpendState(signer, signerAddress);
          if (spendState.balance < marginUsdc6) {
            setError(
              `Insufficient USDC balance. Need ${formatUnits(marginUsdc6, usdcDecimals)} USDC, wallet has ${formatUnits(spendState.balance, usdcDecimals)} USDC.`
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
        setStatus(`Approving USDC... ${tx.hash}`);
        const receipt = await tx.wait();
        logTxCompleted("approveUSDC", receipt);
        if (!receipt || Number(receipt.status) !== 1) {
          throw new Error("USDC approval transaction reverted.");
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
      loadTrades(walletAddress).catch(reportBackgroundError);
    }
  }, [activeProtocolVariant, walletAddress, loadTrades, reportBackgroundError]);

    useEffect(() => {
      if (!walletAddress) {
        setApprovalPrompt(null);
        setPendingTrade(null);
        setExpandedTradeId(null);
        previousWalletAddressRef.current = "";
        return;
      }
      if (previousWalletAddressRef.current && previousWalletAddressRef.current !== walletAddress) {
        setApprovalPrompt(null);
        setPendingTrade(null);
        setExpandedTradeId(null);
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
      const now = Date.now();
      if (now - backendPollStateRef.current.lastPriceAt >= BACKEND_PRICE_POLL_MS) {
        backendPollStateRef.current.lastPriceAt = now;
        pollLatestPrice().catch(() => {});
      }
      loadProtocol().catch(() => {});
      if (walletAddress) {
        if (now - backendPollStateRef.current.lastTradesAt >= BACKEND_TRADES_POLL_MS) {
          backendPollStateRef.current.lastTradesAt = now;
          loadTrades(walletAddress).catch(() => {});
        }
        loadUsdcBalance(walletAddress).catch(() => {});
        loadEthBalance(walletAddress).catch(() => {});
      }
    }, ONCHAIN_PROTOCOL_POLL_MS);
    return () => clearInterval(timer);
  }, [pollLatestPrice, loadProtocol, walletAddress, loadTrades, loadUsdcBalance, loadEthBalance]);

  useEffect(() => {
    if (!walletAddress || !user || user.walletAddress !== walletAddress || referralsUnavailable) return;
    const timer = setInterval(() => {
      loadReferrals(walletAddress).catch(() => {});
    }, REFERRAL_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [walletAddress, user, loadReferrals, referralsUnavailable]);

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

  const referralLink = user ? `${window.location.origin}/?ref=${user.referralCode}` : "";
  const referralPairingNote = useMemo(() => {
    if (!walletAddress) return "";
    if (user?.referredBy) return "Referral pairing locked for this wallet.";
    if (pendingReferralCode) {
      return `Auto-pairing active from referral link (${pendingReferralCode}). Each connected wallet will be linked if not already paired.`;
    }
    return "No referral code pending. Share your code to invite others.";
  }, [walletAddress, user?.referredBy, pendingReferralCode]);

  const presetViews = useMemo(
    () =>
      TRADE_PRESETS.map((preset) => {
        const totalFeePpm = totalFeePpmForTrade(
          baseTotalFeePpm,
          preset.leverage,
          protocol.feeScaleFactorPpm,
          activeProtocolVariant
        );
        const tpPpm = targetProfitPpmForGrossPlusTen(protocol.marginUsdc6, totalFeePpm);
        const feeUsdc = Number(formatUnits((protocol.marginUsdc6 * totalFeePpm) / PROFIT_PPM_SCALE, 6));
        const movePct = movePctForDisplay(tpPpm, preset.leverage);
        const lossPct = movePctForDisplay(PROFIT_PPM_SCALE, preset.leverage);
        return { ...preset, movePct, lossPct, feeUsdc };
      }),
    [activeProtocolVariant, baseTotalFeePpm, protocol.feeScaleFactorPpm, protocol.marginUsdc6]
  );
  const previewTradeSelection = useCallback(
    (side, leverage) => {
      const totalFeePpm = totalFeePpmForTrade(
        baseTotalFeePpm,
        leverage,
        protocol.feeScaleFactorPpm,
        activeProtocolVariant
      );
      const preview = buildTradePreview(side, leverage, currentPrice, protocol.marginUsdc6, totalFeePpm);
      if (!preview) {
        setError("Price preview is not ready yet. Wait for the live price to load and try again.");
        return;
      }
      setError("");
      setStatus("");
      setApprovalPrompt(null);
      setPendingTrade(preview);
    },
    [activeProtocolVariant, baseTotalFeePpm, currentPrice, protocol.feeScaleFactorPpm, protocol.marginUsdc6]
  );
  const chartPriceLines = useMemo(() => {
    const openTradeLines = openTrades.flatMap((trade) => buildTradeChartLines(trade));
    if (!pendingTrade) return openTradeLines;
    return [
      ...openTradeLines,
      ...buildTradeChartLines(
        {
          entryPrice: parseUnits(String(pendingTrade.entryPrice), 18),
          tpPrice: parseUnits(String(pendingTrade.tpPrice), 18),
          slPrice: parseUnits(String(pendingTrade.slPrice), 18),
        },
        { strong: true, includeEntry: true }
      ),
    ];
  }, [openTrades, pendingTrade]);
  const anyShortPresetAvailable = useMemo(() => {
    if (!protocolSupportsShorts || protocol.marginUsdc6 <= 0n) return false;
    return TRADE_PRESETS.some((preset) => protocol.marginUsdc6 * BigInt(preset.leverage) <= shortCapacityUsdc6);
  }, [protocolSupportsShorts, protocol.marginUsdc6, shortCapacityUsdc6]);

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
                {fmt(usdcBalance, Math.min(6, Math.max(2, usdcDecimals)))} USDC | {fmt(ethBalance, 4)} ETH
              </span>
            </button>
          ) : (
            <button className="btn solid" onClick={() => connectWallet(true)}>
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      <section className="card chart-card chart-card-wide">
        <div className="card-head">
          <h2>Live ETH Price</h2>
          <strong>{currentPrice ? `${fmt(currentPrice, 4)} USDC` : "Loading..."}</strong>
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
        <div className="card-head">
          <h2>Trade Setup</h2>
          <span className="muted">Current open PnL: {totalOpenPnl >= 0 ? "+" : ""}{fmt(totalOpenPnl, 2)} USDC</span>
        </div>
        {tradeActionsBlockedByBackendVariant ? (
          <p className="warning">
            Backend sync is active for {backendProtocolVariant.toUpperCase()}. Switch back to that protocol to trade and view synced trades.
          </p>
        ) : null}
        <p className="quick-copy">
          I place <strong>{fmt(Number(formatUnits(protocol.marginUsdc6 || 0n, 6)), 2)} USD</strong> that ETH{" "}
          <span className="brand-inline">makeit</span>
        </p>
        <div className="trade-speed-row">
          {presetViews.map((preset) => (
            <span key={`${preset.leverage}-pace`}>{preset.pace}</span>
          ))}
        </div>
        <div className="trade-direction-grid">
          <div className="trade-direction-group">
            <div className="trade-group-head">
              <h3>Long</h3>
            </div>
            <div className="trade-preset-grid">
              {presetViews.map((preset) => (
                <button
                  key={`long-${preset.leverage}`}
                  className="btn trade-option trade-option-long"
                  disabled={!walletAddress || busy || tradeActionsBlockedByBackendVariant}
                  onClick={() => previewTradeSelection("LONG", preset.leverage)}
                >
                  <span className="trade-title">
                    +{preset.movePct} (receive <span className="trade-gain">$20.00</span>)
                  </span>
                  <small className="trade-hint">net +$10.00, fee ${fmt(preset.feeUsdc, 2)}, if -{preset.lossPct} lose $10.00</small>
                </button>
              ))}
            </div>
          </div>
          {protocolSupportsShorts ? (
            <div className="trade-direction-group">
              <div className="trade-group-head">
                <h3>Short</h3>
              </div>
              <div className="trade-preset-grid">
                {presetViews.map((preset) => (
                  <button
                    key={`short-${preset.leverage}`}
                    className="btn trade-option trade-option-short"
                    disabled={
                      !walletAddress ||
                      busy ||
                      tradeActionsBlockedByBackendVariant ||
                      protocol.marginUsdc6 * BigInt(preset.leverage) > shortCapacityUsdc6
                    }
                    onClick={() => previewTradeSelection("SHORT", preset.leverage)}
                  >
                    <span className="trade-title">
                      -{preset.movePct} (receive <span className="trade-gain">$20.00</span>)
                    </span>
                    <small className="trade-hint">net +$10.00, fee ${fmt(preset.feeUsdc, 2)}, if +{preset.lossPct} lose $10.00</small>
                  </button>
                ))}
              </div>
              {!anyShortPresetAvailable ? <p className="muted">Short trades are not currently available.</p> : null}
            </div>
          ) : null}
        </div>
        {pendingTrade ? (
          <div className="trade-preview-card">
            <div className="card-head">
              <h3>{pendingTrade.side === "SHORT" ? "Short" : "Long"} Preview</h3>
              <span className={`tag ${pendingTrade.side === "SHORT" ? "tag-short" : "tag-long"}`}>
                {pendingTrade.leverage}x
              </span>
            </div>
            <p className="muted">
              If price {pendingTrade.side === "SHORT" ? "drops" : "rises"} {fmt(pendingTrade.tpMovePct, pendingTrade.tpMovePct >= 1 ? 2 : 3)}% to{" "}
              {fmt(pendingTrade.tpPrice, 4)}, you realize about +{fmt(pendingTrade.takeProfitPnlUsdc, 2)} USDC and receive about{" "}
              {fmt(pendingTrade.payoutUsdc, 2)} USDC back.
            </p>
            <p className="muted">
              If price {pendingTrade.side === "SHORT" ? "rises" : "falls"} {fmt(pendingTrade.slMovePct, pendingTrade.slMovePct >= 1 ? 2 : 3)}% to{" "}
              {fmt(pendingTrade.slPrice, 4)}, you lose about {fmt(pendingTrade.stopLossPnlUsdc, 2)} USDC. Entry:{" "}
              {fmt(pendingTrade.entryPrice, 4)}. Fee on open: {fmt(pendingTrade.feeUsdc, 2)} USDC.
            </p>
            <div className="trade-preview-actions">
              <button
                className="btn solid"
                disabled={busy || approvalBusy || !walletAddress}
                onClick={() => openTrade(pendingTrade.side, pendingTrade.leverage)}
              >
                {busy ? "Submitting..." : `Confirm ${pendingTrade.side === "SHORT" ? "Short" : "Long"} Trade`}
              </button>
              <button className="btn ghost" disabled={busy || approvalBusy} onClick={() => setPendingTrade(null)}>
                Cancel Preview
              </button>
            </div>
          </div>
        ) : (
          <p className="muted">Choose a long or short button to preview TP/SL on the chart before confirming the trade.</p>
        )}
        {approvalPrompt ? (
          <div ref={approvalCardRef} className="card trade-inline-card">
            <div className="card-head">
              <h2 style={{ fontSize: "0.95rem" }}>USDC Approval Required</h2>
            </div>
            <p className="muted">
              Approve USDC for this {approvalPrompt.side === "SHORT" ? "short" : "long"} trade first. Required now:{" "}
              {fmt(Number(formatUnits(BigInt(approvalPrompt.requiredUsdc6), usdcDecimals)), 4)} USDC
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
                placeholder="Custom USDC amount"
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
        <div className="card-head">
          <h2>Referral</h2>
        </div>
        {!walletAddress || !user ? (
          <p className="muted">Connect wallet to load referral data.</p>
        ) : (
          <>
            <p className="muted">{referralPairingNote}</p>
            <div className="referral-box">
              <div>
                <span>Your code</span>
                <strong className="mono">{user.referralCode}</strong>
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
            <div className="stats">
              <div>
                <span>Tier 1 volume</span>
                <strong>{fmt(Number(referrals?.totals?.tier1Volume || 0), 2)} USDC</strong>
              </div>
              <div>
                <span>Tier 2 volume</span>
                <strong>{fmt(Number(referrals?.totals?.tier2Volume || 0), 2)} USDC</strong>
              </div>
              <div>
                <span>Total volume</span>
                <strong>{fmt(Number(referrals?.totals?.combinedVolume || 0), 2)} USDC</strong>
              </div>
              <div>
                <span>Direct referrals</span>
                <strong>{referrals?.tier1?.length || 0}</strong>
              </div>
            </div>
            <div className="grid two">
              <div className="sub-list">
                <h3>Tier 1 Referrals</h3>
                {!referrals?.tier1?.length ? (
                  <p className="muted">No direct referrals yet.</p>
                ) : (
                  referrals.tier1.map((item) => (
                    <div key={item.walletAddress} className="sub-list-item">
                      <span className="mono">{item.walletAddress}</span>
                      <strong>{fmt(Number(item.totalTradingVolume), 2)} USDC</strong>
                    </div>
                  ))
                )}
              </div>
              <div className="sub-list">
                <h3>Tier 2 Referrals</h3>
                {!referrals?.tier2?.length ? (
                  <p className="muted">No tier 2 referrals yet.</p>
                ) : (
                  referrals.tier2.map((item) => (
                    <div key={`${item.parentWalletAddress}-${item.walletAddress}`} className="sub-list-item">
                      <span className="mono">{item.walletAddress}</span>
                      <strong>{fmt(Number(item.totalTradingVolume), 2)} USDC</strong>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
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
                  <th>Lev</th>
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
                          {fmt(live.pnl, 2)} USDC
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
                                  <strong>{fmt(currentPrice, 4)} USDC</strong>
                                </div>
                                <div>
                                  <span>Entry / TP / SL</span>
                                  <strong>
                                    {fmt(tradeEntryPriceUsdc(trade), 4)} / {fmt(tradeTpPriceUsdc(trade), 4)} / {fmt(tradeSlPriceUsdc(trade), 4)}
                                  </strong>
                                </div>
                                <div>
                                  <span>Notional</span>
                                  <strong>{fmt(tradeMarginUsdc(trade) * Number(trade.leverage || 0), 2)} USDC</strong>
                                </div>
                                <div>
                                  <span>Live PnL</span>
                                  <strong className={live.pnl >= 0 ? "success" : "danger"}>
                                    {live.pnl >= 0 ? "+" : ""}
                                    {fmt(live.pnl, 2)} USDC
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
                  <th>Status</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>PnL</th>
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
                  const exit = tradeExitPriceUsdc(trade);
                  return (
                  <tr key={trade.onChainTradeId}>
                    <td className="mono">{trade.onChainTradeId}</td>
                    <td>
                      <span className={`tag ${getTradeDirection(trade) === "SHORT" ? "tag-short" : "tag-long"}`}>
                        {getTradeDirection(trade)}
                      </span>
                    </td>
                    <td>
                      <span className="tag">{closedStatusLabel(trade.status)}</span>
                    </td>
                    <td>{fmt(tradeEntryPriceUsdc(trade), 4)}</td>
                    <td>{Number.isFinite(exit) && exit > 0 ? fmt(exit, 4) : "-"}</td>
                    <td className={closedPnl >= 0 ? "success" : "danger"}>
                      {fmt(closedPnl, 2)}
                    </td>
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
