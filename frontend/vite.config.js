import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react_vendor: ["react", "react-dom"],
          ethers_vendor: ["ethers"],
          charts_vendor: ["lightweight-charts"],
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    watch: {
      usePolling: true,
      interval: 150
    }
  }
});
