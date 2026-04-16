#!/usr/bin/env node
"use strict";

const http = require("node:http");
const https = require("node:https");
const { createReadStream, existsSync, readFileSync } = require("node:fs");
const { extname, join, normalize, resolve } = require("node:path");
const { URL } = require("node:url");

const root = process.cwd();
const distDir = resolve(root, "dist");
const publicPort = Number(process.env.PORT || 3000);
const backendBase = new URL(process.env.BACKEND_URL || `http://127.0.0.1:${process.env.BACKEND_PORT || 8787}`);
const rpcBaseRaw = process.env.FRONTEND_RPC_URL || process.env.RPC_URL || "";
const rpcBase = rpcBaseRaw ? new URL(rpcBaseRaw) : null;

const overlayEnabled = String(process.env.ENABLE_LOCAL_OVERLAYS || "true").toLowerCase() === "true";
const faucetOverlayPath = resolve(root, "overlays", "faucet-overlay.js");
const adminOverlayPath = resolve(root, "overlays", "admin-runner-overlay.js");
let overlayInjectionHtml = "";
if (overlayEnabled && existsSync(faucetOverlayPath) && existsSync(adminOverlayPath)) {
  const apiBase = process.env.LOCAL_FAUCET_API_BASE || "";
  const faucetOverlayCode = readFileSync(faucetOverlayPath, "utf8").replace(
    "__LOCAL_FAUCET_API_BASE__",
    JSON.stringify(apiBase)
  );
  const adminOverlayCode = readFileSync(adminOverlayPath, "utf8").replace(
    "__LOCAL_ADMIN_API_BASE__",
    JSON.stringify(apiBase)
  );
  overlayInjectionHtml = [
    `<script type="module">${faucetOverlayCode}</script>`,
    `<script type="module">${adminOverlayCode}</script>`,
  ].join("");
}

if (!existsSync(distDir)) {
  console.error(`[frontend-gateway] missing build output at ${distDir}. Run npm run build first.`);
  process.exit(1);
}

function proxyHttpToBase(req, res, base, reqPath) {
  const upstreamUrl = new URL(reqPath || "/", base);
  const client = upstreamUrl.protocol === "https:" ? https : http;

  const proxyReq = client.request(
    upstreamUrl,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: upstreamUrl.host,
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (error) => {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: `Upstream proxy failed: ${String(error?.message || error)}` }));
  });

  req.pipe(proxyReq);
}

function contentTypeFor(filePath) {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function serveSpaAsset(req, res) {
  const pathname = decodeURIComponent(new URL(req.url || "/", `http://127.0.0.1:${publicPort}`).pathname);
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const candidate = resolve(join(distDir, safePath === "/" ? "index.html" : safePath.slice(1)));

  const inDist = candidate.startsWith(distDir);
  const exists = inDist && existsSync(candidate);
  const target = exists ? candidate : resolve(distDir, "index.html");

  try {
    const isIndex = extname(target).toLowerCase() === ".html";
    if (overlayInjectionHtml && isIndex) {
      let html = readFileSync(target, "utf8");
      if (html.includes("</body>")) {
        html = html.replace("</body>", `${overlayInjectionHtml}</body>`);
      } else {
        html += overlayInjectionHtml;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(200, { "content-type": contentTypeFor(target) });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Unable to serve frontend asset");
  }
}

const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url || "/", `http://127.0.0.1:${publicPort}`);
  const pathname = urlObj.pathname;

  if ((pathname === "/rpc" || pathname.startsWith("/rpc/")) && rpcBase) {
    const rpcPath = urlObj.pathname.replace(/^\/rpc/, "") || "/";
    proxyHttpToBase(req, res, rpcBase, `${rpcPath}${urlObj.search || ""}`);
    return;
  }

  if (pathname.startsWith("/api/") || pathname === "/api" || pathname === "/ws") {
    proxyHttpToBase(req, res, backendBase, req.url || "/");
    return;
  }

  serveSpaAsset(req, res);
});

server.listen(publicPort, "0.0.0.0", () => {
  console.log(`[frontend-gateway] listening on http://0.0.0.0:${publicPort}`);
  console.log(`[frontend-gateway] backend proxied to ${backendBase.toString()}`);
  if (rpcBase) {
    console.log(`[frontend-gateway] rpc proxied at /rpc -> ${rpcBase.toString()}`);
  }
  if (overlayEnabled) {
    console.log("[frontend-gateway] overlays enabled (faucet/admin runner)");
  }
});