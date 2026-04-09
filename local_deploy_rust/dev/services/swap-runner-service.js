const { Contract, formatUnits } = require("ethers");
const { ERC20_ABI, SWAP_ADAPTER_ABI, ORACLE_ABI } = require("../lib/abis");
const { clamp, nowIso } = require("../lib/utils");

class SwapRunnerService {
  constructor({
    provider,
    signer,
    swapAdapterAddress,
    oracleAddress,
    initialConfig,
  }) {
    this.provider = provider;
    this.signer = signer;
    this.swapAdapterAddress = swapAdapterAddress;
    this.oracleAddress = oracleAddress;
    this.timer = null;
    this.inFlight = false;
    this.logs = [];
    this.ready = false;

    this.config = {
      enabled: Boolean(initialConfig?.enabled),
      trend: clamp(Number(initialConfig?.trend ?? 0), -1, 1),
      volatility: clamp(Number(initialConfig?.volatility ?? 0.2), 0, 1),
      baseNotionalUsdc6: BigInt(initialConfig?.baseNotionalUsdc6 ?? "10000000"),
      intervalMs: Math.max(250, Number(initialConfig?.intervalMs ?? 1000)),
    };
  }

  pushLog(entry) {
    const payload = {
      at: nowIso(),
      ...entry,
    };
    this.logs.unshift(payload);
    if (this.logs.length > 200) this.logs.length = 200;

    const level = payload.level || "info";
    const line = [
      `[runner]`,
      payload.at,
      payload.direction ? `[${payload.direction}]` : "",
      payload.txStage ? `[${payload.txStage}]` : "",
      payload.txHash ? `tx=${payload.txHash}` : "",
      payload.txStatus !== undefined && payload.txStatus !== null ? `status=${payload.txStatus}` : "",
      payload.message || payload.result || "",
    ]
      .filter(Boolean)
      .join(" ");
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  async init() {
    if (!this.signer) {
      this.pushLog({ level: "warn", result: "runner-disabled-no-signer" });
      return;
    }

    this.runnerAddress = await this.signer.getAddress();
    this.swapAdapter = new Contract(this.swapAdapterAddress, SWAP_ADAPTER_ABI, this.signer);
    this.oracle = this.oracleAddress ? new Contract(this.oracleAddress, ORACLE_ABI, this.provider) : null;
    this.usdcAddress = await this.swapAdapter.USDC();
    this.wethAddress = await this.swapAdapter.WETH();

    this.usdc = new Contract(this.usdcAddress, ERC20_ABI, this.signer);
    this.weth = new Contract(this.wethAddress, ERC20_ABI, this.signer);

    await this.ensureApprovals();
    this.ready = true;
    this.pushLog({
      level: "info",
      result: "runner-ready",
      runnerAddress: this.runnerAddress,
      config: this.getState(),
    });

    if (this.config.enabled) this.start();
  }

  async ensureApprovals() {
    const max = 2n ** 256n - 1n;

    const usdcAllowance = await this.usdc.allowance(this.runnerAddress, this.swapAdapterAddress);
    if (usdcAllowance < max / 2n) {
      const tx = await this.usdc.approve(this.swapAdapterAddress, max);
      await tx.wait();
    }

    const wethAllowance = await this.weth.allowance(this.runnerAddress, this.swapAdapterAddress);
    if (wethAllowance < max / 2n) {
      const tx = await this.weth.approve(this.swapAdapterAddress, max);
      await tx.wait();
    }
  }

  computeNextAmount() {
    const noise = (Math.random() * 2 - 1) * this.config.volatility;
    const scale = 1 + noise * 0.6;
    const value = Number(this.config.baseNotionalUsdc6) * scale;
    const bounded = Math.max(10_000, Math.round(value));
    return BigInt(bounded);
  }

  trendStrengthMultiplier(direction) {
    const trend = this.config.trend;
    if (!trend) return 1;

    const aligned =
      (trend > 0 && direction === "UP") ||
      (trend < 0 && direction === "DOWN");
    if (!aligned) return 1;

    return 1 + Math.abs(trend) * 99;
  }

  shouldMoveUp() {
    const bias = 0.5 + this.config.trend * 0.45;
    const chance = clamp(bias, 0.05, 0.95);
    return Math.random() < chance;
  }

  async tick() {
    if (!this.ready || !this.config.enabled || this.inFlight) return;
    this.inFlight = true;

    const preferredUp = this.shouldMoveUp();
    let executeUp = preferredUp;
    let direction = executeUp ? "UP" : "DOWN";
    let amountUsdc6 = this.computeNextAmount();
    amountUsdc6 = BigInt(
      Math.max(
        10_000,
        Math.round(Number(amountUsdc6) * this.trendStrengthMultiplier(direction))
      )
    );

    try {
      const priceBeforeE18 = this.oracle ? await this.oracle.getPriceE18() : null;
      const priceBefore = priceBeforeE18 ? Number(formatUnits(priceBeforeE18, 18)) : null;
      let estimatedWeth18 = 0n;
      const usdcNotional = Number(formatUnits(amountUsdc6, 6));

      let tx;
      if (!executeUp) {
        try {
          const quote = await this.swapAdapter.sellWETHForExactUSDC.staticCall(
            amountUsdc6,
            this.runnerAddress,
            this.runnerAddress
          );
          estimatedWeth18 = BigInt(quote[0]);
        } catch (quoteError) {
          this.pushLog({
            level: "warn",
            direction: "DOWN",
            notionalUsdc6: amountUsdc6.toString(),
            result: "sell-quote-failed-fallback-to-buy",
            detail: quoteError?.shortMessage || quoteError?.message || String(quoteError),
          });
          executeUp = true;
          direction = "UP";
        }
      }

      this.pushLog({
        level: "info",
        direction,
        txStage: "started",
        notionalUsdc6: amountUsdc6.toString(),
        notionalUsdc: usdcNotional.toFixed(2),
        result: executeUp ? "runner-tx-start-buy" : "runner-tx-start-sell",
      });

      if (executeUp) {
        try {
          const quote = await this.swapAdapter.buyWETHWithExactUSDC.staticCall(
            amountUsdc6,
            this.runnerAddress,
            this.runnerAddress
          );
          estimatedWeth18 = BigInt(quote[1]);
        } catch {
          estimatedWeth18 = 0n;
        }
        tx = await this.swapAdapter.buyWETHWithExactUSDC(amountUsdc6, this.runnerAddress, this.runnerAddress);
      } else {
        tx = await this.swapAdapter.sellWETHForExactUSDC(amountUsdc6, this.runnerAddress, this.runnerAddress);
      }

      this.pushLog({
        level: "info",
        direction,
        txStage: "submitted",
        txHash: tx.hash,
        notionalUsdc6: amountUsdc6.toString(),
        notionalUsdc: usdcNotional.toFixed(2),
        result: "runner-tx-submitted",
      });

      const receipt = await tx.wait();
      const priceAfterE18 = this.oracle ? await this.oracle.getPriceE18() : null;
      const priceAfter = priceAfterE18 ? Number(formatUnits(priceAfterE18, 18)) : null;
      const priceMovePct =
        priceBefore && priceAfter && Number.isFinite(priceBefore) && priceBefore > 0
          ? ((priceAfter - priceBefore) / priceBefore) * 100
          : null;
      const estimatedEth = Number(formatUnits(estimatedWeth18, 18));
      const moveText =
        priceMovePct === null
          ? "n/a"
          : `${priceMovePct >= 0 ? "+" : ""}${priceMovePct.toFixed(4)}%`;
      const message = executeUp
        ? `Buying ${usdcNotional.toFixed(2)} USDC of WETH, moved price ${moveText}`
        : `Selling ${estimatedEth.toFixed(6)} ETH for ${usdcNotional.toFixed(2)} USDC, moved price ${moveText}`;

      this.pushLog({
        level: Number(receipt.status) === 1 ? "info" : "error",
        direction,
        txStage: "confirmed",
        txHash: receipt.hash,
        txStatus: Number(receipt.status),
        blockNumber: Number(receipt.blockNumber),
        result: Number(receipt.status) === 1 ? "runner-tx-confirmed" : "runner-tx-reverted",
      });

      this.pushLog({
        level: "info",
        direction,
        notionalUsdc6: amountUsdc6.toString(),
        notionalUsdc: usdcNotional.toFixed(2),
        estimatedWeth18: estimatedWeth18.toString(),
        estimatedEth: estimatedEth.toFixed(6),
        priceBefore: priceBefore !== null ? priceBefore.toFixed(6) : null,
        priceAfter: priceAfter !== null ? priceAfter.toFixed(6) : null,
        priceMovePct: priceMovePct !== null ? priceMovePct.toFixed(6) : null,
        message,
        txHash: receipt.hash,
        txStatus: Number(receipt.status),
        result: "ok",
      });
    } catch (error) {
      this.pushLog({
        level: "error",
        direction,
        txStage: "failed",
        notionalUsdc6: amountUsdc6.toString(),
        notionalUsdc: Number(formatUnits(amountUsdc6, 6)).toFixed(2),
        result: error?.shortMessage || error?.message || String(error),
      });
    } finally {
      this.inFlight = false;
    }
  }

  start() {
    if (!this.ready) return;
    if (this.timer) clearInterval(this.timer);
    this.config.enabled = true;
    this.pushLog({
      level: "info",
      result: "runner-started",
      intervalMs: this.config.intervalMs,
    });

    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.config.intervalMs);

    this.tick().catch(() => {});
  }

  stop() {
    const wasEnabled = this.config.enabled;
    this.config.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (wasEnabled) {
      this.pushLog({
        level: "warn",
        result: "runner-stopped",
      });
    }
  }

  updateConfig(next) {
    const wasEnabled = this.config.enabled;
    const previousIntervalMs = this.config.intervalMs;

    if (next.enabled !== undefined) {
      this.config.enabled = Boolean(next.enabled);
    }
    if (next.trend !== undefined) {
      this.config.trend = clamp(Number(next.trend), -1, 1);
    }
    if (next.volatility !== undefined) {
      this.config.volatility = clamp(Number(next.volatility), 0, 1);
    }
    if (next.baseNotionalUsdc6 !== undefined) {
      const value = BigInt(next.baseNotionalUsdc6);
      this.config.baseNotionalUsdc6 = value > 0n ? value : 1n;
    }
    if (next.intervalMs !== undefined) {
      this.config.intervalMs = Math.max(250, Number(next.intervalMs));
    }

    if (this.config.enabled && !wasEnabled) {
      this.start();
    } else if (!this.config.enabled && wasEnabled) {
      this.stop();
    } else if (this.config.enabled && this.config.intervalMs !== previousIntervalMs) {
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => {
        this.tick().catch(() => {});
      }, this.config.intervalMs);
      this.pushLog({
        level: "info",
        result: "runner-interval-updated",
        intervalMs: this.config.intervalMs,
      });
    }

    return this.getState();
  }

  getState() {
    return {
      ...this.config,
      baseNotionalUsdc6: this.config.baseNotionalUsdc6.toString(),
      ready: this.ready,
      runnerAddress: this.runnerAddress || "",
      logs: this.logs.slice(0, 50),
    };
  }
}

module.exports = { SwapRunnerService };
