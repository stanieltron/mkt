const LOCAL_FAUCET_API_BASE = __LOCAL_FAUCET_API_BASE__;

function formatUnitsString(rawValue, decimals) {
  try {
    const value = BigInt(rawValue || "0");
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const fraction = value % base;
    if (fraction === 0n) return whole.toString();
    return `${whole}.${fraction.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
  } catch {
    return "0";
  }
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

async function apiJson(path, init) {
  const response = await fetch(`${LOCAL_FAUCET_API_BASE}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function installFaucetOverlay() {
  const state = {
    busy: false,
    info: null,
    wallet: "",
    message: "",
    tone: "muted",
  };

  const style = document.createElement("style");
  style.textContent = `
    .local-faucet-shell {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483647;
      width: min(320px, calc(100vw - 24px));
      border: 1px solid rgba(97, 146, 136, 0.35);
      border-radius: 14px;
      background: rgba(9, 20, 20, 0.94);
      box-shadow: 0 18px 40px rgba(0, 0, 0, 0.28);
      color: #ecf5f2;
      font-family: "Space Grotesk", sans-serif;
      backdrop-filter: blur(10px);
    }
    .local-faucet-shell[hidden] { display: none; }
    .local-faucet-body { padding: 0.8rem 0.9rem; display: grid; gap: 0.55rem; }
    .local-faucet-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; }
    .local-faucet-title { margin: 0; font-size: 0.95rem; }
    .local-faucet-copy { margin: 0; color: #94b6ae; font-size: 0.76rem; line-height: 1.4; }
    .local-faucet-wallet { font-family: "IBM Plex Mono", monospace; font-size: 0.74rem; color: #94b6ae; }
    .local-faucet-button {
      border: 1px solid rgba(26, 184, 146, 0.9);
      border-radius: 10px;
      background: linear-gradient(135deg, #1ab892 0%, #15d4b0 100%);
      color: #04110f;
      cursor: pointer;
      font-weight: 700;
      padding: 0.62rem 0.8rem;
    }
    .local-faucet-button[disabled] { opacity: 0.55; cursor: not-allowed; }
    .local-faucet-status { margin: 0; font-size: 0.78rem; }
    .local-faucet-status[data-tone="success"] { color: #18d6b0; }
    .local-faucet-status[data-tone="error"] { color: #ff5f59; }
    .local-faucet-status[data-tone="muted"] { color: #94b6ae; }
  `;
  document.head.appendChild(style);

  const shell = document.createElement("aside");
  shell.className = "local-faucet-shell";
  shell.hidden = true;
  shell.innerHTML = `
    <div class="local-faucet-body">
      <div class="local-faucet-head">
        <h2 class="local-faucet-title">Local Faucet</h2>
        <span class="local-faucet-wallet"></span>
      </div>
      <p class="local-faucet-copy"></p>
      <button class="local-faucet-button" type="button">Connect Wallet</button>
      <p class="local-faucet-status" data-tone="muted"></p>
    </div>
  `;
  document.body.appendChild(shell);

  const walletEl = shell.querySelector(".local-faucet-wallet");
  const copyEl = shell.querySelector(".local-faucet-copy");
  const buttonEl = shell.querySelector(".local-faucet-button");
  const statusEl = shell.querySelector(".local-faucet-status");

  function render() {
    const info = state.info;
    shell.hidden = !info?.enabled;
    if (!info?.enabled) return;

    const ethLabel = Number(info.ethWei || "0") > 0 ? `${formatUnitsString(info.ethWei, 18)} ETH` : "";
    const usdcLabel = Number(info.usdc6 || "0") > 0 ? `${formatUnitsString(info.usdc6, 6)} USDC` : "";
    const payoutLabel = [ethLabel, usdcLabel].filter(Boolean).join(" + ");
    copyEl.textContent = payoutLabel
      ? `${payoutLabel} per wallet. Cooldown: ${formatDuration(info.cooldownMs)}.`
      : `Cooldown: ${formatDuration(info.cooldownMs)}.`;
    walletEl.textContent = state.wallet ? `${state.wallet.slice(0, 6)}...${state.wallet.slice(-4)}` : "not connected";
    buttonEl.disabled = state.busy;
    buttonEl.textContent = state.busy ? "Sending..." : state.wallet ? "Request Faucet" : "Connect Wallet";
    statusEl.dataset.tone = state.tone;
    statusEl.textContent = state.message;
  }

  async function refreshWallet(requireConnect) {
    if (!window.ethereum) {
      state.wallet = "";
      state.message = "Wallet extension not detected.";
      state.tone = "error";
      render();
      return "";
    }

    const method = requireConnect ? "eth_requestAccounts" : "eth_accounts";
    const accounts = await window.ethereum.request({ method });
    state.wallet = accounts?.[0] || "";
    return state.wallet;
  }

  async function refreshInfo() {
    try {
      state.info = await apiJson("/api/faucet/info");
      state.message = state.wallet ? "" : "Connect a wallet, then request local test funds.";
      state.tone = "muted";
      await refreshWallet(false).catch(() => "");
    } catch (error) {
      state.info = { enabled: false };
      state.message = String(error?.message || error || "Local faucet unavailable");
      state.tone = "error";
    }
    render();
  }

  buttonEl.addEventListener("click", async () => {
    try {
      state.busy = true;
      state.message = "";
      state.tone = "muted";
      render();

      const wallet = state.wallet || (await refreshWallet(true));
      if (!wallet) {
        state.message = "Connect a wallet first.";
        state.tone = "error";
        return;
      }

      const result = await apiJson("/api/faucet/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet }),
      });

      const ethLabel = Number(result.ethWei || "0") > 0 ? `${formatUnitsString(result.ethWei, 18)} ETH` : "";
      const usdcLabel = Number(result.usdc6 || "0") > 0 ? `${formatUnitsString(result.usdc6, 6)} USDC` : "";
      const payoutLabel = [ethLabel, usdcLabel].filter(Boolean).join(" + ");
      state.message = payoutLabel ? `Sent ${payoutLabel}.` : "Faucet request sent.";
      state.tone = "success";
    } catch (error) {
      const retryAfterMs = Number(error?.payload?.retryAfterMs || 0);
      if (error?.status === 429 && retryAfterMs > 0) {
        state.message = `Cooldown active. Try again in ${formatDuration(retryAfterMs)}.`;
      } else {
        state.message = String(error?.message || error || "Faucet request failed");
      }
      state.tone = "error";
    } finally {
      state.busy = false;
      render();
    }
  });

  if (window.ethereum?.on) {
    window.ethereum.on("accountsChanged", (accounts) => {
      state.wallet = accounts?.[0] || "";
      if (!state.wallet && state.tone !== "error") {
        state.message = "Connect a wallet, then request local test funds.";
        state.tone = "muted";
      }
      render();
    });
  }

  refreshInfo().catch(() => {});
  window.setInterval(() => {
    refreshInfo().catch(() => {});
  }, 60000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", installFaucetOverlay, { once: true });
} else {
  installFaucetOverlay();
}
