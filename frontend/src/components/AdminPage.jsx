import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, Contract, Interface, JsonRpcProvider, formatUnits, parseUnits } from "ethers";
import { ACTIVE_NETWORK } from "../config/contracts";
import { MAKEIT_ABI } from "../abi/makeit";
import { ERC20_ABI } from "../abi/erc20";
import { apiGet } from "../lib/api";
import PriceChart from "./PriceChart";

const TABS = ["overview", "users", "trades", "stats", "liquidity", "contract"];
const RANGE_OPTIONS = ["15m", "1h", "6h", "1d"];
const RANGE_WINDOW_SECONDS = {
  "15m": 15 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "1d": 24 * 60 * 60,
};
const CONTRACT_GROUPS = [
  { key: "core", title: "Read Core", methods: ["owner", "pendingOwner", "USDC", "WETH", "getOraclePriceE18", "marginUSDC", "feeBps", "liquidityProvisionFeePpm", "protocolFeePpm", "feeScaleFactorPpm", "protocolFeeAccruedUSDC", "protocolFeeRecipient", "leverage", "maxLeverage", "tradingIsFrozen", "nextTradeId"] },
  { key: "liquidity", title: "Read Liquidity", methods: ["name", "symbol", "totalSupply", "totalAssets", "availableWithdrawalAssets", "openNotionalUSDC", "openMarginUSDC", "openLongNotionalUSDC", "openShortNotionalUSDC", "openLongMarginUSDC", "openShortMarginUSDC", "reservedMarginUSDC", "balanceOf", "maxDeposit", "maxWithdraw", "maxRedeem", "lpProvisionWhitelist", "lpProvisionMaxAssets", "lpProvisionUsedAssets"] },
  { key: "write", title: "Write Ops", methods: ["bootstrapVault", "deposit", "withdraw", "redeem", "fundETH", "fundStable", "rebalanceUsdcToEth", "sweepProtocolFees", "setFeeSplitPpm", "setFeeScaleFactorPpm", "setProtocolFeeRecipient", "configureLpProvision", "setTradingFrozen", "transferOwnership", "acceptOwnership"] },
];

function fmt(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtUsd(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return `${fmt(value, digits)} USDC`;
}

function fmtUsd6Raw(value, digits = 2) {
  return fmtUsd(usdc6ToNumber(value), digits);
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

function safeBigInt(value) {
  try {
    return BigInt(value ?? 0);
  } catch {
    return 0n;
  }
}

async function safeContractCall(contract, methodName, fallback, ...args) {
  try {
    const fn = contract?.[methodName];
    if (typeof fn !== "function") return fallback;
    return await fn(...args);
  } catch {
    return fallback;
  }
}

function parseArg(type, value) {
  const raw = String(value ?? "").trim();
  if (type === "bool") return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
  if (type.startsWith("uint") || type.startsWith("int")) return raw === "" ? 0n : BigInt(raw);
  return raw;
}

function fnKey(fragment) {
  return `${fragment.name}:${fragment.inputs.map((input) => input.type).join(",")}`;
}

function fnLabel(fragment) {
  return `${fragment.name}(${fragment.inputs.map((input) => `${input.type} ${input.name || ""}`.trim()).join(", ")})`;
}

function formatContractResult(fragment, result) {
  const name = fragment?.name || "";
  const usdc6Names = new Set([
    "marginUSDC",
    "openNotionalUSDC",
    "openMarginUSDC",
    "openLongNotionalUSDC",
    "openShortNotionalUSDC",
    "openLongMarginUSDC",
    "openShortMarginUSDC",
    "reservedMarginUSDC",
    "protocolFeeAccruedUSDC",
  ]);
  const weth18Names = new Set([
    "totalAssets",
    "availableWithdrawalAssets",
    "balanceOf",
    "maxDeposit",
    "maxWithdraw",
    "maxRedeem",
    "lpProvisionMaxAssets",
    "lpProvisionUsedAssets",
    "previewDeposit",
    "previewMint",
    "previewWithdraw",
    "previewRedeem",
    "convertToShares",
    "convertToAssets",
  ]);
  if (typeof result === "bigint") {
    if (usdc6Names.has(name)) return `${formatUnits(result, 6)} USDC`;
    if (weth18Names.has(name)) return `${formatUnits(result, 18)} WETH`;
  }
  return JSON.stringify(result, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function groupContractFunctions(functions) {
  const groups = CONTRACT_GROUPS.map((group) => ({
    ...group,
    functions: functions.filter((fragment) => group.methods.includes(fragment.name)),
  })).filter((group) => group.functions.length);
  const assigned = new Set(groups.flatMap((group) => group.functions.map((fragment) => fragment.name)));
  const other = functions.filter((fragment) => !assigned.has(fragment.name));
  if (other.length) groups.push({ key: "other", title: "Other", functions: other });
  return groups;
}

function tradeRow(trade) {
  const bought = e18ToNumber(trade?.boughtWeth || 0);
  const sold = e18ToNumber(trade?.soldWeth || 0);
  const settlement = bought > 0 ? `Bought ${fmt(bought, 6)}` : sold > 0 ? `Sold ${fmt(sold, 6)}` : "-";
  const margin = usdc6ToNumber(trade?.margin || 0);
  const entryPrice = e18ToNumber(trade?.entryPrice || 0);
  const exitPrice = e18ToNumber(trade?.exitPrice || 0);
  const pnl = usdc6ToNumber(trade?.pnl || 0);
  return (
    <tr key={`${trade.id}-${trade.onChainTradeId}`}>
      <td className="mono">{trade.onChainTradeId}</td>
      <td className="mono">{trade.user?.walletAddress || "-"}</td>
      <td>{trade.status}</td>
      <td>{trade.leverage}x</td>
      <td>{fmtUsd(margin, 2)}</td>
      <td>{fmtUsd(entryPrice, 4)}</td>
      <td>{trade.exitPrice ? fmtUsd(exitPrice, 4) : "-"}</td>
      <td>{fmtUsd(pnl, 2)}</td>
      <td className="mono">{settlement}</td>
    </tr>
  );
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
  return Math.max(15, Math.floor(windowSeconds / 60));
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
  const sorted = Array.from(latestByBucket.values()).sort((a, b) => a.time - b.time).map(({ time, value }) => ({ time, value }));
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
  if (at >= 0) ticks[at] = { time: bucketTime, value };
  else ticks.push({ time: bucketTime, value });
  return normalizeChartSeries(ticks, maxBucketsForRange(range));
}

function normalizePriceValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const human = numeric > 1_000_000_000 ? numeric / 1e18 : numeric;
  return Number(human.toFixed(4));
}

export default function AdminPage() {
  const readProvider = useMemo(() => new JsonRpcProvider(ACTIVE_NETWORK.rpcUrl), []);
  const [selectedTab, setSelectedTab] = useState("overview");
  const [auth, setAuth] = useState({
    username: localStorage.getItem("makeit.admin.username") || ACTIVE_NETWORK.adminDefaultUser || "admin",
    password: localStorage.getItem("makeit.admin.password") || ACTIVE_NETWORK.adminDefaultPassword || "admin123",
  });
  const [authed, setAuthed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [txBusy, setTxBusy] = useState(false);
  const [error, setError] = useState("");
  const [txStatus, setTxStatus] = useState("");
  const [overview, setOverview] = useState(null);
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [trades, setTrades] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [walletProvider, setWalletProvider] = useState(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [walletChainId, setWalletChainId] = useState(0);
  const [range, setRange] = useState("1h");
  const [chartData, setChartData] = useState([]);
  const [walletInfo, setWalletInfo] = useState(null);
  const [protocolState, setProtocolState] = useState(null);
  const [tradeFilter, setTradeFilter] = useState({ wallet: "", status: "" });
  const [liquidityForm, setLiquidityForm] = useState({
    whitelistAddress: "",
    whitelistEnabled: true,
    whitelistMaxAssets: "0",
    lpFeePpm: String(ACTIVE_NETWORK.feeConfig?.liquidityProvisionFeePpm || 70),
    protocolFeePpm: String(ACTIVE_NETWORK.feeConfig?.protocolFeePpm || 30),
    feeScaleFactorPpm: String(ACTIVE_NETWORK.feeConfig?.feeScaleFactorPpm || 1000000),
    protocolFeeRecipient: "",
    depositAssets: "1",
    withdrawAssets: "1",
    redeemShares: "1",
    bootstrapReceiver: "",
    freezeTrading: false,
    rebalanceSwapUsdc: "100",
    fundWeth: "0",
    fundUsdc: "0",
  });
  const [contractInputs, setContractInputs] = useState({});
  const [contractOutputs, setContractOutputs] = useState({});

  const activeMakeitAddress = ACTIVE_NETWORK.makeit || "";
  const activeInterface = useMemo(() => new Interface(MAKEIT_ABI), []);
  const readContract = useMemo(() => activeMakeitAddress ? new Contract(activeMakeitAddress, MAKEIT_ABI, readProvider) : null, [activeMakeitAddress, readProvider]);
  const writeContract = useMemo(() => walletProvider && activeMakeitAddress ? new Contract(activeMakeitAddress, MAKEIT_ABI, walletProvider) : null, [walletProvider, activeMakeitAddress]);
  const contractFunctions = useMemo(() => activeInterface.fragments.filter((fragment) => fragment.type === "function").sort((a, b) => a.name.localeCompare(b.name)), [activeInterface]);
  const groupedContractFunctions = useMemo(() => groupContractFunctions(contractFunctions), [contractFunctions]);

  const loadOverview = useCallback(() => apiGet("/api/admin/overview", { auth }).then(setOverview), [auth]);
  const loadStats = useCallback(() => apiGet("/api/admin/stats", { auth }).then(setStats), [auth]);
  const loadUsers = useCallback(() => apiGet("/api/admin/users?limit=200", { auth }).then((data) => setUsers(data?.users || [])), [auth]);
  const loadTrades = useCallback(() => {
    const params = new URLSearchParams({ limit: "200" });
    if (tradeFilter.wallet.trim()) params.set("wallet", tradeFilter.wallet.trim());
    if (tradeFilter.status.trim()) params.set("status", tradeFilter.status.trim());
    return apiGet(`/api/admin/trades?${params.toString()}`, { auth }).then((data) => setTrades(data?.trades || []));
  }, [auth, tradeFilter.wallet, tradeFilter.status]);
  const loadUserDetail = useCallback((wallet) => apiGet(`/api/admin/users/${wallet}`, { auth }).then(setSelectedUser), [auth]);
  const loadHistory = useCallback(async (selectedRange) => {
    const result = await apiGet(`/api/price/history?range=${selectedRange}`);
    const raw = (result?.samples || []).map((sample) => ({
      time: Math.floor(new Date(sample.timestamp).getTime() / 1000),
      value: normalizePriceValue(sample.price),
    }));
    const next = aggregateToCloseTicks(raw, selectedRange);
    setChartData(next);
  }, []);

  const loadProtocolState = useCallback(async () => {
    if (!readContract) return;
    try {
      const [price, feeBps, lpFee, protocolFee, scale, feeBucket, recipient, frozen, available, reserved, openLongNotional, openShortNotional, usdcAddress, wethAddress] = await Promise.all([
        safeContractCall(readContract, "getOraclePriceE18", 0n),
        safeContractCall(readContract, "feeBps", 0n),
        safeContractCall(readContract, "liquidityProvisionFeePpm", 70n),
        safeContractCall(readContract, "protocolFeePpm", 30n),
        safeContractCall(readContract, "feeScaleFactorPpm", 1000000n),
        safeContractCall(readContract, "protocolFeeAccruedUSDC", 0n),
        safeContractCall(readContract, "protocolFeeRecipient", ""),
        safeContractCall(readContract, "tradingIsFrozen", false),
        safeContractCall(readContract, "availableWithdrawalAssets", 0n),
        safeContractCall(readContract, "reservedMarginUSDC", 0n),
        safeContractCall(readContract, "openLongNotionalUSDC", 0n),
        safeContractCall(readContract, "openShortNotionalUSDC", 0n),
        safeContractCall(readContract, "USDC", ACTIVE_NETWORK.usdc || ""),
        safeContractCall(readContract, "WETH", ACTIVE_NETWORK.weth || ""),
      ]);
      const usdc = usdcAddress ? new Contract(usdcAddress, ERC20_ABI, readProvider) : null;
      const weth = wethAddress ? new Contract(wethAddress, ERC20_ABI, readProvider) : null;
      const [poolUsdcBalance, poolWethBalance] = await Promise.all([
        usdc ? usdc.balanceOf(activeMakeitAddress).catch(() => 0n) : Promise.resolve(0n),
        weth ? weth.balanceOf(activeMakeitAddress).catch(() => 0n) : Promise.resolve(0n),
      ]);
      const priceE18 = safeBigInt(price);
      const openLongNotionalUsdc6 = safeBigInt(openLongNotional);
      const openShortNotionalUsdc6 = safeBigInt(openShortNotional);
      const totalPoolUsdc6 = safeBigInt(poolUsdcBalance);
      const totalPoolWeth18 = safeBigInt(poolWethBalance);
      const ethPoolValueUsdc6 = priceE18 > 0n ? ((totalPoolWeth18 * priceE18) / 1000000000000000000n) / 1000000000000n : 0n;
      const netLongExposureUsdc6 = openLongNotionalUsdc6 > openShortNotionalUsdc6 ? openLongNotionalUsdc6 - openShortNotionalUsdc6 : 0n;
      const longCapacityUsdc6 = ethPoolValueUsdc6 > netLongExposureUsdc6 ? ethPoolValueUsdc6 - netLongExposureUsdc6 : 0n;
      const shortCapacityUsdc6 = openLongNotionalUsdc6 > openShortNotionalUsdc6 ? openLongNotionalUsdc6 - openShortNotionalUsdc6 : 0n;
      const reservedMarginUsdc6 = safeBigInt(reserved);
      const totalNetPoolUsdc6 = totalPoolUsdc6 > reservedMarginUsdc6 ? totalPoolUsdc6 - reservedMarginUsdc6 : 0n;
      setProtocolState({
        priceFormatted: formatUnits(price, 18),
        feePct: Number(feeBps) > 0 ? Number(feeBps) / 100 : (Number(lpFee) + Number(protocolFee)) / 10000,
        liquidityProvisionFeePpm: Number(lpFee),
        protocolFeePpm: Number(protocolFee),
        feeScaleFactorPpm: Number(scale),
        protocolFeeAccruedFormatted: formatUnits(feeBucket, 6),
        protocolFeeRecipient: recipient,
        tradingIsFrozen: Boolean(frozen),
        availableWithdrawalFormatted: formatUnits(available, 18),
        reservedMarginFormatted: formatUnits(reserved, 6),
        openLongNotionalFormatted: formatUnits(openLongNotionalUsdc6, 6),
        openShortNotionalFormatted: formatUnits(openShortNotionalUsdc6, 6),
        longCapacityFormatted: formatUnits(longCapacityUsdc6, 6),
        shortCapacityFormatted: formatUnits(shortCapacityUsdc6, 6),
        totalPoolUsdcFormatted: formatUnits(totalPoolUsdc6, 6),
        totalNetPoolUsdcFormatted: formatUnits(totalNetPoolUsdc6, 6),
        totalPoolWethFormatted: formatUnits(totalPoolWeth18, 18),
        totalPoolValueUsdcFormatted: formatUnits(totalNetPoolUsdc6 + ethPoolValueUsdc6, 6),
      });
    } catch {
      setProtocolState(null);
    }
  }, [readContract, readProvider, activeMakeitAddress]);

  const loadWalletInfo = useCallback(async () => {
    if (!walletAddress || !readContract) return setWalletInfo(null);
    try {
      const [shareBalance, whitelisted, maxAssets, usedAssets, maxDeposit, maxWithdraw, maxRedeem] = await Promise.all([
        readContract.balanceOf(walletAddress),
        readContract.lpProvisionWhitelist(walletAddress),
        readContract.lpProvisionMaxAssets(walletAddress),
        readContract.lpProvisionUsedAssets(walletAddress),
        readContract.maxDeposit(walletAddress),
        readContract.maxWithdraw(walletAddress),
        readContract.maxRedeem(walletAddress),
      ]);
      setWalletInfo({ shareBalance, whitelisted, maxAssets, usedAssets, maxDeposit, maxWithdraw, maxRedeem });
    } catch {
      setWalletInfo(null);
    }
  }, [walletAddress, readContract]);

  const refresh = useCallback(async () => {
    await Promise.all([loadOverview(), loadStats(), loadUsers(), loadTrades(), loadProtocolState(), loadWalletInfo()]);
  }, [loadOverview, loadStats, loadUsers, loadTrades, loadProtocolState, loadWalletInfo]);
  const pollLatestPrice = useCallback(async () => {
    const latest = await apiGet("/api/price/latest");
    const value = normalizePriceValue(latest?.price);
    if (!Number.isFinite(value)) return;
    const point = {
      time: Math.floor(new Date(latest.timestamp || Date.now()).getTime() / 1000),
      value,
    };
    setChartData((prev) => upsertLiveCloseTick(prev, point, range));
  }, [range]);

  const tryLogin = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await apiGet("/api/admin/stats", { auth });
      localStorage.setItem("makeit.admin.username", auth.username);
      localStorage.setItem("makeit.admin.password", auth.password);
      setAuthed(true);
    } catch (loginError) {
      setAuthed(false);
      setError(loginError?.message || "Admin login failed");
    } finally {
      setBusy(false);
    }
  }, [auth]);

  const connectWallet = useCallback(async () => {
    if (!window.ethereum) return setError("Wallet not found.");
    try {
      const browser = new BrowserProvider(window.ethereum);
      await browser.send("eth_requestAccounts", []);
      const signer = await browser.getSigner();
      const network = await browser.getNetwork();
      setWalletProvider(signer);
      setWalletAddress(await signer.getAddress());
      setWalletChainId(Number(network.chainId));
    } catch (walletError) {
      setError(walletError?.shortMessage || walletError?.message || "Wallet connection failed");
    }
  }, []);

  const runWrite = useCallback(async (label, fn) => {
    setTxBusy(true);
    setError("");
    setTxStatus(`${label} pending...`);
    try {
      const tx = await fn();
      setTxStatus(`${label} submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      if (Number(receipt?.status) !== 1) throw new Error(`${label} reverted`);
      setTxStatus(`${label} confirmed: ${receipt.hash}`);
      await Promise.all([loadProtocolState(), loadWalletInfo()]);
    } catch (txError) {
      setTxStatus("");
      setError(txError?.shortMessage || txError?.message || String(txError));
    } finally {
      setTxBusy(false);
    }
  }, [loadProtocolState, loadWalletInfo]);

  const approveToken = useCallback(async (tokenAddress, amount, label) => {
    if (!walletProvider || !activeMakeitAddress) return setError("Connect the admin wallet first.");
    await runWrite(label, async () => {
      const token = new Contract(tokenAddress, ERC20_ABI, walletProvider);
      return token.approve(activeMakeitAddress, amount);
    });
  }, [walletProvider, activeMakeitAddress, runWrite]);

  const handleLiquidityAction = useCallback(async (action) => {
    if (!writeContract) return setError("Connect the admin wallet first.");
    if (action === "configureWhitelist") return runWrite("Configure LP provision", () => writeContract.configureLpProvision(liquidityForm.whitelistAddress.trim(), Boolean(liquidityForm.whitelistEnabled), parseUnits(liquidityForm.whitelistMaxAssets || "0", 18)));
    if (action === "setFeeSplit") return runWrite("Set fee split", () => writeContract.setFeeSplitPpm(BigInt(liquidityForm.lpFeePpm || "0"), BigInt(liquidityForm.protocolFeePpm || "0")));
    if (action === "setFeeScaleFactor") return runWrite("Set fee scale factor", () => writeContract.setFeeScaleFactorPpm(BigInt(liquidityForm.feeScaleFactorPpm || "0")));
    if (action === "setRecipient") return runWrite("Set protocol fee recipient", () => writeContract.setProtocolFeeRecipient(liquidityForm.protocolFeeRecipient.trim()));
    if (action === "sweepFees") return runWrite("Sweep protocol fees", () => writeContract.sweepProtocolFees());
    if (action === "bootstrapVault") return runWrite("Bootstrap vault", () => writeContract.bootstrapVault((liquidityForm.bootstrapReceiver || walletAddress).trim()));
    if (action === "deposit") return runWrite("Deposit WETH", () => writeContract.deposit(parseUnits(liquidityForm.depositAssets || "0", 18), walletAddress));
    if (action === "withdraw") return runWrite("Withdraw WETH", () => writeContract.withdraw(parseUnits(liquidityForm.withdrawAssets || "0", 18), walletAddress, walletAddress));
    if (action === "redeem") return runWrite("Redeem shares", () => writeContract.redeem(parseUnits(liquidityForm.redeemShares || "0", 18), walletAddress, walletAddress));
    if (action === "freezeTrading") return runWrite("Set trading freeze", () => writeContract.setTradingFrozen(Boolean(liquidityForm.freezeTrading)));
    if (action === "rebalance") return runWrite("Swap USDC -> WETH", () => writeContract.rebalanceUsdcToEth(parseUnits(liquidityForm.rebalanceSwapUsdc || "0", 6)));
    if (action === "fundWeth") return runWrite("Fund WETH", () => writeContract.fundETH(parseUnits(liquidityForm.fundWeth || "0", 18)));
    if (action === "fundUsdc") return runWrite("Fund USDC", () => writeContract.fundStable(parseUnits(liquidityForm.fundUsdc || "0", 6)));
    return null;
  }, [writeContract, liquidityForm, walletAddress, runWrite]);

  const executeContractFunction = useCallback(async (fragment) => {
    const key = fnKey(fragment);
    const args = fragment.inputs.map((input, index) => parseArg(input.type, contractInputs[key]?.[index] ?? ""));
    const isRead = fragment.stateMutability === "view" || fragment.stateMutability === "pure";
    if (isRead) {
      try {
        const result = await readContract[fragment.name](...args);
        setContractOutputs((prev) => ({ ...prev, [key]: formatContractResult(fragment, result) }));
      } catch (callError) {
        setContractOutputs((prev) => ({ ...prev, [key]: callError?.shortMessage || callError?.message || String(callError) }));
      }
      return;
    }
    if (!writeContract) return setError("Connect the admin wallet first.");
    await runWrite(fragment.name, async () => {
      const tx = await writeContract[fragment.name](...args);
      setContractOutputs((prev) => ({ ...prev, [key]: `submitted: ${tx.hash}` }));
      return tx;
    });
  }, [contractInputs, readContract, writeContract, runWrite]);

  useEffect(() => {
    if (!authed) return undefined;
    refresh().catch(() => {});
    const timer = setInterval(() => { refresh().catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  }, [authed, refresh]);

  useEffect(() => {
    if (!authed) return undefined;
    loadHistory(range).catch(() => {});
    const timer = setInterval(() => {
      pollLatestPrice().catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [authed, loadHistory, pollLatestPrice, range]);

  useEffect(() => { loadWalletInfo().catch(() => {}); }, [loadWalletInfo]);

  useEffect(() => {
    if (!protocolState) return;
    setLiquidityForm((prev) => ({
      ...prev,
      whitelistAddress: prev.whitelistAddress || walletAddress || "",
      bootstrapReceiver: prev.bootstrapReceiver || walletAddress || "",
      protocolFeeRecipient: prev.protocolFeeRecipient || protocolState.protocolFeeRecipient || "",
      lpFeePpm: String(protocolState.liquidityProvisionFeePpm || prev.lpFeePpm || 70),
      protocolFeePpm: String(protocolState.protocolFeePpm || prev.protocolFeePpm || 30),
      feeScaleFactorPpm: String(protocolState.feeScaleFactorPpm || prev.feeScaleFactorPpm || 1000000),
    }));
  }, [protocolState, walletAddress]);

  const currentPrice = normalizePriceValue(protocolState?.priceFormatted || overview?.latestPrice?.price || 0);
  const feeTotals = useMemo(() => {
    const lpPpm = BigInt(protocolState?.liquidityProvisionFeePpm || 0);
    const protocolPpm = BigInt(protocolState?.protocolFeePpm || 0);
    const totalPpm = lpPpm + protocolPpm;
    if (totalPpm <= 0n) {
      return { lpUsdc: 0, protocolUsdc: 0 };
    }

    let lpFees6 = 0n;
    let protocolFees6 = 0n;
    for (const trade of trades || []) {
      const effectiveMargin6 = safeBigInt(trade?.margin || 0);
      const leverage = BigInt(Number(trade?.leverage || 0));
      const denominator = 1_000_000n - leverage * totalPpm;
      if (effectiveMargin6 <= 0n || leverage <= 0n || denominator <= 0n) continue;
      const grossMargin6 = (effectiveMargin6 * 1_000_000n + (denominator - 1n)) / denominator;
      lpFees6 += (grossMargin6 * leverage * lpPpm) / 1_000_000n;
      protocolFees6 += (grossMargin6 * leverage * protocolPpm) / 1_000_000n;
    }

    return {
      lpUsdc: usdc6ToNumber(lpFees6),
      protocolUsdc: usdc6ToNumber(protocolFees6),
    };
  }, [protocolState?.liquidityProvisionFeePpm, protocolState?.protocolFeePpm, trades]);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Admin Console</h1>
          <p>Shared admin surface for users, trades, statistics, liquidity, and direct contract access.</p>
        </div>
        <div className="topbar-actions">
          <span className="badge ok">Admin</span>
          <span className={`badge ${walletChainId === ACTIVE_NETWORK.chainId ? "ok" : "warn"}`}>{walletAddress ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}` : "Wallet disconnected"}</span>
          <button className="btn ghost" onClick={connectWallet}>{walletAddress ? "Reconnect Wallet" : "Connect Admin Wallet"}</button>
        </div>
      </header>

      {!authed ? (
        <section className="card">
          <div className="card-head"><h2>Admin Login</h2></div>
          <div className="admin-login-grid">
            <label>Username<input value={auth.username} onChange={(e) => setAuth((prev) => ({ ...prev, username: e.target.value }))} /></label>
            <label>Password<input type="password" value={auth.password} onChange={(e) => setAuth((prev) => ({ ...prev, password: e.target.value }))} /></label>
            <button className="btn solid" onClick={tryLogin} disabled={busy}>{busy ? "Checking..." : "Login"}</button>
          </div>
          {error ? <p className="danger">{error}</p> : null}
        </section>
      ) : (
        <>
          <section className="card">
            <div className="range-switch">
              {TABS.map((tab) => <button key={tab} className={`btn tiny ${selectedTab === tab ? "solid" : "ghost"}`} onClick={() => setSelectedTab(tab)}>{tab === "contract" ? "Contract Ops" : `${tab.charAt(0).toUpperCase()}${tab.slice(1)}`}</button>)}
            </div>
            <p className="muted" style={{ marginTop: "0.75rem" }}>Backend <span className="mono">{ACTIVE_NETWORK.backendUrl}</span> | Contract <span className="mono">{activeMakeitAddress || "-"}</span></p>
            {txStatus ? <p className="success">{txStatus}</p> : null}
            {error ? <p className="danger">{error}</p> : null}
          </section>

          {selectedTab === "overview" ? (
            <>
              <section className="grid two">
                <article className="card">
                  <div className="card chart-card" id="admin-overview-chart-card">
                    <div className="card-head"><h2>Live ETH Price</h2><strong>{currentPrice ? `${fmt(currentPrice, 4)} USDC` : "Loading..."}</strong></div>
                    <div className="range-switch">
                      {RANGE_OPTIONS.map((option) => (
                        <button key={option} className={`btn tiny ${range === option ? "solid" : "ghost"}`} onClick={() => setRange(option)}>
                          {option}
                        </button>
                      ))}
                    </div>
                    <PriceChart data={chartData} />
                  </div>
                </article>
                <article className="card">
                  <div className="card-head"><h2>Database Summary</h2><span className="badge ok">Shared BE</span></div>
                  {!overview?.summary ? <p className="muted">Loading summary...</p> : <div className="stats">
                    <div><span>Total Users</span><strong>{overview.summary.totalUsers}</strong></div>
                    <div><span>Total Trades</span><strong>{overview.summary.totalTrades}</strong></div>
                    <div><span>Open Trades</span><strong>{overview.summary.openTrades}</strong></div>
                    <div><span>Closed Trades</span><strong>{overview.summary.closedTrades}</strong></div>
                    <div><span>Liquidated Trades</span><strong>{overview.summary.liquidatedTrades}</strong></div>
                    <div><span>Total Margin</span><strong>{fmtUsd6Raw(overview.summary.totalMargin || 0, 2)}</strong></div>
                    <div><span>Open Margin</span><strong>{fmtUsd6Raw(overview.summary.openMargin || 0, 2)}</strong></div>
                    <div><span>Closed PnL</span><strong>{fmtUsd6Raw(overview.summary.closedPnl || 0, 2)}</strong></div>
                  </div>}
                </article>
              </section>
              <section className="card">
                <div className="card-head"><h2>Protocol Snapshot</h2><span className="badge ok">On-chain</span></div>
                {!protocolState ? <p className="muted">Loading protocol state...</p> : <>
                  <p className="muted" style={{ marginBottom: "0.75rem" }}>Fees</p>
                  <div className="stats" style={{ marginBottom: "1rem" }}>
                    <div><span>Base Fee</span><strong>{fmt(protocolState.feePct || 0, 2)}%</strong></div>
                    <div><span>LP Fee</span><strong>{fmt((protocolState.liquidityProvisionFeePpm || 0) / 10000, 4)}%</strong></div>
                    <div><span>Protocol Fee</span><strong>{fmt((protocolState.protocolFeePpm || 0) / 10000, 4)}%</strong></div>
                    <div><span>LP Fees Collected</span><strong>{fmtUsd(feeTotals.lpUsdc, 2)}</strong></div>
                    <div><span>Protocol Fees Collected</span><strong>{fmtUsd(feeTotals.protocolUsdc, 2)}</strong></div>
                  </div>
                  <p className="muted" style={{ marginBottom: "0.75rem" }}>Open Status</p>
                  <div className="stats" style={{ marginBottom: "1rem" }}>
                    <div><span>Long Notional Capacity</span><strong>{fmtUsd(Number(protocolState.longCapacityFormatted || 0), 2)}</strong></div>
                    <div><span>Short Notional Capacity</span><strong>{fmtUsd(Number(protocolState.shortCapacityFormatted || 0), 2)}</strong></div>
                    <div><span>Open Long Notional</span><strong>{fmtUsd(Number(protocolState.openLongNotionalFormatted || 0), 2)}</strong></div>
                    <div><span>Open Short Notional</span><strong>{fmtUsd(Number(protocolState.openShortNotionalFormatted || 0), 2)}</strong></div>
                    <div><span>Reserved Margin</span><strong>{fmtUsd(Number(protocolState.reservedMarginFormatted || 0), 2)}</strong></div>
                  </div>
                  <p className="muted" style={{ marginBottom: "0.75rem" }}>Pool Status</p>
                  <div className="stats" style={{ marginBottom: "1rem" }}>
                    <div><span>Total ETH In Pool</span><strong>{fmt(Number(protocolState.totalPoolWethFormatted || 0), 6)} WETH</strong></div>
                    <div><span>Total Net USDC In Pool</span><strong>{fmtUsd(Number(protocolState.totalNetPoolUsdcFormatted || 0), 2)}</strong></div>
                    <div><span>Total Pool USDC Value</span><strong>{fmtUsd(Number(protocolState.totalPoolValueUsdcFormatted || 0), 2)}</strong></div>
                  </div>
                  <div className="stats">
                    <div><span>Available Withdrawal</span><strong>{fmt(Number(protocolState.availableWithdrawalFormatted || 0), 6)} WETH</strong></div>
                    <div><span>Fee Recipient</span><strong className="mono">{protocolState.protocolFeeRecipient || "-"}</strong></div>
                    <div><span>Trading Frozen</span><strong>{protocolState.tradingIsFrozen ? "Yes" : "No"}</strong></div>
                  </div>
                </>}
              </section>
              <section className="grid two">
                <article className="card">
                  <div className="card-head"><h2>Recent Users</h2><span>{overview?.recentUsers?.length || 0}</span></div>
                  {!overview?.recentUsers?.length ? <p className="muted">No users yet.</p> : <div className="table-wrap"><table><thead><tr><th>Wallet</th><th>Referral</th><th>Created</th><th>Volume</th></tr></thead><tbody>
                    {overview.recentUsers.map((user) => <tr key={user.id} onClick={() => { setSelectedTab("users"); loadUserDetail(user.walletAddress).catch(() => {}); }} style={{ cursor: "pointer" }}><td className="mono">{user.walletAddress}</td><td className="mono">{user.referralCode}</td><td>{new Date(user.createdAt).toLocaleString()}</td><td>{fmtUsd(Number(user.totalTradingVolume || 0), 2)}</td></tr>)}
                  </tbody></table></div>}
                </article>
                <article className="card">
                  <div className="card-head"><h2>Recent Trades</h2><span>{overview?.recentTrades?.length || 0}</span></div>
                  {!overview?.recentTrades?.length ? <p className="muted">No trades indexed yet.</p> : <div className="table-wrap"><table><thead><tr><th>ID</th><th>User</th><th>Status</th><th>Lev</th><th>Margin</th><th>Entry</th><th>Exit</th><th>PnL</th><th>Settlement ETH</th></tr></thead><tbody>{overview.recentTrades.map(tradeRow)}</tbody></table></div>}
                </article>
              </section>
            </>
          ) : null}

          {selectedTab === "users" ? (
            <section className="grid two">
              <article className="card">
                <div className="card-head"><h2>Wallets / Users</h2><span>{users.length}</span></div>
                {!users.length ? <p className="muted">No users found.</p> : <div className="table-wrap"><table><thead><tr><th>Wallet</th><th>Referral</th><th>Total</th><th>Open</th><th>Closed</th><th>Liq</th><th>Volume</th><th>PnL</th></tr></thead><tbody>
                  {users.map((user) => <tr key={user.id} onClick={() => loadUserDetail(user.walletAddress).catch(() => {})} style={{ cursor: "pointer" }}><td className="mono">{user.walletAddress}</td><td className="mono">{user.referralCode}</td><td>{user.totalTrades}</td><td>{user.openTrades}</td><td>{user.closedTrades}</td><td>{user.liquidatedTrades}</td><td>{fmtUsd(Number(user.totalTradingVolume || 0), 2)}</td><td>{fmtUsd(Number(user.aggregatePnl || 0), 2)}</td></tr>)}
                </tbody></table></div>}
              </article>
              <article className="card">
                <div className="card-head"><h2>User Detail</h2></div>
                {!selectedUser ? <p className="muted">Select a wallet row to inspect details.</p> : <>
                  <div className="stats">
                    <div><span>Wallet</span><strong className="mono">{selectedUser.user?.walletAddress || "-"}</strong></div>
                    <div><span>Referral</span><strong className="mono">{selectedUser.user?.referralCode || "-"}</strong></div>
                    <div><span>Referrer</span><strong className="mono">{selectedUser.referrer?.walletAddress || "-"}</strong></div>
                    <div><span>Total Trades</span><strong>{selectedUser.tradeSummary?.total || 0}</strong></div>
                    <div><span>Open</span><strong>{selectedUser.tradeSummary?.open || 0}</strong></div>
                    <div><span>Closed</span><strong>{selectedUser.tradeSummary?.closed || 0}</strong></div>
                    <div><span>Liquidated</span><strong>{selectedUser.tradeSummary?.liquidated || 0}</strong></div>
                    <div><span>Volume</span><strong>{fmtUsd(Number(selectedUser.user?.totalTradingVolume || 0), 2)}</strong></div>
                  </div>
                  {selectedUser.trades?.length ? <div className="table-wrap"><table><thead><tr><th>ID</th><th>Status</th><th>Lev</th><th>Margin</th><th>Entry</th><th>Exit</th></tr></thead><tbody>
                    {selectedUser.trades.slice(0, 20).map((trade) => <tr key={trade.id}><td className="mono">{trade.onChainTradeId}</td><td>{trade.status}</td><td>{trade.leverage}x</td><td>{fmtUsd(usdc6ToNumber(trade.margin || 0), 2)}</td><td>{fmtUsd(e18ToNumber(trade.entryPrice || 0), 4)}</td><td>{trade.exitPrice ? fmtUsd(e18ToNumber(trade.exitPrice), 4) : "-"}</td></tr>)}
                  </tbody></table></div> : null}
                </>}
              </article>
            </section>
          ) : null}

          {selectedTab === "trades" ? (
            <section className="card">
              <div className="card-head"><h2>Trades</h2><span>{trades.length}</span></div>
              <div className="grid two">
                <label>Wallet Filter<input value={tradeFilter.wallet} onChange={(e) => setTradeFilter((prev) => ({ ...prev, wallet: e.target.value }))} placeholder="0x..." /></label>
                <label>Status<select value={tradeFilter.status} onChange={(e) => setTradeFilter((prev) => ({ ...prev, status: e.target.value }))}><option value="">all</option><option value="OPEN">OPEN</option><option value="CLOSED">CLOSED</option><option value="LIQUIDATED">LIQUIDATED</option></select></label>
              </div>
              <div className="actions" style={{ marginTop: "0.75rem" }}><button className="btn solid" onClick={() => loadTrades().catch((err) => setError(err?.message || "Failed to load trades"))}>Apply Filters</button><button className="btn ghost" onClick={() => { setTradeFilter({ wallet: "", status: "" }); setTimeout(() => loadTrades().catch(() => {}), 0); }}>Reset</button></div>
              {!trades.length ? <p className="muted">No trades found.</p> : <div className="table-wrap"><table><thead><tr><th>ID</th><th>User</th><th>Status</th><th>Lev</th><th>Margin</th><th>Entry</th><th>Exit</th><th>PnL</th><th>Settlement ETH</th></tr></thead><tbody>{trades.map(tradeRow)}</tbody></table></div>}
            </section>
          ) : null}

          {selectedTab === "stats" ? (
            <section className="card">
              <div className="card-head"><h2>Statistics</h2><span className="badge ok">DB</span></div>
              {!stats ? <p className="muted">Loading statistics...</p> : <div className="stats">
                <div><span>Total Users</span><strong>{stats.totalUsers}</strong></div>
                <div><span>Total Trades</span><strong>{stats.totalTrades}</strong></div>
                <div><span>Open Trades</span><strong>{stats.openTrades}</strong></div>
                <div><span>Closed Trades</span><strong>{stats.closedTrades}</strong></div>
                <div><span>Liquidated Trades</span><strong>{stats.liquidatedTrades}</strong></div>
                <div><span>Total Margin</span><strong>{fmtUsd6Raw(stats.totalMargin || 0, 2)}</strong></div>
                <div><span>Open Margin</span><strong>{fmtUsd6Raw(stats.openMargin || 0, 2)}</strong></div>
                <div><span>Closed PnL</span><strong>{fmtUsd6Raw(stats.closedPnl || 0, 2)}</strong></div>
                <div><span>Latest Price</span><strong>{stats.latestPrice?.price ? `${fmt(normalizePriceValue(stats.latestPrice.price), 4)} USDC` : "-"}</strong></div>
              </div>}
            </section>
          ) : null}

          {selectedTab === "liquidity" ? (
            <section className="grid two">
              <article className="card">
                <div className="card-head"><h2>Wallet LP Stats</h2></div>
                {!walletAddress ? <p className="muted">Connect the admin wallet to see per-wallet vault stats.</p> : <div className="stats">
                  <div><span>Whitelisted</span><strong>{walletInfo?.whitelisted ? "Yes" : "No"}</strong></div>
                  <div><span>Share Balance</span><strong>{fmt(Number(formatUnits(walletInfo?.shareBalance || 0n, 18)), 6)} mLP</strong></div>
                  <div><span>Quota Max</span><strong>{fmt(Number(formatUnits(walletInfo?.maxAssets || 0n, 18)), 6)} WETH</strong></div>
                  <div><span>Quota Used</span><strong>{fmt(Number(formatUnits(walletInfo?.usedAssets || 0n, 18)), 6)} WETH</strong></div>
                  <div><span>Max Deposit</span><strong>{fmt(Number(formatUnits(walletInfo?.maxDeposit || 0n, 18)), 6)} WETH</strong></div>
                  <div><span>Max Withdraw</span><strong>{fmt(Number(formatUnits(walletInfo?.maxWithdraw || 0n, 18)), 6)} WETH</strong></div>
                  <div><span>Max Redeem</span><strong>{fmt(Number(formatUnits(walletInfo?.maxRedeem || 0n, 18)), 6)} mLP</strong></div>
                </div>}
              </article>
              <article className="card">
                <div className="card-head"><h2>Liquidity Controls</h2></div>
                <div className="grid two">
                  <label>Whitelist Address<input value={liquidityForm.whitelistAddress} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, whitelistAddress: e.target.value }))} placeholder="0x..." /></label>
                  <label>Quota Max WETH<input value={liquidityForm.whitelistMaxAssets} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, whitelistMaxAssets: e.target.value }))} /></label>
                  <label>Whitelisted<select value={String(liquidityForm.whitelistEnabled)} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, whitelistEnabled: e.target.value === "true" }))}><option value="true">true</option><option value="false">false</option></select></label>
                  <div className="actions" style={{ alignSelf: "end" }}><button className="btn solid" disabled={txBusy} onClick={() => handleLiquidityAction("configureWhitelist")}>Save Quota</button></div>
                  <label>LP Fee PPM<input value={liquidityForm.lpFeePpm} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, lpFeePpm: e.target.value }))} /></label>
                  <label>Protocol Fee PPM<input value={liquidityForm.protocolFeePpm} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, protocolFeePpm: e.target.value }))} /></label>
                  <div className="actions" style={{ alignSelf: "end" }}><button className="btn solid" disabled={txBusy} onClick={() => handleLiquidityAction("setFeeSplit")}>Set Fee Split</button></div>
                  <label>Fee Scale Factor PPM<input value={liquidityForm.feeScaleFactorPpm} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, feeScaleFactorPpm: e.target.value }))} /></label>
                  <div className="actions" style={{ alignSelf: "end" }}><button className="btn ghost" disabled={txBusy} onClick={() => handleLiquidityAction("setFeeScaleFactor")}>Set Scale Factor</button></div>
                  <label>Protocol Fee Recipient<input value={liquidityForm.protocolFeeRecipient} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, protocolFeeRecipient: e.target.value }))} placeholder="0x..." /></label>
                  <div className="actions" style={{ alignSelf: "end" }}><button className="btn ghost" disabled={txBusy} onClick={() => handleLiquidityAction("setRecipient")}>Set Recipient</button><button className="btn ghost" disabled={txBusy} onClick={() => handleLiquidityAction("sweepFees")}>Sweep Fees</button></div>
                  <div className="actions" style={{ gridColumn: "1 / -1" }}><button className="btn ghost" disabled={txBusy} onClick={() => approveToken(ACTIVE_NETWORK.weth, parseUnits("1000000", 18), "Approve WETH Max")}>Approve WETH Max</button><button className="btn ghost" disabled={txBusy} onClick={() => approveToken(ACTIVE_NETWORK.usdc, parseUnits("1000000", 6), "Approve USDC Max")}>Approve USDC Max</button></div>
                  <label>Bootstrap Receiver<input value={liquidityForm.bootstrapReceiver} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, bootstrapReceiver: e.target.value }))} placeholder="0x..." /></label>
                  <div className="actions" style={{ alignSelf: "end" }}><button className="btn ghost" disabled={txBusy} onClick={() => handleLiquidityAction("bootstrapVault")}>Bootstrap Vault</button></div>
                  <label>Deposit WETH<input value={liquidityForm.depositAssets} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, depositAssets: e.target.value }))} /></label>
                  <label>Withdraw WETH<input value={liquidityForm.withdrawAssets} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, withdrawAssets: e.target.value }))} /></label>
                  <label>Redeem Shares<input value={liquidityForm.redeemShares} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, redeemShares: e.target.value }))} /></label>
                  <div className="actions" style={{ alignSelf: "end" }}><button className="btn solid" disabled={txBusy} onClick={() => handleLiquidityAction("deposit")}>Deposit</button><button className="btn ghost" disabled={txBusy} onClick={() => handleLiquidityAction("withdraw")}>Withdraw</button><button className="btn ghost" disabled={txBusy} onClick={() => handleLiquidityAction("redeem")}>Redeem</button></div>
                  <label>Freeze New Trades<select value={String(liquidityForm.freezeTrading)} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, freezeTrading: e.target.value === "true" }))}><option value="false">false</option><option value="true">true</option></select></label>
                  <div className="actions" style={{ alignSelf: "end" }}><button className="btn ghost" disabled={txBusy} onClick={() => handleLiquidityAction("freezeTrading")}>Apply Freeze</button></div>
                  <label>Rebalance USDC<input value={liquidityForm.rebalanceSwapUsdc} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, rebalanceSwapUsdc: e.target.value }))} /></label>
                  <div className="actions" style={{ alignSelf: "end" }}><button className="btn ghost" disabled={txBusy} onClick={() => handleLiquidityAction("rebalance")}>Rebalance</button></div>
                  <label>Fund WETH<input value={liquidityForm.fundWeth} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, fundWeth: e.target.value }))} /></label>
                  <label>Fund USDC<input value={liquidityForm.fundUsdc} onChange={(e) => setLiquidityForm((prev) => ({ ...prev, fundUsdc: e.target.value }))} /></label>
                  <div className="actions" style={{ alignSelf: "end" }}><button className="btn ghost" disabled={txBusy} onClick={() => handleLiquidityAction("fundWeth")}>Fund WETH</button><button className="btn ghost" disabled={txBusy} onClick={() => handleLiquidityAction("fundUsdc")}>Fund USDC</button></div>
                </div>
              </article>
            </section>
          ) : null}

          {selectedTab === "contract" ? (
            <section className="card">
              <div className="card-head"><h2>Contract Ops</h2><span className="muted">Grouped direct reads and writes</span></div>
              <div className="contract-groups">
                {groupedContractFunctions.map((group) => <section key={group.key} className="contract-group-card">
                  <div className="card-head"><h2>{group.title}</h2><span className="badge ok">{group.functions.length} methods</span></div>
                  <div className="contract-method-list">
                    {group.functions.map((fragment) => {
                      const key = fnKey(fragment);
                      const isRead = fragment.stateMutability === "view" || fragment.stateMutability === "pure";
                      return <div key={key} className="contract-call-card">
                        <div className="card-head"><h3>{fnLabel(fragment)}</h3><span className={`badge ${isRead ? "ok" : "warn"}`}>{isRead ? "Read" : "Write"}</span></div>
                        {fragment.inputs.length ? <div className="grid two">
                          {fragment.inputs.map((input, index) => <label key={`${key}-${index}`}>{input.name || `arg${index}`} <span className="mono">({input.type})</span><input value={contractInputs[key]?.[index] || ""} onChange={(e) => setContractInputs((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), [index]: e.target.value } }))} placeholder={input.type} /></label>)}
                        </div> : <p className="muted">No inputs</p>}
                        <div className="actions"><button className="btn solid" disabled={txBusy && !isRead} onClick={() => executeContractFunction(fragment)}>{isRead ? "Run" : txBusy ? "Submitting..." : "Send"}</button></div>
                        {contractOutputs[key] ? <pre className="mono" style={{ whiteSpace: "pre-wrap", marginTop: "0.75rem" }}>{contractOutputs[key]}</pre> : null}
                      </div>;
                    })}
                  </div>
                </section>)}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
