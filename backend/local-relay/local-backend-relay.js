"use strict";

const http = require("node:http");
const https = require("node:https");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { URL } = require("node:url");
const { Contract, JsonRpcProvider, Wallet, NonceManager } = require("ethers");
const { SwapRunnerService } = require("./services/swap-runner-service.js");

const publicPort = Number(process.env.BACKEND_PORT || 8787);
const upstreamPort = Number(process.env.LOCAL_BACKEND_UPSTREAM_PORT || 8788);
const upstreamBase = new URL(process.env.LOCAL_BACKEND_UPSTREAM_URL || `http://127.0.0.1:${upstreamPort}`);
const rpcUrl = process.env.BACKEND_RPC_URL || process.env.RPC_URL || "http://127.0.0.1:8545";
const faucetAddress = process.env.FAUCET_ADDRESS || "";
const faucetPrivateKey = process.env.FAUCET_PRIVATE_KEY || "";
const runnerPrivateKey = process.env.RUNNER_PRIVATE_KEY || "";
const swapperPrivateKey = process.env.SWAPPER_PRIVATE_KEY || "";
const adminUsername = process.env.ADMIN_USERNAME || "admin";
const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
const swapAdapterAddress = process.env.SWAP_ADAPTER_ADDRESS || "";
const oracleAddress = process.env.ORACLE_ADDRESS || "";
const swapperAddressFromKey = swapperPrivateKey ? new Wallet(swapperPrivateKey).address : "";
const swapperAddress = process.env.SWAPPER_ADDRESS || swapperAddressFromKey || "";
const runnerAddress = process.env.RUNNER_ADDRESS || "";
const artifactPath =
  process.env.LOCAL_FAUCET_ARTIFACT_PATH ||
  resolve(process.cwd(), "local-relay", "artifacts", "LocalFaucet.json");
const fallbackFaucetAbi = [
  "function claimTo(address recipient)",
  "error CooldownActive(uint256 retryAfterMs)",
  "error InvalidRecipient()",
  "error TokenTransferFailed()",
  "error EthTransferFailed()",
];
let artifact = { abi: fallbackFaucetAbi };
try {
  artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
} catch {
  console.warn(`[local-backend-relay] faucet artifact missing at ${artifactPath}, using fallback ABI`);
}

const faucetInfo = {
  enabled: Boolean(faucetAddress && faucetPrivateKey),
  address: faucetAddress,
  ethWei: process.env.FAUCET_ETH_WEI || "0",
  usdc6: process.env.FAUCET_USDC_6 || "0",
  cooldownMs: Number(process.env.FAUCET_COOLDOWN_MS || 3600000),
};

const provider = new JsonRpcProvider(rpcUrl);
const signer = faucetInfo.enabled ? new NonceManager(new Wallet(faucetPrivateKey, provider)) : null;
const faucet = faucetInfo.enabled ? new Contract(faucetAddress, artifact.abi, signer) : null;
const runnerSigner = runnerPrivateKey ? new NonceManager(new Wallet(runnerPrivateKey, provider)) : null;
const swapRunner = new SwapRunnerService({
  provider,
  signer: runnerSigner,
  configuredRunnerAddress: runnerAddress,
  swapAdapterAddress,
  oracleAddress,
  swapperAddress,
  initialConfig: {
    enabled: String(process.env.SWAP_RUNNER_ENABLED || "false").toLowerCase() === "true",
    intervalMs: Number(process.env.SWAP_RUNNER_INTERVAL_MS || 500),
    baseNotionalUsdc6: process.env.SWAP_RUNNER_BASE_NOTIONAL_USDC_6 || "10000000",
    trend: Number(process.env.SWAP_RUNNER_TREND || "0"),
    volatility: Number(process.env.SWAP_RUNNER_VOLATILITY || "0.2"),
    maxRuntimeMs: Number(process.env.SWAP_RUNNER_MAX_RUNTIME_MS || "300000"),
  },
});

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    ...extra,
  };
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, corsHeaders({ "content-type": "application/json; charset=utf-8" }));
  res.end(JSON.stringify(payload));
}

function emptyReferralPayload(walletAddress = "") {
  return {
    user: walletAddress ? { walletAddress } : null,
    tier1: [],
    tier2: [],
    totals: {
      tier1Volume: "0",
      tier2Volume: "0",
      combinedVolume: "0",
    },
  };
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

function parseBasicAuth(req) {
  const raw = req.headers.authorization || "";
  if (!raw.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(raw.slice(6).trim(), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) return null;
    return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

function isAdminAuthorized(req) {
  const auth = parseBasicAuth(req);
  if (auth) return auth.username === adminUsername && auth.password === adminPassword;
  return req.headers["x-admin-username"] === adminUsername && req.headers["x-admin-password"] === adminPassword;
}

function requireAdmin(req, res) {
  if (isAdminAuthorized(req)) return true;
  res.writeHead(401, corsHeaders({ "content-type": "application/json; charset=utf-8" }));
  res.end(JSON.stringify({ error: "Invalid admin credentials" }));
  return false;
}

function isAddressLike(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

function extractRevertData(input) {
  if (!input) return null;
  if (typeof input === "string" && /^0x[0-9a-fA-F]*$/.test(input)) return input;
  if (typeof input !== "object") return null;
  for (const value of Object.values(input)) {
    const nested = extractRevertData(value);
    if (nested) return nested;
  }
  return null;
}

function decodeFaucetError(error) {
  const revertData = extractRevertData(error);
  if (revertData) {
    try {
      const parsed = faucet.interface.parseError(revertData);
      if (parsed?.name === "CooldownActive") {
        const retryAfterMs = Number(parsed.args?.[0] || 0);
        return {
          status: 429,
          payload: {
            error: "Faucet cooldown active",
            retryAfterMs,
          },
        };
      }
      if (parsed?.name === "InvalidRecipient") {
        return { status: 400, payload: { error: "Invalid recipient wallet" } };
      }
      if (parsed?.name === "TokenTransferFailed" || parsed?.name === "EthTransferFailed") {
        return { status: 503, payload: { error: "Local faucet is not sufficiently funded" } };
      }
    } catch {
      // fall through to generic error
    }
  }

  return {
    status: 500,
    payload: { error: String(error?.shortMessage || error?.message || error || "Local faucet request failed") },
  };
}

async function handleFaucetClaim(req, res) {
  if (!faucetInfo.enabled || !faucet) {
    json(res, 404, { error: "Local faucet is not enabled" });
    return;
  }

  const rawBody = await readBody(req);
  let body = {};
  try {
    body = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const walletAddress = String(body.walletAddress || "");
  if (!isAddressLike(walletAddress)) {
    json(res, 400, { error: "walletAddress is required" });
    return;
  }

  try {
    let tx;
    let receipt;
    try {
      tx = await faucet.claimTo(walletAddress);
      receipt = await tx.wait();
    } catch (firstError) {
      // Retry once for transient nonce races on local dev traffic bursts.
      const text = String(firstError?.shortMessage || firstError?.message || firstError || "");
      if (
        text.toLowerCase().includes("nonce has already been used") ||
        text.toLowerCase().includes("already known")
      ) {
        tx = await faucet.claimTo(walletAddress);
        receipt = await tx.wait();
      } else {
        throw firstError;
      }
    }
    json(res, 200, {
      ok: true,
      txHash: tx.hash,
      blockNumber: receipt?.blockNumber ?? null,
      status: Number(receipt?.status ?? 1),
      ethWei: faucetInfo.ethWei,
      usdc6: faucetInfo.usdc6,
      cooldownMs: faucetInfo.cooldownMs,
    });
  } catch (error) {
    const decoded = decodeFaucetError(error);
    json(res, decoded.status, decoded.payload);
  }
}

async function handleRunnerPatch(req, res) {
  const rawBody = await readBody(req);
  let body = {};
  try {
    body = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {};
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  try {
    const state = swapRunner.updateConfig({
      enabled: body.enabled,
      trend: body.trend,
      volatility: body.volatility,
      baseNotionalUsdc6: body.baseNotionalUsdc6,
      intervalMs: body.intervalMs,
    });
    json(res, 200, state);
  } catch (error) {
    json(res, 500, { error: String(error?.message || error || "Runner update failed") });
  }
}

async function proxyRequest(req, res) {
  const body = await readBody(req);
  const upstreamUrl = new URL(req.url || "/", upstreamBase);
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
    json(res, 502, { error: `Shared backend unavailable: ${String(error?.message || error)}` });
  });

  if (body.length > 0) {
    proxyReq.write(body);
  }
  proxyReq.end();
}

function writeUpgradeResponse(socket, statusCode, statusMessage, headers = {}) {
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) lines.push(`${key}: ${entry}`);
      continue;
    }
    lines.push(`${key}: ${value}`);
  }
  lines.push("", "");
  socket.write(lines.join("\r\n"));
}

function proxyWebSocket(req, socket, head) {
  const upstreamUrl = new URL(req.url || "/", upstreamBase);
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
    if (proxyHead && proxyHead.length > 0) {
      socket.write(proxyHead);
    }
    if (head && head.length > 0) {
      proxySocket.write(head);
    }
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${publicPort}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (url.pathname === "/api/admin/runner") {
      if (!requireAdmin(req, res)) return;
      if (req.method === "GET") {
        json(res, 200, swapRunner.getState());
        return;
      }
      if (req.method === "POST") {
        await handleRunnerPatch(req, res);
        return;
      }
    }

    if (url.pathname === "/api/faucet/info" && req.method === "GET") {
      json(res, 200, faucetInfo);
      return;
    }

    if (url.pathname === "/api/faucet/claim" && req.method === "POST") {
      await handleFaucetClaim(req, res);
      return;
    }

    if (/^\/api\/users\/0x[a-fA-F0-9]{40}\/referrals$/.test(url.pathname) && req.method === "GET") {
      const walletAddress = url.pathname.split("/")[3] || "";
      json(res, 200, emptyReferralPayload(walletAddress));
      return;
    }

    await proxyRequest(req, res);
  } catch (error) {
    json(res, 500, { error: String(error?.message || error || "Relay failure") });
  }
});

server.on("upgrade", (req, socket, head) => {
  proxyWebSocket(req, socket, head);
});

server.listen(publicPort, "127.0.0.1", () => {
  console.log(
    `[local-backend-relay] listening on http://127.0.0.1:${publicPort} -> ${upstreamBase.toString()}`
  );
  if (runnerAddress) {
    console.log(`[local-backend-relay] RUNNER_ADDRESS=${runnerAddress}`);
  }
  if (swapperAddress) {
    console.log(`[local-backend-relay] SWAPPER_ADDRESS=${swapperAddress}`);
  }
  if (faucetAddress) {
    console.log(`[local-backend-relay] FAUCET_ADDRESS=${faucetAddress}`);
  }
});

swapRunner.init().catch((error) => {
  console.error(`[local-backend-relay] runner init failed: ${String(error?.message || error)}`);
});
