#!/usr/bin/env node
"use strict";

const http = require("node:http");
const https = require("node:https");
const { spawn } = require("node:child_process");
const { createReadStream, existsSync, readFileSync } = require("node:fs");
const { extname, join, normalize, resolve } = require("node:path");
const { URL } = require("node:url");

const root = process.cwd();
const distDir = resolve(root, "frontend", "dist");
const cliLocalMode = process.argv.includes("--local");
const localMode = cliLocalMode || String(process.env.LOCAL_MODE || "").toLowerCase() === "true";
const publicPort = Number(process.env.PORT || process.env.FRONTEND_PORT || 3000);
const backendPort = Number(process.env.BACKEND_INTERNAL_PORT || process.env.BACKEND_PORT || 8788);
const relayPort = Number(process.env.BACKEND_RELAY_PORT || 8787);
const backendBase = new URL(
  process.env.BACKEND_INTERNAL_URL || `http://127.0.0.1:${localMode ? relayPort : backendPort}`
);
const rpcBaseRaw = process.env.FRONTEND_RPC_URL || process.env.RPC_URL || "";
const rpcBase = rpcBaseRaw ? new URL(rpcBaseRaw) : null;
const backendBin = resolve(
  root,
  "backend",
  "target",
  "release",
  process.platform === "win32" ? "makeit-backend.exe" : "makeit-backend"
);
const faucetOverlayPath = resolve(root, "local_deploy_rust", "dev", "faucet-overlay.js");
const adminOverlayPath = resolve(root, "local_deploy_rust", "dev", "admin-runner-overlay.js");
const startupAdminUser = process.env.ADMIN_USERNAME || "admin";
const startupAdminPass = process.env.ADMIN_PASSWORD || "admin123";

let overlayInjectionHtml = "";
if (localMode && existsSync(faucetOverlayPath) && existsSync(adminOverlayPath)) {
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
  console.error(`[start-stack] missing frontend build output at ${distDir}. Run npm run build first.`);
  process.exit(1);
}

if (!existsSync(backendBin)) {
  console.error(`[start-stack] missing backend binary at ${backendBin}. Run npm run build first.`);
  process.exit(1);
}

const backendEnv = {
  ...process.env,
  PORT: String(backendPort),
};

const backend = spawn(backendBin, {
  cwd: root,
  env: backendEnv,
  stdio: "inherit",
  shell: false,
});
let relay = null;
if (localMode) {
  relay = spawn("node", [resolve(root, "local_deploy_rust", "dev", "local-backend-relay.js")], {
    cwd: root,
    env: {
      ...process.env,
      BACKEND_PORT: String(relayPort),
      LOCAL_BACKEND_UPSTREAM_PORT: String(backendPort),
      LOCAL_BACKEND_UPSTREAM_URL: `http://127.0.0.1:${backendPort}`,
    },
    stdio: "inherit",
    shell: false,
  });
}

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    backend.kill("SIGTERM");
  } catch {}
  if (relay) {
    try {
      relay.kill("SIGTERM");
    } catch {}
  }
  setTimeout(() => {
    try {
      backend.kill("SIGKILL");
    } catch {}
    if (relay) {
      try {
        relay.kill("SIGKILL");
      } catch {}
    }
    process.exit(code);
  }, 1200);
}

backend.on("exit", (code) => {
  if (shuttingDown) return;
  console.error(`[start-stack] backend exited with code ${code ?? 0}`);
  shutdown(code ?? 1);
});
if (relay) {
  relay.on("exit", (code) => {
    if (shuttingDown) return;
    console.error(`[start-stack] relay exited with code ${code ?? 0}`);
    shutdown(code ?? 1);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function writeUpgradeResponse(socket, statusCode, statusMessage, headers = {}) {
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) lines.push(`${key}: ${entry}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("", "");
  socket.write(lines.join("\r\n"));
}

function proxyWebSocket(req, socket, head) {
  const upstreamUrl = new URL(req.url || "/", backendBase);
  const client = upstreamUrl.protocol === "https:" ? https : http;
  const proxyReq = client.request(upstreamUrl, {
    method: req.method || "GET",
    headers: {
      ...req.headers,
      host: upstreamUrl.host,
      connection: "Upgrade",
      upgrade: req.headers.upgrade || "websocket",
    },
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    writeUpgradeResponse(
      socket,
      proxyRes.statusCode || 101,
      proxyRes.statusMessage || "Switching Protocols",
      proxyRes.headers
    );
    if (proxyHead && proxyHead.length > 0) socket.write(proxyHead);
    if (head && head.length > 0) proxySocket.write(head);
    socket.pipe(proxySocket);
    proxySocket.pipe(socket);
  });

  proxyReq.on("response", (proxyRes) => {
    writeUpgradeResponse(
      socket,
      proxyRes.statusCode || 502,
      proxyRes.statusMessage || "Bad Gateway",
      proxyRes.headers
    );
    socket.destroy();
  });

  proxyReq.on("error", () => {
    try {
      writeUpgradeResponse(socket, 502, "Bad Gateway", { "content-type": "text/plain" });
    } catch {}
    socket.destroy();
  });

  proxyReq.end();
}

function proxyHttp(req, res) {
  return proxyHttpToBase(req, res, backendBase, req.url || "/");
}

function basicAuthHeader(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
}

function requestJson(targetUrl, { method = "GET", headers = {}, body } = {}) {
  const urlObj = new URL(targetUrl);
  const client = urlObj.protocol === "https:" ? https : http;
  const payload = body ? JSON.stringify(body) : null;
  const reqHeaders = {
    ...headers,
  };
  if (payload && !reqHeaders["content-type"]) {
    reqHeaders["content-type"] = "application/json";
  }
  if (payload && !reqHeaders["content-length"]) {
    reqHeaders["content-length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolvePromise, reject) => {
    const req = client.request(
      urlObj,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          const status = Number(res.statusCode || 0);
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { raw };
          }
          if (status < 200 || status >= 300) {
            reject(new Error(`HTTP ${status} ${res.statusMessage || ""} ${raw}`.trim()));
            return;
          }
          resolvePromise(parsed);
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServiceCheck(label, checkFn, attempts = 20, delayMs = 500) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const result = await checkFn();
      return { ok: true, label, result };
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return {
    ok: false,
    label,
    error: String(lastError?.message || lastError || "unknown error"),
  };
}

async function runStartupDiagnostics() {
  const gatewayBase = `http://127.0.0.1:${publicPort}`;
  const checks = [];

  checks.push(
    await waitForServiceCheck("backend-health", async () => {
      const json = await requestJson(`${gatewayBase}/api/health`);
      const liquid = Boolean(json?.services?.liquidationBot);
      return {
        url: `${gatewayBase}/api/health`,
        ok: Boolean(json?.ok),
        liquidationBot: liquid,
      };
    })
  );

  if (localMode) {
    checks.push(
      await waitForServiceCheck("relay-runner", async () => {
        const json = await requestJson(`${gatewayBase}/api/admin/runner`, {
          headers: { authorization: basicAuthHeader(startupAdminUser, startupAdminPass) },
        });
        return {
          url: `${gatewayBase}/api/admin/runner`,
          ready: Boolean(json?.ready),
          enabled: Boolean(json?.enabled),
          runnerAddress: json?.runnerAddress || "",
        };
      })
    );
  }

  if (rpcBase) {
    checks.push(
      await waitForServiceCheck("rpc-upstream", async () => {
        const json = await requestJson(`${gatewayBase}/rpc`, {
          method: "POST",
          body: { jsonrpc: "2.0", method: "web3_clientVersion", params: [], id: 1 },
        });
        return {
          url: `${gatewayBase}/rpc`,
          upstream: rpcBase.toString(),
          clientVersion: json?.result || "",
        };
      })
    );
  }

  console.log("[start-stack] startup checks:");
  for (const check of checks) {
    if (!check.ok) {
      console.log(`  - ${check.label}: FAIL (${check.error})`);
      continue;
    }
    console.log(`  - ${check.label}: OK ${JSON.stringify(check.result)}`);
  }
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
    if (localMode && overlayInjectionHtml && isIndex) {
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
    const type = contentTypeFor(target);
    res.writeHead(200, { "content-type": type });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Unable to serve frontend asset");
  }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", `http://127.0.0.1:${publicPort}`).pathname;
  if ((pathname === "/rpc" || pathname.startsWith("/rpc/")) && rpcBase) {
    const urlObj = new URL(req.url || "/rpc", `http://127.0.0.1:${publicPort}`);
    const rpcPath = urlObj.pathname.replace(/^\/rpc/, "") || "/";
    const rpcReqPath = `${rpcPath}${urlObj.search || ""}`;
    proxyHttpToBase(req, res, rpcBase, rpcReqPath);
    return;
  }
  if (pathname.startsWith("/api/") || pathname === "/api" || pathname === "/ws") {
    proxyHttp(req, res);
    return;
  }
  serveSpaAsset(req, res);
});

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url || "/", `http://127.0.0.1:${publicPort}`).pathname;
  if (pathname === "/ws") {
    proxyWebSocket(req, socket, head);
    return;
  }
  socket.destroy();
});

server.listen(publicPort, "0.0.0.0", () => {
  console.log(`[start-stack] frontend+gateway listening on http://0.0.0.0:${publicPort}`);
  console.log(`[start-stack] backend proxied to ${backendBase.toString()}`);
  if (rpcBase) {
    console.log(`[start-stack] rpc proxied at /rpc -> ${rpcBase.toString()}`);
  }
  if (localMode) {
    console.log(`[start-stack] local relay enabled on http://127.0.0.1:${relayPort}`);
  }
  runStartupDiagnostics().catch((error) => {
    console.log(`[start-stack] startup checks failed: ${String(error?.message || error)}`);
  });
});
