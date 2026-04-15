import { GENERATED_NETWORK } from "../generated/network.generated.js";
const appEnv = typeof __APP_ENV__ === "object" && __APP_ENV__ ? __APP_ENV__ : {};

function normalizeLoopbackUrl(rawValue, fallbackValue) {
  const candidate = rawValue || fallbackValue;
  if (!candidate) return candidate;

  try {
    const parsed = new URL(candidate);
    if (typeof window !== "undefined" && window.location?.hostname) {
      const browserHost = window.location.hostname;
      const normalizedBrowserHost =
        browserHost === "localhost" || browserHost === "::1" || browserHost === "[::1]"
          ? "127.0.0.1"
          : browserHost;
      if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
        parsed.hostname = normalizedBrowserHost;
      }
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return candidate;
  }
}

function localRpcProxyUrl() {
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin.replace(/\/$/, "")}/rpc`;
  }
  return "";
}

const generated = GENERATED_NETWORK || {};
const runtimeHost =
  typeof window !== "undefined" && window.location?.hostname ? window.location.hostname : "127.0.0.1";
const backendFallback =
  typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : `http://${runtimeHost}:8787`;
const rpcFallback = `http://${runtimeHost}:8545`;
const backendRaw = appEnv.BACKEND_URL || generated.backendUrl || "";
const rpcRaw = appEnv.RPC_URL || generated.rpcUrl || "";
const makeitAddress = appEnv.MAKEIT_ADDRESS || generated.makeit || "";

const defaultLpFeePpm = Number(appEnv.LP_FEE_PPM || generated.lpFeePpm || 70);
const defaultProtocolFeePpm = Number(appEnv.PROTOCOL_FEE_PPM || generated.protocolFeePpm || 30);
const defaultFeeScaleFactorPpm = Number(appEnv.FEE_SCALE_FACTOR_PPM || generated.feeScaleFactorPpm || 1_000_000);
const usdcDecimals = Number(appEnv.USDC_DECIMALS || generated.usdcDecimals || 6);
const usdtDecimals = Number(appEnv.USDT_DECIMALS || generated.usdtDecimals || 6);
const wethDecimals = Number(appEnv.WETH_DECIMALS || generated.wethDecimals || 18);

function toChainHex(chainId) {
  const n = Number(chainId || 31337);
  return `0x${n.toString(16)}`;
}

export const ACTIVE_NETWORK = {
  chainId: Number(appEnv.CHAIN_ID || generated.chainId || 31337),
  chainHex: toChainHex(Number(appEnv.CHAIN_ID || generated.chainId || 31337)),
  chainName:
    appEnv.CHAIN_NAME ||
    generated.chainName ||
    (Number(appEnv.CHAIN_ID || generated.chainId || 31337) === 31337 ? "Anvil Local" : `Chain ${Number(appEnv.CHAIN_ID || generated.chainId || 31337)}`),
  updatedAt: generated.updatedAt || "",
  makeit: makeitAddress,
  protocolVariant: "default",
  oracle: appEnv.ORACLE_ADDRESS || generated.oracle || "",
  swapAdapter: appEnv.SWAP_ADAPTER_ADDRESS || generated.swapAdapter || "",
  usdc: appEnv.USDC_ADDRESS || generated.usdc || "",
  usdt: appEnv.USDT_ADDRESS || generated.usdt || "",
  weth: appEnv.WETH_ADDRESS || generated.weth || "",
  runnerAddress: appEnv.RUNNER_ADDRESS || generated.runnerAddress || "",
  swapperAddress: appEnv.SWAPPER_ADDRESS || generated.swapperAddress || "",
  faucetAddress: appEnv.FAUCET_ADDRESS || generated.faucetAddress || "",
  usdcDecimals,
  usdtDecimals,
  wethDecimals,
  pool: appEnv.UNISWAP_POOL_ADDRESS || generated.pool || "",
  rpcUrl:
    String(appEnv.LOCAL_MODE || String(generated.localMode || "false")).toLowerCase() === "true"
      ? localRpcProxyUrl() || normalizeLoopbackUrl(rpcRaw, rpcFallback)
      : normalizeLoopbackUrl(rpcRaw, rpcFallback),
  backendUrl: normalizeLoopbackUrl(appEnv.BACKEND_URL || generated.backendUrl || "", backendFallback),
  feeConfig: {
    liquidityProvisionFeePpm: defaultLpFeePpm,
    protocolFeePpm: defaultProtocolFeePpm,
    feeScaleFactorPpm: defaultFeeScaleFactorPpm,
  },
  localMode:
    String(appEnv.LOCAL_MODE || String(generated.localMode || "false")).toLowerCase() === "true",
  publicMode:
    String(appEnv.PUBLIC_MODE || "false").toLowerCase() === "true",
  adminDefaultUser: appEnv.ADMIN_USERNAME || generated.adminDefaultUser || "",
  adminDefaultPassword: appEnv.ADMIN_PASSWORD || generated.adminDefaultPassword || "",
};

function applyRuntimeConfig(data) {
  if (!data || typeof data !== "object") return;

  if (data.chainId != null) ACTIVE_NETWORK.chainId = Number(data.chainId);
  ACTIVE_NETWORK.chainHex = toChainHex(ACTIVE_NETWORK.chainId);
  if (data.chainName) ACTIVE_NETWORK.chainName = String(data.chainName);
  if (data.protocolVariant) ACTIVE_NETWORK.protocolVariant = String(data.protocolVariant);
  if (data.makeit) ACTIVE_NETWORK.makeit = String(data.makeit);
  if (data.oracle) ACTIVE_NETWORK.oracle = String(data.oracle);
  if (data.swapAdapter) ACTIVE_NETWORK.swapAdapter = String(data.swapAdapter);
  if (data.pool) ACTIVE_NETWORK.pool = String(data.pool);
  if (data.usdc) ACTIVE_NETWORK.usdc = String(data.usdc);
  if (data.usdt) ACTIVE_NETWORK.usdt = String(data.usdt);
  if (data.weth) ACTIVE_NETWORK.weth = String(data.weth);
  if (data.runnerAddress) ACTIVE_NETWORK.runnerAddress = String(data.runnerAddress);
  if (data.swapperAddress) ACTIVE_NETWORK.swapperAddress = String(data.swapperAddress);
  if (data.faucetAddress) ACTIVE_NETWORK.faucetAddress = String(data.faucetAddress);
  if (data.localMode === true) {
    ACTIVE_NETWORK.rpcUrl = localRpcProxyUrl() || normalizeLoopbackUrl(String(data.rpcUrl || ""), rpcFallback);
  } else if (data.rpcUrl) {
    ACTIVE_NETWORK.rpcUrl = normalizeLoopbackUrl(String(data.rpcUrl), rpcFallback);
  }

  if (data.backendUrl) {
    ACTIVE_NETWORK.backendUrl = normalizeLoopbackUrl(String(data.backendUrl), backendFallback);
  } else if (typeof window !== "undefined" && window.location?.origin) {
    ACTIVE_NETWORK.backendUrl = window.location.origin.replace(/\/$/, "");
  }

  if (data.feeConfig && typeof data.feeConfig === "object") {
    ACTIVE_NETWORK.feeConfig = {
      liquidityProvisionFeePpm: Number(data.feeConfig.liquidityProvisionFeePpm || ACTIVE_NETWORK.feeConfig.liquidityProvisionFeePpm || 70),
      protocolFeePpm: Number(data.feeConfig.protocolFeePpm || ACTIVE_NETWORK.feeConfig.protocolFeePpm || 30),
      feeScaleFactorPpm: Number(data.feeConfig.feeScaleFactorPpm || ACTIVE_NETWORK.feeConfig.feeScaleFactorPpm || 1_000_000),
    };
  }

  if (typeof data.localMode === "boolean") ACTIVE_NETWORK.localMode = data.localMode;
  if (typeof data.publicMode === "boolean") ACTIVE_NETWORK.publicMode = data.publicMode;
  if (data.adminDefaultUser) ACTIVE_NETWORK.adminDefaultUser = String(data.adminDefaultUser);
  if (data.adminDefaultPassword) ACTIVE_NETWORK.adminDefaultPassword = String(data.adminDefaultPassword);
  ACTIVE_NETWORK.updatedAt = new Date().toISOString();
}

export async function initializeActiveNetwork() {
  if (typeof window === "undefined") return ACTIVE_NETWORK;
  try {
    const response = await fetch("/api/config", { method: "GET" });
    if (!response.ok) return ACTIVE_NETWORK;
    const data = await response.json();
    applyRuntimeConfig(data);
  } catch {
  }
  return ACTIVE_NETWORK;
}
