"use strict";

const E18 = 10n ** 18n;
const E12 = 10n ** 12n;
const USDC_SCALE = 10n ** 6n;

const STATUS = {
  OPEN: "OPEN",
  CLOSED_TP: "CLOSED_TP",
  CLOSED_SL: "CLOSED_SL",
  CANCELED: "CANCELED",
};

function toBigInt(v) {
  return typeof v === "bigint" ? v : BigInt(v);
}

function toE18(price) {
  return toBigInt(price) * E18;
}

function formatUnits(value, decimals, fracDigits = 6) {
  const v = toBigInt(value);
  const d = toBigInt(decimals);
  const base = 10n ** d;
  const sign = v < 0n ? "-" : "";
  const abs = v < 0n ? -v : v;
  const whole = abs / base;
  const fracAll = (abs % base).toString().padStart(Number(d), "0");
  const frac = fracAll.slice(0, fracDigits).padEnd(fracDigits, "0");
  return `${sign}${whole}.${frac}`;
}

function fmtUSDC6(v) {
  return formatUnits(v, 6, 6);
}

function fmtWETH18(v) {
  return formatUnits(v, 18, 6);
}

function fmtPriceE18(v) {
  return formatUnits(v, 18, 2);
}

class LongOnlyKnockoutDexModelV1 {
  constructor({ owner = "owner" } = {}) {
    this.owner = owner;
    this.dexAddress = "dex";

    this.marginUSDC = 10n * USDC_SCALE;
    this.feeBps = 0n;
    this.leverage = 100n;
    this.openNotionalUSDC = 0n;
    this.openMarginUSDC = 0n;
    this.nextTradeId = 1;
    this.mockPriceE18 = 3000n * E18;

    this.usdcBalances = new Map();
    this.wethBalances = new Map();
    this.trades = new Map();
  }

  _get(map, a) {
    return map.get(a) ?? 0n;
  }

  _set(map, a, v) {
    if (v === 0n) map.delete(a);
    else map.set(a, v);
  }

  _transfer(map, from, to, amount, symbol) {
    const amt = toBigInt(amount);
    if (amt <= 0n) throw new Error("amount=0");
    const fromBal = this._get(map, from);
    if (fromBal < amt) throw new Error(`insufficient ${symbol}`);
    this._set(map, from, fromBal - amt);
    this._set(map, to, this._get(map, to) + amt);
  }

  mintUSDC(to, amount) {
    const amt = toBigInt(amount);
    this._set(this.usdcBalances, to, this._get(this.usdcBalances, to) + amt);
  }

  mintWETH(to, amount) {
    const amt = toBigInt(amount);
    this._set(this.wethBalances, to, this._get(this.wethBalances, to) + amt);
  }

  balanceUSDC(a) {
    return this._get(this.usdcBalances, a);
  }

  balanceWETH(a) {
    return this._get(this.wethBalances, a);
  }

  fundETH(sender, wethAmount) {
    this._transfer(this.wethBalances, sender, this.dexAddress, wethAmount, "WETH");
  }

  fundStable(sender, usdcAmount) {
    this._transfer(this.usdcBalances, sender, this.dexAddress, usdcAmount, "USDC");
  }

  getOraclePriceE18() {
    return this.mockPriceE18;
  }

  setMockPriceE18(sender, p) {
    const price = toBigInt(p);
    if (sender !== this.owner) throw new Error("not owner");
    if (price <= 0n) throw new Error("bad price");
    this.mockPriceE18 = price;
  }

  _levels(entryPriceE18, profitTargetUSDC, notionalUSDC) {
    const entry = toBigInt(entryPriceE18);
    const targetProfit = toBigInt(profitTargetUSDC);
    const notional = toBigInt(notionalUSDC);
    if (targetProfit <= 0n) throw new Error("pt=0");
    if (notional <= 0n) throw new Error("notional=0");
    const move = (entry * targetProfit) / notional;
    if (move > entry) throw new Error("underflow");
    return { tp: entry + move, sl: entry - move };
  }

  _effectiveMarginUSDC() {
    return this.marginUSDC - (this.marginUSDC * this.feeBps) / 10_000n;
  }

  _ethValueUSDC(priceE18) {
    const valueE18 = (this.balanceWETH(this.dexAddress) * toBigInt(priceE18)) / E18;
    return valueE18 / E12;
  }

  openTrade(sender, expectedPriceE18, toleranceBps, profitTargetBps) {
    const expected = toBigInt(expectedPriceE18);
    const tolerance = toBigInt(toleranceBps);
    const pt = toBigInt(profitTargetBps);

    if (tolerance > 10_000n) throw new Error("tol");
    if (expected <= 0n) throw new Error("exp=0");

    const price = this.getOraclePriceE18();
    const diff = price > expected ? price - expected : expected - price;
    if (diff * 10_000n > expected * tolerance) throw new Error("price out of tol");

    const notional = this._effectiveMarginUSDC() * this.leverage;
    const targetProfitUSDC = (this.marginUSDC * pt) / 100n;
    const ethValue = this._ethValueUSDC(price);
    if (this.openNotionalUSDC + notional > ethValue) throw new Error("insufficient ETH coverage");

    this._transfer(this.usdcBalances, sender, this.dexAddress, this.marginUSDC, "USDC");

    const { tp, sl } = this._levels(price, targetProfitUSDC, notional);
    if (sl <= 0n) throw new Error("bad SL");

    const tradeId = this.nextTradeId++;
    this.trades.set(tradeId, {
      trader: sender,
      status: STATUS.OPEN,
      entryPriceE18: price,
      tpPriceE18: tp,
      slPriceE18: sl,
      marginUSDC: this.marginUSDC,
      notionalUSDC: notional,
      profitTargetBps: pt,
      targetProfitUSDC,
    });

    this.openNotionalUSDC += notional;
    this.openMarginUSDC += this.marginUSDC;
    return tradeId;
  }

  close(_caller, tradeId) {
    const t = this.trades.get(tradeId);
    if (!t || t.status !== STATUS.OPEN) throw new Error("not open");

    const p = this.getOraclePriceE18();
    const hitTP = p >= t.tpPriceE18;
    const hitSL = p <= t.slPriceE18;
    if (!hitTP && !hitSL) throw new Error("no TP/SL");

    this.openNotionalUSDC -= t.notionalUSDC;
    this.openMarginUSDC -= t.marginUSDC;

    if (hitSL) {
      t.status = STATUS.CLOSED_SL;
      return { status: t.status, closePriceE18: p, payoutMarginUSDC: 0n, payoutProfitWETH: 0n };
    }

    t.status = STATUS.CLOSED_TP;

    if (this.balanceUSDC(this.dexAddress) < t.marginUSDC) throw new Error("insufficient USDC");
    this._transfer(this.usdcBalances, this.dexAddress, t.trader, t.marginUSDC, "USDC");

    const profitEth = (t.targetProfitUSDC * E12 * E18) / p;
    if (this.balanceWETH(this.dexAddress) < profitEth) throw new Error("insufficient WETH");
    this._transfer(this.wethBalances, this.dexAddress, t.trader, profitEth, "WETH");

    return {
      status: t.status,
      closePriceE18: p,
      payoutMarginUSDC: t.marginUSDC,
      payoutProfitWETH: profitEth,
      payoutProfitUSDC: t.targetProfitUSDC,
    };
  }

  tryOpenTrade(sender, expectedPriceE18, toleranceBps, profitTargetBps) {
    try {
      const tradeId = this.openTrade(sender, expectedPriceE18, toleranceBps, profitTargetBps);
      return { ok: true, tradeId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  tryClose(sender, tradeId) {
    try {
      const result = this.close(sender, tradeId);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  cancelOpenTrade(tradeId) {
    const t = this.trades.get(tradeId);
    if (!t || t.status !== STATUS.OPEN) throw new Error("not open");

    this.openNotionalUSDC -= t.notionalUSDC;
    this.openMarginUSDC -= t.marginUSDC;
    this._transfer(this.usdcBalances, this.dexAddress, t.trader, t.marginUSDC, "USDC");
    t.status = STATUS.CANCELED;
    return { status: t.status, refundedMarginUSDC: t.marginUSDC };
  }

  tradeCounts() {
    let open = 0;
    let tp = 0;
    let sl = 0;
    for (const t of this.trades.values()) {
      if (t.status === STATUS.OPEN) open++;
      else if (t.status === STATUS.CLOSED_TP) tp++;
      else if (t.status === STATUS.CLOSED_SL) sl++;
    }
    return { open, tp, sl };
  }

  holdOnlyEquityUSDC6(initialUSDC, initialWETH, priceE18 = this.getOraclePriceE18()) {
    const wethUsdc = ((toBigInt(initialWETH) * toBigInt(priceE18)) / E18) / E12;
    return toBigInt(initialUSDC) + wethUsdc;
  }

  poolStats() {
    const price = this.getOraclePriceE18();
    const poolUSDC = this.balanceUSDC(this.dexAddress);
    const poolWETH = this.balanceWETH(this.dexAddress);
    const ethValueUSDC = this._ethValueUSDC(price);
    const counts = this.tradeCounts();
    return {
      oraclePriceE18: price,
      poolUSDC,
      poolWETH,
      ethValueUSDC,
      equityUSDC: poolUSDC + ethValueUSDC,
      openMarginUSDC: this.openMarginUSDC,
      openNotionalUSDC: this.openNotionalUSDC,
      ...counts,
    };
  }
}

module.exports = {
  LongOnlyKnockoutDexModelV1,
  STATUS,
  toE18,
  fmtUSDC6,
  fmtWETH18,
  fmtPriceE18,
  USDC_SCALE,
  E18,
};
