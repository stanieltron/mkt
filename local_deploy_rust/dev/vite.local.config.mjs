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
};
