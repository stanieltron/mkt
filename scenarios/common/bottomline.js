"use strict";

function toBigInt(v) {
  if (typeof v === "bigint") return v;
  if (v === undefined || v === null) return 0n;
  return BigInt(v);
}

function summarizeBottomLineFromFields({
  startUSDC,
  startWETH,
  endUSDC,
  endWETH,
  endEquity,
  holdOnlyEnd,
  rebalancePostUSDC,
  rebalancePostWETH,
  rebalancePostValueUSD,
}) {
  const sUSDC = toBigInt(startUSDC);
  const sWETH = toBigInt(startWETH);
  const eUSDC = toBigInt(endUSDC);
  const eWETH = toBigInt(endWETH);
  const eEquity = toBigInt(endEquity);
  const hEnd = toBigInt(holdOnlyEnd);
  const pUSDC = toBigInt(rebalancePostUSDC);
  const pWETH = toBigInt(rebalancePostWETH);
  const pValue = toBigInt(rebalancePostValueUSD);

  const boughtWETH = pWETH > eWETH ? pWETH - eWETH : 0n;
  const soldWETH = eWETH > pWETH ? eWETH - pWETH : 0n;
  const usdcSpent = eUSDC > pUSDC ? eUSDC - pUSDC : 0n;
  const usdcReceived = pUSDC > eUSDC ? pUSDC - eUSDC : 0n;
  const action = boughtWETH > 0n ? "BUY" : soldWETH > 0n ? "SELL" : "NONE";

  return {
    endWETH: eWETH,
    deltaWETH: eWETH - sWETH,
    endUSDC: eUSDC,
    deltaUSDC: eUSDC - sUSDC,
    endPoolValueUSD: eEquity,
    poolVsHoldUSDC: eEquity - hEnd,
    rebalanceAction: action,
    rebalanceBoughtWETH: boughtWETH,
    rebalanceSoldWETH: soldWETH,
    rebalanceUSDCSpent: usdcSpent,
    rebalanceUSDCReceived: usdcReceived,
    postRebalanceWETH: pWETH,
    postRebalanceDeltaWETH: pWETH - sWETH,
    postRebalanceUSDC: pUSDC,
    postRebalanceDeltaUSDC: pUSDC - sUSDC,
    postRebalanceValueUSD: pValue,
    postRebalanceVsHoldUSDC: pValue - hEnd,
  };
}

function summarizeBottomLine(summary) {
  const bottomLine = summarizeBottomLineFromFields({
    startUSDC: summary.startUSDC,
    startWETH: summary.startWETH,
    endUSDC: summary.endUSDC,
    endWETH: summary.endWETH,
    endEquity: summary.endEquity,
    holdOnlyEnd: summary.holdOnlyEnd,
    rebalancePostUSDC: summary.rebalancePostUSDC,
    rebalancePostWETH: summary.rebalancePostWETH,
    rebalancePostValueUSD: summary.rebalancePostValueUSD,
  });

  bottomLine.rebalanceRemainingMissingWETH = toBigInt(summary.rebalanceRemainingMissingWETH);
  bottomLine.rebalanceFullyReachedTarget = Boolean(summary.rebalanceFullyReachedTarget);
  return bottomLine;
}

module.exports = {
  summarizeBottomLine,
  summarizeBottomLineFromFields,
};
