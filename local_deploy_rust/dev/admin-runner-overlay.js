const LOCAL_ADMIN_API_BASE = __LOCAL_ADMIN_API_BASE__;

let configDefaults = {
  username: "",
  password: "",
};
let configLoaded = false;
let configLoadPromise = null;

function normalizeBaseUrl(base) {
  return String(base || "").replace(/\/$/, "");
}

async function loadAdminDefaultsFromConfig() {
  if (configLoaded) return configDefaults;
  if (configLoadPromise) return configLoadPromise;

  const base = normalizeBaseUrl(LOCAL_ADMIN_API_BASE);
  configLoadPromise = (async () => {
    try {
      const response = await fetch(`${base}/api/config`, { method: "GET" });
      if (!response.ok) {
        configLoaded = true;
        return configDefaults;
      }
      const payload = await response.json().catch(() => ({}));
      const username = String(payload?.adminDefaultUser || "");
      const password = String(payload?.adminDefaultPassword || "");
      configDefaults = { username, password };
    } catch {
      // swallow; overlay will continue with existing localStorage values
    } finally {
      configLoaded = true;
    }
    return configDefaults;
  })();

  return configLoadPromise;
}

function adminAuthHeaders() {
  const username = configDefaults.username || "admin";
  const password = configDefaults.password || "admin123";
  return { Authorization: `Basic ${btoa(`${username}:${password}`)}` };
}

function formatUsdc6(raw) {
  try {
    const value = BigInt(raw || "0");
    const whole = value / 1000000n;
    const fraction = value % 1000000n;
    if (fraction === 0n) return whole.toString();
    return `${whole}.${fraction.toString().padStart(6, "0").replace(/0+$/, "")}`;
  } catch {
    return "0";
  }
}

async function apiJson(path, init = {}) {
  const response = await fetch(`${LOCAL_ADMIN_API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...adminAuthHeaders(),
      ...(init.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function installAdminRunnerOverlay() {
  if (!window.location.pathname.startsWith("/admin")) return;
  if (document.querySelector(".local-runner-shell")) return;

  const style = document.createElement("style");
  style.textContent = `
    .local-runner-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(2px);
      z-index: 9998;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .local-runner-backdrop[hidden] {
      display: none;
    }
    .local-runner-shell {
      width: 100%;
      max-width: 360px;
      border: 1px solid rgba(202, 152, 66, 0.35);
      border-radius: 14px;
      background: rgba(24, 22, 17, 0.96);
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.16);
      color: #f6efe1;
      font-family: "Space Grotesk", sans-serif;
    }
    .local-runner-body { padding: 1.2rem; display: grid; gap: 0.8rem; }
    .local-runner-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
    .local-runner-title { margin: 0; font-size: 1.1rem; }
    .local-runner-close { background: none; border: none; color: #c9baa0; cursor: pointer; font-size: 1.2rem; margin: -0.5rem -0.5rem 0 0; padding: 0.5rem; }
    .local-runner-copy, .local-runner-status { margin: 0; font-size: 0.8rem; color: #c9baa0; word-break: break-all; }
    .local-runner-grid { display: grid; gap: 0.8rem; }
    .local-runner-grid label { display: grid; gap: 0.35rem; font-size: 0.82rem; }
    .local-runner-grid input { width: 100%; }
    .local-runner-actions { display: flex; gap: 0.6rem; margin-top: 0.4rem; }
    .local-runner-btn {
      flex: 1;
      border: 1px solid rgba(231, 171, 58, 0.8);
      border-radius: 10px;
      background: linear-gradient(135deg, #e7ab3a 0%, #f0c56f 100%);
      color: #1f1606;
      cursor: pointer;
      font-weight: 700;
      padding: 0.65rem 0.75rem;
    }
    .local-runner-btn[disabled] { opacity: 0.55; cursor: not-allowed; }
    .local-runner-toggle {
      border: 1px solid rgba(231, 171, 58, 0.6);
      background: rgba(43, 31, 13, 0.9);
      color: #f0c56f;
      border-radius: 10px;
      padding: 0.52rem 0.72rem;
      font-weight: 600;
      cursor: pointer;
      font-size: 0.82rem;
    }
    .local-runner-toggle[hidden] {
      display: none;
    }
  `;
  document.head.appendChild(style);

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "local-runner-toggle";
  toggleBtn.textContent = "⚙ Runner Controls";
  toggleBtn.hidden = true;

  const backdrop = document.createElement("div");
  backdrop.className = "local-runner-backdrop";
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <aside class="local-runner-shell">
      <div class="local-runner-body">
        <div class="local-runner-head">
          <h2 class="local-runner-title">Local Runner</h2>
          <button class="local-runner-close" type="button" aria-label="Close">&times;</button>
        </div>
        <p class="local-runner-copy"></p>
        <div class="local-runner-grid">
          <label>Trend <input type="range" min="-1" max="1" step="0.01" data-field="trend"></label>
          <label>Volatility <input type="range" min="0" max="1" step="0.01" data-field="volatility"></label>
        </div>
        <div class="local-runner-actions">
          <button class="local-runner-btn" data-action="start" type="button">Start</button>
          <button class="local-runner-btn" data-action="stop" type="button">Stop</button>
        </div>
        <p class="local-runner-status"></p>
      </div>
    </aside>
  `;

  function mountUI() {
    const topbarActions = document.querySelector(".topbar-actions");
    if (topbarActions && !toggleBtn.isConnected) {
      topbarActions.insertAdjacentElement("afterbegin", toggleBtn);
    }
    if (!backdrop.isConnected) {
      document.body.appendChild(backdrop);
    }
    return topbarActions != null;
  }

  if (!mountUI()) {
    const observer = new MutationObserver(() => {
      if (mountUI()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(() => observer.disconnect(), 15000);
  }

  const copyEl = backdrop.querySelector(".local-runner-copy");
  const statusEl = backdrop.querySelector(".local-runner-status");
  const trendEl = backdrop.querySelector('[data-field="trend"]');
  const volatilityEl = backdrop.querySelector('[data-field="volatility"]');
  const startBtn = backdrop.querySelector('[data-action="start"]');
  const stopBtn = backdrop.querySelector('[data-action="stop"]');
  const closeBtn = backdrop.querySelector(".local-runner-close");

  toggleBtn.addEventListener("click", () => {
    backdrop.hidden = false;
  });

  closeBtn.addEventListener("click", () => {
    backdrop.hidden = true;
  });

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.hidden = true;
  });

  let state = null;
  let busy = false;

  function render() {
    toggleBtn.hidden = !state;
    if (!state) {
      backdrop.hidden = true;
      return;
    }
    copyEl.textContent = `ready=${state.ready ? "yes" : "no"} | runner=${state.runnerAddress || "-"} | base=${formatUsdc6(state.baseNotionalUsdc6)} USDC`;
    trendEl.value = String(state.trend ?? 0);
    volatilityEl.value = String(state.volatility ?? 0.2);
    startBtn.disabled = busy || Boolean(state.enabled);
    stopBtn.disabled = busy || !state.enabled;
    statusEl.textContent = state.enabled ? "Runner active" : "Runner stopped";
  }

  async function refresh() {
    try {
      state = await apiJson("/api/admin/runner", { method: "GET", headers: adminAuthHeaders() });
    } catch (error) {
      if (error?.status === 401) {
        // credentials may not be initialized yet; retry once after loading /api/config defaults
        await loadAdminDefaultsFromConfig().catch(() => {});
        try {
          state = await apiJson("/api/admin/runner", { method: "GET", headers: adminAuthHeaders() });
        } catch {
          state = null;
        }
      } else {
        statusEl.textContent = String(error?.message || error || "Runner unavailable");
      }
    }
    render();
  }

  async function patchRunner(patch) {
    busy = true;
    render();
    try {
      state = await apiJson("/api/admin/runner", { method: "POST", body: JSON.stringify(patch) });
    } finally {
      busy = false;
      render();
    }
  }

  trendEl.addEventListener("change", () => patchRunner({ trend: Number(trendEl.value) }).catch(() => {}));
  volatilityEl.addEventListener("change", () => patchRunner({ volatility: Number(volatilityEl.value) }).catch(() => {}));
  startBtn.addEventListener("click", () => patchRunner({ enabled: true }).catch(() => {}));
  stopBtn.addEventListener("click", () => patchRunner({ enabled: false }).catch(() => {}));

  loadAdminDefaultsFromConfig()
    .catch(() => {})
    .finally(() => {
      refresh().catch(() => {});
    });
  window.setInterval(() => {
    refresh().catch(() => {});
  }, 3000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installAdminRunnerOverlay, { once: true });
} else {
  installAdminRunnerOverlay();
}
