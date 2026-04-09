"use strict";

const E18 = 10n ** 18n;
const E12 = 10n ** 12n;
const USDC_SCALE = 10n ** 6n;
const PROFIT_PPM_SCALE = 1_000_000n;

const SIDE = {
  LONG: "LONG",
  SHORT: "SHORT",
};

const STATUS = {
  OPEN: "OPEN",
  CLOSED_TP: "CLOSED_TP",
  CLOSED_SL: "CLOSED_SL",
  CLOSED_EARLY: "CLOSED_EARLY",
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

class MakeitV4Model {
  constructor({ owner = "owner" } = {}) {
    this.owner = owner;
    this.dexAddress = "dex";

    // Compatibility defaults used by the JS runners when they do not pass per-trade values.
    this.marginUSDC = 10n * USDC_SCALE;
    this.leverage = 300n;

    // Solidity initialize() defaults.
    this.maxLeverage = 300n;
    this.liquidityProvisionFeePpm = 7_000n;
    this.protocolFeePpm = 3_000n;
    this.protocolFeeRecipient = owner;
    this.tradingIsFrozen = false;

    this.openLongNotionalUSDC = 0n;
    this.openShortNotionalUSDC = 0n;
    this.reservedMarginUSDC = 0n;
    this.protocolFeeAccruedUSDC = 0n;
    this.nextTradeId = 1;

    // Derived compatibility counters for the existing runner/reporting layer.
    this.openLongMarginUSDC = 0n;
    this.openShortMarginUSDC = 0n;
    this.openNotionalUSDC = 0n;
    this.openMarginUSDC = 0n;
    this.feeBucketUSDC = 0n;

    this.mockPriceE18 = 3000n * E18;

    this.usdcBalances = new Map();
    this.wethBalances = new Map();
    this.trades = new Map();
  }

  _get(map, addr) {
    return map.get(addr) ?? 0n;
  }

  _set(map, addr, value) {
    if (value === 0n) map.delete(addr);
    else map.set(addr, value);
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

  balanceUSDC(addr) {
    return this._get(this.usdcBalances, addr);
  }

  balanceWETH(addr) {
    return this._get(this.wethBalances, addr);
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

  setMockPriceE18(sender, priceE18) {
    const price = toBigInt(priceE18);
    if (sender !== this.owner) throw new Error("not owner");
    if (price <= 0n) throw new Error("bad price");
    this.mockPriceE18 = price;
  }

  setFeeSplitPpm(sender, liquidityProvisionFeePpm, protocolFeePpm) {
    if (sender !== this.owner) throw new Error("not owner");
    const lp = toBigInt(liquidityProvisionFeePpm);
    const protocol = toBigInt(protocolFeePpm);
    if (lp + protocol > 1_000_000n) throw new Error("invalid fee split");
    this.liquidityProvisionFeePpm = lp;
    this.protocolFeePpm = protocol;
    this.feeBucketUSDC = this.protocolFeeAccruedUSDC;
  }

  setMaxLeverage(sender, newMaxLeverage) {
    const lev = toBigInt(newMaxLeverage);
    if (sender !== this.owner) throw new Error("not owner");
    if (lev <= 1n) throw new Error("invalid max leverage");
    this.maxLeverage = lev;
  }

  setTradingFrozen(sender, frozen) {
    if (sender !== this.owner) throw new Error("not owner");
    this.tradingIsFrozen = !!frozen;
  }

  setProtocolFeeRecipient(sender, newRecipient) {
    if (sender !== this.owner) throw new Error("not owner");
    if (!newRecipient) throw new Error("invalid recipient");
    this.protocolFeeRecipient = newRecipient;
  }

  _baseTotalFeePpm() {
    return this.liquidityProvisionFeePpm + this.protocolFeePpm;
  }

  _totalFeeAmountUSDC(tradeMarginUSDC = this.marginUSDC, tradeLeverage = this.leverage) {
    return (toBigInt(tradeMarginUSDC) * toBigInt(tradeLeverage) * this._baseTotalFeePpm()) / PROFIT_PPM_SCALE;
  }

  _protocolFeeAmountUSDC(tradeMarginUSDC = this.marginUSDC, tradeLeverage = this.leverage) {
    return (toBigInt(tradeMarginUSDC) * toBigInt(tradeLeverage) * this.protocolFeePpm) / PROFIT_PPM_SCALE;
  }

  _tradeMarginUSDC(tradeMarginUSDC = this.marginUSDC, tradeLeverage = this.leverage) {
    const gross = toBigInt(tradeMarginUSDC);
    const feeAmount = this._totalFeeAmountUSDC(gross, tradeLeverage);
    if (feeAmount >= gross) throw new Error("effective margin too small");
    return gross - feeAmount;
  }

  // Compatibility helpers used by the existing runner.
  _effectiveMarginUSDC(tradeMarginUSDC = this.marginUSDC, tradeLeverage = this.leverage) {
    return this._tradeMarginUSDC(tradeMarginUSDC, tradeLeverage);
  }

  _feeAmountUSDC(tradeMarginUSDC = this.marginUSDC, tradeLeverage = this.leverage) {
    return toBigInt(tradeMarginUSDC) - this._effectiveMarginUSDC(tradeMarginUSDC, tradeLeverage);
  }

  _levelsLong(entryPriceE18, profitTargetPpm, tradeLeverage) {
    const entry = toBigInt(entryPriceE18);
    const tpPpm = toBigInt(profitTargetPpm);
    const lev = toBigInt(tradeLeverage);
    const tpMove = (entry * tpPpm) / (PROFIT_PPM_SCALE * lev);
    const slMove = entry / lev;
    if (tpPpm === 0n || tpMove === 0n || slMove === 0n || tpMove >= entry || slMove >= entry) {
      throw new Error("invalid profit target");
    }
    return { tp: entry + tpMove, sl: entry - slMove };
  }

  _levelsShort(entryPriceE18, profitTargetPpm, tradeLeverage) {
    const entry = toBigInt(entryPriceE18);
    const tpPpm = toBigInt(profitTargetPpm);
    const lev = toBigInt(tradeLeverage);
    const tpMove = (entry * tpPpm) / (PROFIT_PPM_SCALE * lev);
    const slMove = entry / lev;
    if (tpPpm === 0n || tpMove === 0n || slMove === 0n) throw new Error("invalid profit target");
    return { tp: entry - tpMove, sl: entry + slMove };
  }

  // Compatibility aliases.
  _levels(entryPriceE18, profitTargetPpm) {
    return this._levelsLong(entryPriceE18, profitTargetPpm, this.leverage);
  }

  _levelsShortCompat(entryPriceE18, profitTargetPpm) {
    return this._levelsShort(entryPriceE18, profitTargetPpm, this.leverage);
  }

  _targetProfitUSDC(trade) {
    const tpPpm = toBigInt(trade.profitTargetPpm ?? 0n);
    return (toBigInt(trade.marginUSDC) * tpPpm) / PROFIT_PPM_SCALE;
  }

  _ethValueUSDC(priceE18) {
    const valueE18 = (this.balanceWETH(this.dexAddress) * toBigInt(priceE18)) / E18;
    return valueE18 / E12;
  }

  _wethFromUsdcCeil(usdcAmount6, priceE18) {
    const usdc6 = toBigInt(usdcAmount6);
    const price = toBigInt(priceE18);
    return (usdc6 * E12 * E18 + price - 1n) / price;
  }

  _wethFromUsdcFloor(usdcAmount6, priceE18) {
    const usdc6 = toBigInt(usdcAmount6);
    const price = toBigInt(priceE18);
    return (usdc6 * E12 * E18) / price;
  }

  _usdcFromWeth(wethAmount18, priceE18) {
    const weth18 = toBigInt(wethAmount18);
    const price = toBigInt(priceE18);
    return ((weth18 * price) / E18) / E12;
  }

  _sellWETHForExactUSDC(usdcNeeded6, priceE18 = this.getOraclePriceE18()) {
    const need = toBigInt(usdcNeeded6);
    if (need <= 0n) return [0n, 0n];
    const soldWETH = this._wethFromUsdcCeil(need, priceE18);
    if (this.balanceWETH(this.dexAddress) < soldWETH) throw new Error("insufficient WETH");
    const usdcOut = this._usdcFromWeth(soldWETH, priceE18);
    this._set(this.wethBalances, this.dexAddress, this.balanceWETH(this.dexAddress) - soldWETH);
    this._set(this.usdcBalances, this.dexAddress, this.balanceUSDC(this.dexAddress) + usdcOut);
    return [soldWETH, usdcOut];
  }

  _buyWETHWithExactUSDC(usdcIn6, priceE18 = this.getOraclePriceE18()) {
    const spend = toBigInt(usdcIn6);
    if (spend <= 0n) return [0n, 0n];
    if (this.balanceUSDC(this.dexAddress) < spend) throw new Error("insufficient USDC");
    const wethOut = this._wethFromUsdcFloor(spend, priceE18);
    this._set(this.usdcBalances, this.dexAddress, this.balanceUSDC(this.dexAddress) - spend);
    this._set(this.wethBalances, this.dexAddress, this.balanceWETH(this.dexAddress) + wethOut);
    return [spend, wethOut];
  }

  // Compatibility aliases for the previous JS model.
  _sellEthForUsdc(usdcNeeded6, priceE18 = this.getOraclePriceE18()) {
    const [soldWETH, raisedUSDC] = this._sellWETHForExactUSDC(usdcNeeded6, priceE18);
    return { soldWETH, raisedUSDC };
  }

  _buyEthWithUsdc(usdcIn6, priceE18 = this.getOraclePriceE18()) {
    const [spentUSDC, boughtWETH] = this._buyWETHWithExactUSDC(usdcIn6, priceE18);
    return { spentUSDC, boughtWETH };
  }

  _withdrawableProtocolFees(poolUSDC = this.balanceUSDC(this.dexAddress)) {
    const pool = toBigInt(poolUSDC);
    if (pool <= this.reservedMarginUSDC) return 0n;
    const unreservedUSDC = pool - this.reservedMarginUSDC;
    return this.protocolFeeAccruedUSDC < unreservedUSDC ? this.protocolFeeAccruedUSDC : unreservedUSDC;
  }

  _freeUsdcBalance() {
    const poolUSDC = this.balanceUSDC(this.dexAddress);
    if (poolUSDC < this.reservedMarginUSDC) throw new Error("reserved margin exceeds pool USDC");
    return poolUSDC - this.reservedMarginUSDC - this._withdrawableProtocolFees(poolUSDC);
  }

  _syncDerivedExposure() {
    const net = this.openLongNotionalUSDC - this.openShortNotionalUSDC;
    this.openNotionalUSDC = net > 0n ? net : 0n;
    this.openMarginUSDC = this.openLongMarginUSDC + this.openShortMarginUSDC;
    this.feeBucketUSDC = this.protocolFeeAccruedUSDC;
  }

  _validatePrice(expectedPriceE18, toleranceBps) {
    const expected = toBigInt(expectedPriceE18);
    const tolerance = toBigInt(toleranceBps);
    if (expected <= 0n) throw new Error("invalid expected price");
    if (tolerance > 10_000n) throw new Error("invalid tolerance");

    const price = this.getOraclePriceE18();
    const diff = price > expected ? price - expected : expected - price;
    if (diff * 10_000n > expected * tolerance) throw new Error("price out of tolerance");
    return price;
  }

  _hitLevels(trade, closePriceE18) {
    const price = toBigInt(closePriceE18);
    if (trade.side === SIDE.LONG) {
      return { hitTP: price >= trade.tpPriceE18, hitSL: price <= trade.slPriceE18 };
    }
    return { hitTP: price <= trade.tpPriceE18, hitSL: price >= trade.slPriceE18 };
  }

  _realizedPnlUSDC(trade, closePriceE18) {
    const price = toBigInt(closePriceE18);
    let priceDelta;
    if (trade.side === SIDE.LONG) {
      priceDelta = price >= trade.entryPriceE18 ? price - trade.entryPriceE18 : -(trade.entryPriceE18 - price);
    } else {
      priceDelta = price <= trade.entryPriceE18 ? trade.entryPriceE18 - price : -(price - trade.entryPriceE18);
    }
    return (toBigInt(trade.notionalUSDC) * priceDelta) / trade.entryPriceE18;
  }

  _openTrade(side, sender, expectedPriceE18, toleranceBps, profitTargetPpm, tradeLeverage, tradeMarginUSDC) {
    const lev = toBigInt(tradeLeverage);
    const grossMargin = toBigInt(tradeMarginUSDC);
    const tpPpm = toBigInt(profitTargetPpm);

    if (this.tradingIsFrozen) throw new Error("trading frozen");
    if (lev <= 1n || lev > this.maxLeverage) throw new Error("invalid trade leverage");

    const price = this._validatePrice(expectedPriceE18, toleranceBps);
    const effectiveMargin = this._tradeMarginUSDC(grossMargin, lev);
    const notional = effectiveMargin * lev;

    if (side === SIDE.LONG) {
      const requestedOpenNotional = (() => {
        const netLong = this.openLongNotionalUSDC + notional - this.openShortNotionalUSDC;
        return netLong > 0n ? netLong : 0n;
      })();
      const availableNotional = this._ethValueUSDC(price);
      if (requestedOpenNotional > availableNotional) throw new Error("insufficient ETH coverage");
    } else {
      const requestedShortNotional = this.openShortNotionalUSDC + notional;
      if (requestedShortNotional > this.openLongNotionalUSDC) throw new Error("no long notional to offset short");
    }

    this._transfer(this.usdcBalances, sender, this.dexAddress, grossMargin, "USDC");

    const protocolFeeAmount = this._protocolFeeAmountUSDC(grossMargin, lev);
    if (protocolFeeAmount > 0n) this.protocolFeeAccruedUSDC += protocolFeeAmount;

    const levels =
      side === SIDE.LONG ? this._levelsLong(price, tpPpm, lev) : this._levelsShort(price, tpPpm, lev);

    const tradeId = this.nextTradeId++;
    this.trades.set(tradeId, {
      trader: sender,
      side,
      status: STATUS.OPEN,
      openedAt: 0,
      profitTargetPpm: tpPpm,
      leverage: lev,
      marginUSDC: effectiveMargin,
      notionalUSDC: notional,
      entryPriceE18: price,
      tpPriceE18: levels.tp,
      slPriceE18: levels.sl,
    });

    if (side === SIDE.LONG) {
      this.openLongNotionalUSDC += notional;
      this.openLongMarginUSDC += effectiveMargin;
    } else {
      this.openShortNotionalUSDC += notional;
      this.openShortMarginUSDC += effectiveMargin;
    }
    this.reservedMarginUSDC += effectiveMargin;
    this._syncDerivedExposure();
    return tradeId;
  }

  openLongTrade(sender, expectedPriceE18, toleranceBps, profitTargetPpm, tradeLeverage = this.leverage, tradeMarginUSDC = this.marginUSDC) {
    return this._openTrade(SIDE.LONG, sender, expectedPriceE18, toleranceBps, profitTargetPpm, tradeLeverage, tradeMarginUSDC);
  }

  openShortTrade(sender, expectedPriceE18, toleranceBps, profitTargetPpm, tradeLeverage = this.leverage, tradeMarginUSDC = this.marginUSDC) {
    return this._openTrade(SIDE.SHORT, sender, expectedPriceE18, toleranceBps, profitTargetPpm, tradeLeverage, tradeMarginUSDC);
  }

  // Compatibility wrappers used by the current JS runner.
  openTrade(sender, expectedPriceE18, toleranceBps, profitTargetPpm) {
    return this.openLongTrade(sender, expectedPriceE18, toleranceBps, profitTargetPpm, this.leverage, this.marginUSDC);
  }

  _settleTrade(tradeId, trade, closeStatus, closePriceE18, pnlUSDC) {
    const payoutSigned = trade.marginUSDC + pnlUSDC;
    const payoutUSDC = payoutSigned <= 0n ? 0n : payoutSigned;
    const releasedMarginUSDC = trade.marginUSDC;
    const availableUsdc = this._freeUsdcBalance() + releasedMarginUSDC;
    let soldWETHForProfit = 0n;
    let boughtWETHOnSL = 0n;

    if (availableUsdc < payoutUSDC) {
      const neededUSDC = payoutUSDC - availableUsdc;
      const [soldWETH, usdcOut] = this._sellWETHForExactUSDC(neededUSDC, closePriceE18);
      if (usdcOut < neededUSDC) throw new Error("swap did not raise enough USDC");
      soldWETHForProfit = soldWETH;
    }

    this.reservedMarginUSDC -= releasedMarginUSDC;
    if (payoutUSDC < trade.marginUSDC && trade.side === SIDE.LONG) {
      const lostUSDC = trade.marginUSDC - payoutUSDC;
      const [, boughtWETH] = this._buyWETHWithExactUSDC(lostUSDC, closePriceE18);
      boughtWETHOnSL = boughtWETH;
    }

    if (payoutUSDC > 0n) {
      const poolUSDC = this.balanceUSDC(this.dexAddress);
      if (poolUSDC < this.reservedMarginUSDC + payoutUSDC) throw new Error("reserved margin exceeds pool USDC");
      this._transfer(this.usdcBalances, this.dexAddress, trade.trader, payoutUSDC, "USDC");
    }

    if (trade.side === SIDE.LONG) {
      this.openLongNotionalUSDC -= trade.notionalUSDC;
      this.openLongMarginUSDC -= trade.marginUSDC;
    } else {
      this.openShortNotionalUSDC -= trade.notionalUSDC;
      this.openShortMarginUSDC -= trade.marginUSDC;
    }
    trade.status = closeStatus;
    this._syncDerivedExposure();

    return {
      side: trade.side,
      status: trade.status,
      closePriceE18,
      tradePnlUSDC: pnlUSDC,
      payoutMarginUSDC: payoutUSDC > 0n ? trade.marginUSDC : 0n,
      payoutProfitWETH: 0n,
      payoutProfitUSDC: payoutUSDC > trade.marginUSDC ? payoutUSDC - trade.marginUSDC : 0n,
      soldWETHForProfit,
      boughtWETHOnSL,
    };
  }

  close(caller, tradeId) {
    const trade = this.trades.get(tradeId);
    if (!trade || trade.status !== STATUS.OPEN) throw new Error("trade not open");
    if (caller !== trade.trader) throw new Error("not trader");

    const closePriceE18 = this.getOraclePriceE18();
    const { hitTP, hitSL } = this._hitLevels(trade, closePriceE18);
    if (hitTP || hitSL) throw new Error("must use liquidation");

    const pnlUSDC = this._realizedPnlUSDC(trade, closePriceE18);
    return this._settleTrade(tradeId, trade, STATUS.CLOSED_EARLY, closePriceE18, pnlUSDC);
  }

  liquidateTrade(_caller, tradeId) {
    const trade = this.trades.get(tradeId);
    if (!trade || trade.status !== STATUS.OPEN) throw new Error("trade not open");

    const closePriceE18 = this.getOraclePriceE18();
    const { hitTP, hitSL } = this._hitLevels(trade, closePriceE18);
    if (!hitTP && !hitSL) throw new Error("no TP/SL");

    const pnlUSDC = hitTP ? this._targetProfitUSDC(trade) : -trade.marginUSDC;
    const closeStatus = hitTP ? STATUS.CLOSED_TP : STATUS.CLOSED_SL;
    return this._settleTrade(tradeId, trade, closeStatus, closePriceE18, pnlUSDC);
  }

  tryOpenTrade(sender, expectedPriceE18, toleranceBps, profitTargetPpm) {
    try {
      const tradeId = this.openTrade(sender, expectedPriceE18, toleranceBps, profitTargetPpm);
      return { ok: true, tradeId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  tryOpenShortTrade(sender, expectedPriceE18, toleranceBps, profitTargetPpm) {
    try {
      const tradeId = this.openShortTrade(sender, expectedPriceE18, toleranceBps, profitTargetPpm, this.leverage, this.marginUSDC);
      return { ok: true, tradeId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Compatibility: existing runner uses tryClose as liquidation sweep.
  tryClose(sender, tradeId) {
    try {
      const result = this.liquidateTrade(sender, tradeId);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  tryEarlyClose(sender, tradeId) {
    try {
      const result = this.close(sender, tradeId);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  tradeCounts() {
    let open = 0;
    let tp = 0;
    let sl = 0;
    let early = 0;
    let openLong = 0;
    let openShort = 0;
    let tpLong = 0;
    let tpShort = 0;
    let slLong = 0;
    let slShort = 0;

    for (const trade of this.trades.values()) {
      if (trade.status === STATUS.OPEN) {
        open++;
        if (trade.side === SIDE.LONG) openLong++;
        else openShort++;
      } else if (trade.status === STATUS.CLOSED_TP) {
        tp++;
        if (trade.side === SIDE.LONG) tpLong++;
        else tpShort++;
      } else if (trade.status === STATUS.CLOSED_SL) {
        sl++;
        if (trade.side === SIDE.LONG) slLong++;
        else slShort++;
      } else if (trade.status === STATUS.CLOSED_EARLY) {
        early++;
      }
    }

    return { open, tp, sl, early, openLong, openShort, tpLong, tpShort, slLong, slShort };
  }

  holdOnlyEquityUSDC6(initialUSDC, initialWETH, priceE18 = this.getOraclePriceE18()) {
    const wethUsdc = ((toBigInt(initialWETH) * toBigInt(priceE18)) / E18) / E12;
    return toBigInt(initialUSDC) + wethUsdc;
  }

  totalAssets() {
    const wethAssets = this.balanceWETH(this.dexAddress);
    const freeUsdc = this._freeUsdcBalance();
    const priceE18 = this.getOraclePriceE18();
    if (priceE18 === 0n || freeUsdc === 0n) return wethAssets;
    return wethAssets + this._wethFromUsdcFloor(freeUsdc, priceE18);
  }

  availableWithdrawalAssets() {
    const priceE18 = this.getOraclePriceE18();
    if (priceE18 === 0n) return 0n;
    const currentWeth = this.balanceWETH(this.dexAddress);
    const netExposure = this.openLongNotionalUSDC > this.openShortNotionalUSDC
      ? this.openLongNotionalUSDC - this.openShortNotionalUSDC
      : 0n;
    const reservedBackingWeth = this._wethFromUsdcCeil(netExposure, priceE18);
    return currentWeth > reservedBackingWeth ? currentWeth - reservedBackingWeth : 0n;
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
      freePoolUSDC: this._freeUsdcBalance(),
      reservedMarginUSDC: this.reservedMarginUSDC,
      protocolFeeAccruedUSDC: this.protocolFeeAccruedUSDC,
      feeBucketUSDC: this.feeBucketUSDC,
      equityUSDC: poolUSDC + ethValueUSDC,
      openMarginUSDC: this.openMarginUSDC,
      openLongMarginUSDC: this.openLongMarginUSDC,
      openShortMarginUSDC: this.openShortMarginUSDC,
      openNotionalUSDC: this.openNotionalUSDC,
      openLongNotionalUSDC: this.openLongNotionalUSDC,
      openShortNotionalUSDC: this.openShortNotionalUSDC,
      ...counts,
    };
  }
}

// Backward-compatible export name used by the existing runner.
const LongShortOffsetDexModelV4 = MakeitV4Model;

module.exports = {
  MakeitV4Model,
  LongShortOffsetDexModelV4,
  SIDE,
  STATUS,
  toE18,
  fmtUSDC6,
  fmtWETH18,
  fmtPriceE18,
  USDC_SCALE,
  E18,
};
