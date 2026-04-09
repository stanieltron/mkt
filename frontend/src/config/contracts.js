import { GENERATED_NETWORK } from "../generated/network.generated.js";

function normalizeLoopbackUrl(rawValue, fallbackValue) {
  const candidate = rawValue || fallbackValue;
  if (!candidate) return candidate;

  try {
    const parsed = new URL(candidate);
    if (typeof window !== "undefined" && window.location?.hostname) {
      const browserHost = window.location.hostname;
      if (["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
        parsed.hostname = browserHost;
      }
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return candidate;
  }
}

const generated = GENERATED_NETWORK || {};
const chainId = Number(import.meta.env.VITE_CHAIN_ID || generated.chainId || 31337);
const runtimeHost =
  typeof window !== "undefined" && window.location?.hostname ? window.location.hostname : "127.0.0.1";
const backendFallback = `http://${runtimeHost}:8787`;
const rpcFallback = `http://${runtimeHost}:8545`;
const backendRaw = import.meta.env.VITE_BACKEND_URL || generated.backendUrl || "";
const rpcRaw = import.meta.env.VITE_RPC_URL || generated.rpcUrl || "";
const makeitAddress = import.meta.env.VITE_MAKEIT_ADDRESS || generated.makeit || "";

const defaultLpFeePpm = Number(import.meta.env.VITE_LP_FEE_PPM || generated.lpFeePpm || 70);
const defaultProtocolFeePpm = Number(import.meta.env.VITE_PROTOCOL_FEE_PPM || generated.protocolFeePpm || 30);
const defaultFeeScaleFactorPpm = Number(import.meta.env.VITE_FEE_SCALE_FACTOR_PPM || generated.feeScaleFactorPpm || 1_000_000);

export const ACTIVE_NETWORK = {
  chainId,
  chainHex: `0x${chainId.toString(16)}`,
  chainName: import.meta.env.VITE_CHAIN_NAME || generated.chainName || (chainId === 31337 ? "Anvil Local" : `Chain ${chainId}`),
  updatedAt: generated.updatedAt || "",
  makeit: makeitAddress,
  protocolVariant: "default",
  oracle: import.meta.env.VITE_ORACLE_ADDRESS || generated.oracle || "",
  swapAdapter: import.meta.env.VITE_SWAP_ADAPTER_ADDRESS || generated.swapAdapter || "",
  usdc: import.meta.env.VITE_USDC_ADDRESS || generated.usdc || "",
  usdt: import.meta.env.VITE_USDT_ADDRESS || generated.usdt || "",
  weth: import.meta.env.VITE_WETH_ADDRESS || generated.weth || "",
  pool: import.meta.env.VITE_UNISWAP_POOL_ADDRESS || generated.pool || "",
  rpcUrl: normalizeLoopbackUrl(rpcRaw, rpcFallback),
  backendUrl: normalizeLoopbackUrl(backendRaw, backendFallback),
  feeConfig: {
    liquidityProvisionFeePpm: defaultLpFeePpm,
    protocolFeePpm: defaultProtocolFeePpm,
    feeScaleFactorPpm: defaultFeeScaleFactorPpm,
  },
  localMode:
    String(import.meta.env.VITE_LOCAL_MODE || String(generated.localMode || "false")).toLowerCase() === "true",
  publicMode:
    String(import.meta.env.VITE_PUBLIC_MODE || "false").toLowerCase() === "true",
  adminDefaultUser: import.meta.env.VITE_ADMIN_USERNAME || generated.adminDefaultUser || "",
  adminDefaultPassword: import.meta.env.VITE_ADMIN_PASSWORD || generated.adminDefaultPassword || "",
};
