import { ACTIVE_NETWORK } from "../config/contracts";

class ApiError extends Error {
  constructor(message, { status, path, body } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status ?? 0;
    this.path = path || "";
    this.body = body;
  }
}

const BACKEND_RETRY_COOLDOWN_MS = 20_000;
const backendState = {
  lastWorkingBaseUrl: "",
  lastFailureAt: 0,
  lastErrorMessage: "",
};

function toBasicAuth(username, password) {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function getBackendCandidates() {
  const primary = ACTIVE_NETWORK.backendUrl;
  const candidates = [primary];

  try {
    const parsed = new URL(primary);
    if (parsed.hostname === "127.0.0.1") {
      const alt = new URL(primary);
      alt.hostname = "localhost";
      candidates.push(alt.toString().replace(/\/$/, ""));
      const v6 = new URL(primary);
      v6.hostname = "[::1]";
      candidates.push(v6.toString().replace(/\/$/, ""));
    } else if (parsed.hostname === "localhost") {
      const alt = new URL(primary);
      alt.hostname = "127.0.0.1";
      candidates.push(alt.toString().replace(/\/$/, ""));
      const v6 = new URL(primary);
      v6.hostname = "[::1]";
      candidates.push(v6.toString().replace(/\/$/, ""));
    } else if (parsed.hostname === "[::1]") {
      const alt = new URL(primary);
      alt.hostname = "localhost";
      candidates.push(alt.toString().replace(/\/$/, ""));
      const v4 = new URL(primary);
      v4.hostname = "127.0.0.1";
      candidates.push(v4.toString().replace(/\/$/, ""));
    }
  } catch {
  }

  return [...new Set(candidates)];
}

function getPreferredBackendCandidates() {
  const all = getBackendCandidates();
  if (backendState.lastWorkingBaseUrl && all.includes(backendState.lastWorkingBaseUrl)) {
    return [backendState.lastWorkingBaseUrl];
  }
  return all;
}

function markBackendSuccess(baseUrl) {
  backendState.lastWorkingBaseUrl = baseUrl;
  backendState.lastFailureAt = 0;
  backendState.lastErrorMessage = "";
}

function markBackendFailure(error) {
  backendState.lastFailureAt = Date.now();
  backendState.lastErrorMessage = String(error?.message || error || "Backend unavailable");
}

function backendCooldownActive() {
  return backendState.lastFailureAt > 0 && Date.now() - backendState.lastFailureAt < BACKEND_RETRY_COOLDOWN_MS;
}

function makeBackendUnavailableError(path) {
  const retryInMs = Math.max(0, BACKEND_RETRY_COOLDOWN_MS - (Date.now() - backendState.lastFailureAt));
  return new ApiError(
    `Backend unreachable at ${ACTIVE_NETWORK.backendUrl}${backendState.lastErrorMessage ? ` (${backendState.lastErrorMessage})` : ""}. Retrying in ${Math.ceil(retryInMs / 1000)}s.`,
    { path }
  );
}

export async function apiGet(path, options = {}) {
  if (backendCooldownActive()) {
    throw makeBackendUnavailableError(path);
  }

  let response = null;
  let lastNetworkError = null;
  let successfulBaseUrl = "";
  for (const baseUrl of getPreferredBackendCandidates()) {
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: "GET",
        headers: {
          ...(options.auth
            ? {
                Authorization: toBasicAuth(options.auth.username, options.auth.password),
              }
            : {}),
        },
      });
      successfulBaseUrl = baseUrl;
      break;
    } catch (error) {
      lastNetworkError = error;
    }
  }

  if (!response) {
    markBackendFailure(lastNetworkError);
    throw new ApiError(
      `Backend unreachable at ${ACTIVE_NETWORK.backendUrl}${lastNetworkError ? ` (${String(lastNetworkError?.message || lastNetworkError)})` : ""}`,
      { path }
    );
  }

  markBackendSuccess(successfulBaseUrl);

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error || `Request failed: ${response.status}`, {
      status: response.status,
      path,
      body,
    });
  }
  return response.json();
}

export async function apiPost(path, body, options = {}) {
  if (backendCooldownActive()) {
    throw makeBackendUnavailableError(path);
  }

  let response = null;
  let lastNetworkError = null;
  let successfulBaseUrl = "";
  for (const baseUrl of getPreferredBackendCandidates()) {
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options.auth
            ? {
                Authorization: toBasicAuth(options.auth.username, options.auth.password),
              }
            : {}),
        },
        body: JSON.stringify(body || {}),
      });
      successfulBaseUrl = baseUrl;
      break;
    } catch (error) {
      lastNetworkError = error;
    }
  }

  if (!response) {
    markBackendFailure(lastNetworkError);
    throw new ApiError(
      `Backend unreachable at ${ACTIVE_NETWORK.backendUrl}${lastNetworkError ? ` (${String(lastNetworkError?.message || lastNetworkError)})` : ""}`,
      { path }
    );
  }

  markBackendSuccess(successfulBaseUrl);

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(payload.error || `Request failed: ${response.status}`, {
      status: response.status,
      path,
      body: payload,
    });
  }
  return response.json();
}
