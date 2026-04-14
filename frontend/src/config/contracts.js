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

const generated = GENERATED_NETWORK || {};
const chainId = Number(appEnv.CHAIN_ID || generated.chainId || 31337);
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

export const ACTIVE_NETWORK = {
  chainId,
  chainHex: `0x${chainId.toString(16)}`,
  chainName: appEnv.CHAIN_NAME || generated.chainName || (chainId === 31337 ? "Anvil Local" : `Chain ${chainId}`),
  updatedAt: generated.updatedAt || "",
  makeit: makeitAddress,
  protocolVariant: "default",
  oracle: appEnv.ORACLE_ADDRESS || generated.oracle || "",
  swapAdapter: appEnv.SWAP_ADAPTER_ADDRESS || generated.swapAdapter || "",
  usdc: appEnv.USDC_ADDRESS || generated.usdc || "",
  usdt: appEnv.USDT_ADDRESS || generated.usdt || "",
  weth: appEnv.WETH_ADDRESS || generated.weth || "",
  usdcDecimals,
  usdtDecimals,
  wethDecimals,
  pool: appEnv.UNISWAP_POOL_ADDRESS || generated.pool || "",
  rpcUrl: normalizeLoopbackUrl(rpcRaw, rpcFallback),
  backendUrl: normalizeLoopbackUrl(backendRaw, backendFallback),
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
