const { Contract, formatUnits } = require("ethers");
const { ERC20_ABI, SWAP_ADAPTER_ABI, ORACLE_ABI, POOL_ABI } = require("../lib/abis");
const { clamp, nowIso } = require("../lib/utils");

class SwapRunnerService {
  constructor({
    provider,
    signer,
    configuredRunnerAddress,
    swapAdapterAddress,
    oracleAddress,
    swapperAddress,
    initialConfig,
  }) {
    this.provider = provider;
    this.signer = signer;
    this.configuredRunnerAddress = String(configuredRunnerAddress || "");
    this.swapAdapterAddress = swapAdapterAddress;
    this.oracleAddress = oracleAddress;
    this.swapperAddress = String(swapperAddress || "");
    this.timer = null;
    this.summaryTimer = null;
    this.autoStopTimer = null;
    this.inFlight = false;
    this.logs = [];
    this.ready = false;
    this.startedAtMs = 0;
    this.nextAutoStopAtMs = 0;

    this.config = {
      enabled: Boolean(initialConfig?.enabled),
      trend: clamp(Number(initialConfig?.trend ?? 0), -1, 1),
      volatility: clamp(Number(initialConfig?.volatility ?? 0.2), 0, 1),
      baseNotionalUsdc6: BigInt(initialConfig?.baseNotionalUsdc6 ?? "10000000"),
      intervalMs: 500,
      maxRuntimeMs: Math.max(30_000, Number(initialConfig?.maxRuntimeMs ?? 300_000)),
    };
    this.resetAggregate();
  }

  resetAggregate() {
    this.aggregate = {
      startedAtMs: Date.now(),
      samples: 0,
      upMoves: 0,
      downMoves: 0,
      flatMoves: 0,
      netMovePct: 0,
      maxUpPct: 0,
      maxDownPct: 0,
      moves: [],
    };
  }

  recordPriceMove(priceMovePct) {
    if (!Number.isFinite(priceMovePct)) return;
    this.aggregate.samples += 1;
    this.aggregate.netMovePct += priceMovePct;
    const sign = priceMovePct >= 0 ? "+" : "";
    this.aggregate.moves.push(`${sign}${priceMovePct.toFixed(4)}%`);
    if (priceMovePct > 0) this.aggregate.upMoves += 1;
    else if (priceMovePct < 0) this.aggregate.downMoves += 1;
    else this.aggregate.flatMoves += 1;
    if (priceMovePct > this.aggregate.maxUpPct) this.aggregate.maxUpPct = priceMovePct;
    if (priceMovePct < this.aggregate.maxDownPct) this.aggregate.maxDownPct = priceMovePct;
  }

  flushAggregate(reason = "window") {
    const nowMs = Date.now();
    const elapsedMs = Math.max(0, nowMs - this.aggregate.startedAtMs);
    const elapsedSec = Math.round(elapsedMs / 1000);
    const net = this.aggregate.netMovePct;
    const sign = net >= 0 ? "+" : "";
    const movesText = this.aggregate.moves.length > 0
      ? this.aggregate.moves.join(", ")
      : "none";
    this.pushLog({
      level: "info",
      result: "runner-aggregate",
      windowSec: elapsedSec,
      samples: this.aggregate.samples,
      upMoves: this.aggregate.upMoves,
      downMoves: this.aggregate.downMoves,
      flatMoves: this.aggregate.flatMoves,
      netMovePct: `${sign}${net.toFixed(4)}`,
      maxUpPct: `+${this.aggregate.maxUpPct.toFixed(4)}`,
      maxDownPct: this.aggregate.maxDownPct.toFixed(4),
      moves: this.aggregate.moves,
      message: `20s aggregate: moved ${sign}${net.toFixed(4)}%, moves: ${movesText} (${this.aggregate.moves.length} moves)`,
      reason,
    });
    this.resetAggregate();
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
      this.runnerAddress = this.configuredRunnerAddress || "";
      this.pushLog({
        level: "warn",
        result: "runner-disabled-no-signer",
        runnerAddress: this.runnerAddress,
        swapperAddress: this.swapperAddress || "",
      });
      return;
    }

    this.runnerAddress = await this.signer.getAddress();
    this.swapAdapter = new Contract(this.swapAdapterAddress, SWAP_ADAPTER_ABI, this.signer);
    this.oracle = this.oracleAddress ? new Contract(this.oracleAddress, ORACLE_ABI, this.provider) : null;
    this.usdcAddress = await this.swapAdapter.USDC();
    this.wethAddress = await this.swapAdapter.WETH();
    this.poolAddress = await this.swapAdapter.pool();
    this.pool = new Contract(this.poolAddress, POOL_ABI, this.provider);

    this.usdc = new Contract(this.usdcAddress, ERC20_ABI, this.signer);
    this.weth = new Contract(this.wethAddress, ERC20_ABI, this.signer);

    await this.ensureApprovals();
    this.ready = true;
    this.pushLog({
      level: "info",
      result: "runner-ready",
      runnerAddress: this.runnerAddress,
      swapperAddress: this.swapperAddress || "",
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
    const scale = 1 + noise * 0.45;
    const value = Number(this.config.baseNotionalUsdc6) * scale;
    const bounded = Math.max(10_000, Math.round(value));
    return BigInt(bounded);
  }

  fmtUsdc6(value) {
    return Number(formatUnits(value, 6)).toFixed(2);
  }

  fmtEth18(value) {
    return Number(formatUnits(value, 18)).toFixed(6);
  }

  async collectDiagnostics() {
    const diagnostics = {
      poolUsdc6: null,
      poolWeth18: null,
      runnerEthWei: null,
      runnerUsdc6: null,
      runnerWeth18: null,
    };

    try {
      const calls = [];
      if (this.poolAddress) {
        calls.push(this.usdc.balanceOf(this.poolAddress));
        calls.push(this.weth.balanceOf(this.poolAddress));
      } else {
        calls.push(Promise.resolve(0n), Promise.resolve(0n));
      }

      calls.push(this.provider.getBalance(this.runnerAddress));
      calls.push(this.usdc.balanceOf(this.runnerAddress));
      calls.push(this.weth.balanceOf(this.runnerAddress));

      const [poolUsdc6, poolWeth18, runnerEthWei, runnerUsdc6, runnerWeth18] = await Promise.all(calls);
      diagnostics.poolUsdc6 = poolUsdc6;
      diagnostics.poolWeth18 = poolWeth18;
      diagnostics.runnerEthWei = runnerEthWei;
      diagnostics.runnerUsdc6 = runnerUsdc6;
      diagnostics.runnerWeth18 = runnerWeth18;
    } catch {
      // Keep logging resilient even if diagnostics RPC calls fail.
    }

    return diagnostics;
  }

  trendStrengthMultiplier() {
    return 1 + Math.abs(this.config.trend) * 1.5;
  }

  shouldMoveUp() {
    const trend = clamp(Number(this.config.trend || 0), -1, 1);
    const volatility = clamp(Number(this.config.volatility || 0), 0, 1);

    // volatility=0 => deterministic direction by trend.
    if (volatility <= 0.0001) {
      if (trend > 0) return true;
      if (trend < 0) return false;
      return Math.random() < 0.5;
    }

    // Higher volatility increases direction flips, but trend still dominates overall.
    const chance = clamp(0.5 + trend * (0.5 - 0.25 * volatility), 0.05, 0.95);
    return Math.random() < chance;
  }

  reverseTrendForOutOfFunds(direction, amountUsdc6, diagnostics) {
    const previousTrend = Number(this.config.trend || 0);
    const nextTrend = previousTrend === 0 ? (direction === "UP" ? -0.2 : 0.2) : -previousTrend;
    this.config.trend = clamp(nextTrend, -1, 1);
    this.pushLog({
      level: "warn",
      result: "runner-trend-reversed-out-of-funds",
      previousTrend,
      newTrend: this.config.trend,
      direction,
      requiredUsdc6: String(amountUsdc6 || 0n),
      runnerUsdc6: String(diagnostics?.runnerUsdc6 || 0n),
      runnerWeth18: String(diagnostics?.runnerWeth18 || 0n),
      message: "Runner out of funds for current direction. Trend reversed automatically.",
    });
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
        Math.round(Number(amountUsdc6) * this.trendStrengthMultiplier())
      )
    );

    try {
      const priceBeforeE18 = this.oracle ? await this.oracle.getPriceE18() : null;
      const priceBefore = priceBeforeE18 ? Number(formatUnits(priceBeforeE18, 18)) : null;
      let estimatedWeth18 = 0n;
      const usdcNotional = Number(formatUnits(amountUsdc6, 6));
      const diagnosticsBefore = await this.collectDiagnostics();

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

      if (executeUp) {
        if ((diagnosticsBefore.runnerUsdc6 || 0n) < amountUsdc6) {
          this.reverseTrendForOutOfFunds("UP", amountUsdc6, diagnosticsBefore);
          return;
        }
      } else if (estimatedWeth18 > 0n && (diagnosticsBefore.runnerWeth18 || 0n) < estimatedWeth18) {
        this.reverseTrendForOutOfFunds("DOWN", amountUsdc6, diagnosticsBefore);
        return;
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
      if (priceMovePct !== null) {
        this.recordPriceMove(priceMovePct);
      }
      const estimatedEth = Number(formatUnits(estimatedWeth18, 18));
      const diagnosticsAfter = await this.collectDiagnostics();
      const moveText =
        priceMovePct === null
          ? "n/a"
          : `${priceMovePct >= 0 ? "+" : ""}${priceMovePct.toFixed(4)}%`;
      const message = executeUp
        ? `Buying ${usdcNotional.toFixed(2)} USDC of WETH (~${estimatedEth.toFixed(6)} ETH est), moved price ${moveText} | pool: ${this.fmtEth18(diagnosticsAfter.poolWeth18 || 0n)} WETH / ${this.fmtUsdc6(diagnosticsAfter.poolUsdc6 || 0n)} USDC | runner: ${this.fmtEth18(diagnosticsAfter.runnerEthWei || 0n)} ETH / ${this.fmtUsdc6(diagnosticsAfter.runnerUsdc6 || 0n)} USDC`
        : `Selling ${estimatedEth.toFixed(6)} ETH for ${usdcNotional.toFixed(2)} USDC, moved price ${moveText} | pool: ${this.fmtEth18(diagnosticsAfter.poolWeth18 || 0n)} WETH / ${this.fmtUsdc6(diagnosticsAfter.poolUsdc6 || 0n)} USDC | runner: ${this.fmtEth18(diagnosticsAfter.runnerEthWei || 0n)} ETH / ${this.fmtUsdc6(diagnosticsAfter.runnerUsdc6 || 0n)} USDC`;

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
        tradeSizeUsdc6: amountUsdc6.toString(),
        tradeSizeEth18: estimatedWeth18.toString(),
        priceBefore: priceBefore !== null ? priceBefore.toFixed(6) : null,
        priceAfter: priceAfter !== null ? priceAfter.toFixed(6) : null,
        priceMovePct: priceMovePct !== null ? priceMovePct.toFixed(6) : null,
        poolAddress: this.poolAddress || null,
        poolWeth18Before: (diagnosticsBefore.poolWeth18 || 0n).toString(),
        poolUsdc6Before: (diagnosticsBefore.poolUsdc6 || 0n).toString(),
        poolWeth18After: (diagnosticsAfter.poolWeth18 || 0n).toString(),
        poolUsdc6After: (diagnosticsAfter.poolUsdc6 || 0n).toString(),
        runnerEthWeiBefore: (diagnosticsBefore.runnerEthWei || 0n).toString(),
        runnerUsdc6Before: (diagnosticsBefore.runnerUsdc6 || 0n).toString(),
        runnerEthWeiAfter: (diagnosticsAfter.runnerEthWei || 0n).toString(),
        runnerUsdc6After: (diagnosticsAfter.runnerUsdc6 || 0n).toString(),
        message,
        txHash: receipt.hash,
        txStatus: Number(receipt.status),
        result: "ok",
      });
    } catch (error) {
      const diagnosticsFail = await this.collectDiagnostics();
        this.pushLog({
          level: "error",
        direction,
        txStage: "failed",
        notionalUsdc6: amountUsdc6.toString(),
        notionalUsdc: Number(formatUnits(amountUsdc6, 6)).toFixed(2),
        tradeSizeUsdc6: amountUsdc6.toString(),
        poolAddress: this.poolAddress || null,
        poolWeth18: (diagnosticsFail.poolWeth18 || 0n).toString(),
        poolUsdc6: (diagnosticsFail.poolUsdc6 || 0n).toString(),
        runnerEthWei: (diagnosticsFail.runnerEthWei || 0n).toString(),
        runnerUsdc6: (diagnosticsFail.runnerUsdc6 || 0n).toString(),
        message: `trade ${Number(formatUnits(amountUsdc6, 6)).toFixed(2)} USDC failed | pool: ${this.fmtEth18(diagnosticsFail.poolWeth18 || 0n)} WETH / ${this.fmtUsdc6(diagnosticsFail.poolUsdc6 || 0n)} USDC | runner: ${this.fmtEth18(diagnosticsFail.runnerEthWei || 0n)} ETH / ${this.fmtUsdc6(diagnosticsFail.runnerUsdc6 || 0n)} USDC`,
        result: error?.shortMessage || error?.message || String(error),
        });
      const text = String(error?.shortMessage || error?.message || error || "").toLowerCase();
      if (
        text.includes("insufficient") ||
        text.includes("exceeds balance") ||
        text.includes("transfer amount exceeds balance")
      ) {
        this.reverseTrendForOutOfFunds(direction, amountUsdc6, diagnosticsFail);
      }
    } finally {
      this.inFlight = false;
    }
  }

  start() {
    if (!this.ready) return;
    if (this.timer) clearInterval(this.timer);
    if (this.autoStopTimer) clearTimeout(this.autoStopTimer);
    this.config.enabled = true;
    this.startedAtMs = Date.now();
    this.nextAutoStopAtMs = this.startedAtMs + this.config.maxRuntimeMs;
    this.pushLog({
      level: "info",
      result: "runner-started",
      intervalMs: this.config.intervalMs,
      maxRuntimeMs: this.config.maxRuntimeMs,
    });

    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, this.config.intervalMs);
    this.summaryTimer = setInterval(() => {
      this.flushAggregate("interval");
    }, 20_000);
    this.autoStopTimer = setTimeout(() => {
      this.pushLog({
        level: "warn",
        result: "runner-auto-stopped",
        message: "Runner auto-stopped after max runtime window.",
        maxRuntimeMs: this.config.maxRuntimeMs,
      });
      this.stop();
    }, this.config.maxRuntimeMs);

    this.tick().catch(() => {});
  }

  stop() {
    const wasEnabled = this.config.enabled;
    this.config.enabled = false;
    if (this.timer) clearInterval(this.timer);
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    if (this.autoStopTimer) clearTimeout(this.autoStopTimer);
    this.timer = null;
    this.summaryTimer = null;
    this.autoStopTimer = null;
    this.nextAutoStopAtMs = 0;
    if (wasEnabled) {
      this.flushAggregate("stop");
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
    this.config.intervalMs = 500;
    if (next.maxRuntimeMs !== undefined) {
      this.config.maxRuntimeMs = Math.max(30_000, Number(next.maxRuntimeMs));
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
      if (this.autoStopTimer) {
        clearTimeout(this.autoStopTimer);
        const msLeft = Math.max(1_000, this.nextAutoStopAtMs - Date.now());
        this.autoStopTimer = setTimeout(() => {
          this.pushLog({
            level: "warn",
            result: "runner-auto-stopped",
            message: "Runner auto-stopped after max runtime window.",
            maxRuntimeMs: this.config.maxRuntimeMs,
          });
          this.stop();
        }, msLeft);
      }
    }

    return this.getState();
  }

  getState() {
    const runtimeLeftMs = this.config.enabled && this.nextAutoStopAtMs > 0
      ? Math.max(0, this.nextAutoStopAtMs - Date.now())
      : 0;
    return {
      ...this.config,
      baseNotionalUsdc6: this.config.baseNotionalUsdc6.toString(),
      ready: this.ready,
      runnerAddress: this.runnerAddress || "",
      swapperAddress: this.swapperAddress || "",
      runtimeLeftMs,
      logs: this.logs.slice(0, 50),
    };
  }
}

module.exports = { SwapRunnerService };
