#!/usr/bin/env node
"use strict";

const http = require("node:http");
const https = require("node:https");
const { spawn } = require("node:child_process");
const { createReadStream, existsSync } = require("node:fs");
const { extname, join, normalize, resolve } = require("node:path");
const { URL } = require("node:url");

const root = process.cwd();
const distDir = resolve(root, "frontend", "dist");
const publicPort = Number(process.env.PORT || process.env.FRONTEND_PORT || 3000);
const backendPort = Number(process.env.BACKEND_INTERNAL_PORT || process.env.BACKEND_PORT || 8788);
const backendBase = new URL(process.env.BACKEND_INTERNAL_URL || `http://127.0.0.1:${backendPort}`);
const backendBin = resolve(
  root,
  "backend",
  "target",
  "release",
  process.platform === "win32" ? "makeit-backend.exe" : "makeit-backend"
);

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

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    backend.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      backend.kill("SIGKILL");
    } catch {}
    process.exit(code);
  }, 1200);
}

backend.on("exit", (code) => {
  if (shuttingDown) return;
  console.error(`[start-stack] backend exited with code ${code ?? 0}`);
  shutdown(code ?? 1);
});

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
  const upstreamUrl = new URL(req.url || "/", backendBase);
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
    res.end(JSON.stringify({ error: `Backend proxy failed: ${String(error?.message || error)}` }));
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
});
