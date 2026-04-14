import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(__dirname, "..", "..", "frontend");
const overlayPath = resolve(__dirname, "faucet-overlay.js");
const adminOverlayPath = resolve(__dirname, "admin-runner-overlay.js");

const apiBase = process.env.LOCAL_FAUCET_API_BASE || "http://127.0.0.1:8787";
const overlayCode = readFileSync(overlayPath, "utf8").replace(
  "__LOCAL_FAUCET_API_BASE__",
  JSON.stringify(apiBase)
);
const adminOverlayCode = readFileSync(adminOverlayPath, "utf8").replace(
  "__LOCAL_ADMIN_API_BASE__",
  JSON.stringify(apiBase)
);

export default {
  root: frontendRoot,
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  plugins: [
    {
      name: "local-faucet-overlay",
      transformIndexHtml() {
        return [
          {
            tag: "script",
            attrs: { type: "module" },
            children: overlayCode,
            injectTo: "body",
          },
          {
            tag: "script",
            attrs: { type: "module" },
            children: adminOverlayCode,
            injectTo: "body",
          },
        ];
      },
    },
  ],
  define: {
    __APP_ENV__: JSON.stringify({
      PUBLIC_MODE: process.env.PUBLIC_MODE || "",
      LOCAL_MODE: process.env.LOCAL_MODE || "",
      RPC_URL: process.env.RPC_URL || "",
      CHAIN_ID: process.env.CHAIN_ID || "",
      CHAIN_NAME: process.env.CHAIN_NAME || "",
      BACKEND_URL: process.env.BACKEND_URL || "",
      MAKEIT_ADDRESS: process.env.MAKEIT_ADDRESS || "",
      ORACLE_ADDRESS: process.env.ORACLE_ADDRESS || "",
      SWAP_ADAPTER_ADDRESS: process.env.SWAP_ADAPTER_ADDRESS || "",
      UNISWAP_POOL_ADDRESS: process.env.UNISWAP_POOL_ADDRESS || "",
      USDC_ADDRESS: process.env.USDC_ADDRESS || "",
      USDT_ADDRESS: process.env.USDT_ADDRESS || "",
      WETH_ADDRESS: process.env.WETH_ADDRESS || "",
      ADMIN_USERNAME: process.env.ADMIN_USERNAME || "",
      ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "",
      LP_FEE_PPM: process.env.LP_FEE_PPM || "",
      PROTOCOL_FEE_PPM: process.env.PROTOCOL_FEE_PPM || "",
      FEE_SCALE_FACTOR_PPM: process.env.FEE_SCALE_FACTOR_PPM || "",
    }),
  },
  server: {
    host: true,
    strictPort: true,
    watch: {
      usePolling: true,
      interval: 150,
    },
  },
};
