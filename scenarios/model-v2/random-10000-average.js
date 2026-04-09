"use strict";

const os = require("os");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { simulateRandom10000TrendModelV2 } = require("./scenario-core");
const { fmtUSDC6, fmtWETH18, fmtPriceE18 } = require("./dex-model");
const { writeScenarioResult } = require("../common/result-writer");
const { summarizeBottomLineFromFields } = require("../common/bottomline");

const SCENARIOS = [
  { key: "uptrend", label: "Uptrend (target ~2x)" },
  { key: "downtrend", label: "Downtrend (target ~0.5x)" },
  { key: "neutral", label: "Neutral" },
];

function readRunsPerScenario() {
  const raw = process.env.RUNS_PER_SCENARIO ?? "100";
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error("RUNS_PER_SCENARIO must be a positive integer");
  return n;
}

function readSelectedScenarios() {
  const arg = process.argv.find((v) => v.startsWith("--scenario="));
  const argValue = arg ? arg.split("=")[1] : undefined;
  const raw = argValue ?? process.env.SCENARIO ?? process.env.SCENARIOS;
  if (!raw) return SCENARIOS;

  const wanted = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (wanted.length === 0) throw new Error("scenario filter is empty");

  const byKey = new Map(SCENARIOS.map((s) => [s.key, s]));
  const selected = [];
  for (const key of wanted) {
    const scenario = byKey.get(key);
    if (!scenario) {
      throw new Error(`unknown scenario '${key}'. allowed: ${Array.from(byKey.keys()).join(", ")}`);
    }
    if (!selected.find((s) => s.key === key)) selected.push(scenario);
  }
  return selected;
}

function readWorkerCount(totalRuns) {
  const defaultWorkers =
    typeof os.availableParallelism === "function" ? os.availableParallelism() : (os.cpus()?.length ?? 1);
  const raw = process.env.PARALLEL_WORKERS ?? process.env.MAX_WORKERS;
  if (raw === undefined) return Math.max(1, Math.min(defaultWorkers, totalRuns));

  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error("PARALLEL_WORKERS must be a positive integer");
  return Math.max(1, Math.min(n, totalRuns));
}

function avgBigInt(sum, count) {
  return sum / BigInt(count);
}

function fmtNum(value, digits = 2) {
  return Number(value).toFixed(digits);
}

function createAccumulator() {
  return {
    runs: 0,
    openedLongs: 0,
    openFailInsufficientLiquidity: 0,
    openFailOther: 0,
    closeAttempts: 0,
    closeSuccess: 0,
    longTradePnl: 0n,
    poolTradePnl: 0n,
    maxUtilizationBps: 0n,
    startUSDC: 0n,
    endUSDC: 0n,
    startWETH: 0n,
    endWETH: 0n,
    startPrice: 0n,
    endPrice: 0n,
    startEquity: 0n,
    endEquity: 0n,
    holdOnlyEnd: 0n,
    rebalanceTargetWETH: 0n,
    rebalanceNeededWETH: 0n,
    rebalanceUSDCSpent: 0n,
    rebalanceBoughtWETH: 0n,
    rebalancePostWETH: 0n,
    rebalancePostUSDC: 0n,
    rebalanceRemainingMissingWETH: 0n,
    rebalancePostValueUSD: 0n,
    rebalanceFullyReachedTargetRuns: 0,
  };
}

function addSummary(acc, summary) {
  acc.runs += 1;
  acc.openedLongs += summary.openedLongs;
  acc.openFailInsufficientLiquidity += summary.openFailInsufficientLiquidity;
  acc.openFailOther += summary.openFailOther;
  acc.closeAttempts += summary.closeAttempts;
  acc.closeSuccess += summary.closeSuccess;
  acc.longTradePnl += summary.longTradePnl;
  acc.poolTradePnl += summary.poolTradePnl;
  acc.maxUtilizationBps += summary.maxUtilizationBps;
  acc.startUSDC += summary.startUSDC;
  acc.endUSDC += summary.endUSDC;
  acc.startWETH += summary.startWETH;
  acc.endWETH += summary.endWETH;
  acc.startPrice += summary.startPrice;
  acc.endPrice += summary.endPrice;
  acc.startEquity += summary.startEquity;
  acc.endEquity += summary.endEquity;
  acc.holdOnlyEnd += summary.holdOnlyEnd;
  acc.rebalanceTargetWETH += summary.rebalanceTargetWETH;
  acc.rebalanceNeededWETH += summary.rebalanceNeededWETH;
  acc.rebalanceUSDCSpent += summary.rebalanceUSDCSpent;
  acc.rebalanceBoughtWETH += summary.rebalanceBoughtWETH;
  acc.rebalancePostWETH += summary.rebalancePostWETH;
  acc.rebalancePostUSDC += summary.rebalancePostUSDC;
  acc.rebalanceRemainingMissingWETH += summary.rebalanceRemainingMissingWETH;
  acc.rebalancePostValueUSD += summary.rebalancePostValueUSD;
  if (summary.rebalanceFullyReachedTarget) acc.rebalanceFullyReachedTargetRuns += 1;
}

function printAverageReport(label, acc) {
  const runs = acc.runs;
  const avgOpenedLongs = acc.openedLongs / runs;
  const avgOpenFailInsufficientLiquidity = acc.openFailInsufficientLiquidity / runs;
  const avgOpenFailOther = acc.openFailOther / runs;
  const avgCloseAttempts = acc.closeAttempts / runs;
  const avgCloseSuccess = acc.closeSuccess / runs;

  const avgLongTradePnl = avgBigInt(acc.longTradePnl, runs);
  const avgPoolTradePnl = avgBigInt(acc.poolTradePnl, runs);
  const avgMaxUtilizationBps = avgBigInt(acc.maxUtilizationBps, runs);

  const avgStartUSDC = avgBigInt(acc.startUSDC, runs);
  const avgEndUSDC = avgBigInt(acc.endUSDC, runs);
  const avgStartWETH = avgBigInt(acc.startWETH, runs);
  const avgEndWETH = avgBigInt(acc.endWETH, runs);
  const avgStartPrice = avgBigInt(acc.startPrice, runs);
  const avgEndPrice = avgBigInt(acc.endPrice, runs);
  const avgStartEquity = avgBigInt(acc.startEquity, runs);
  const avgEndEquity = avgBigInt(acc.endEquity, runs);
  const avgHoldOnlyEnd = avgBigInt(acc.holdOnlyEnd, runs);
  const avgRebalanceTargetWETH = avgBigInt(acc.rebalanceTargetWETH, runs);
  const avgRebalanceNeededWETH = avgBigInt(acc.rebalanceNeededWETH, runs);
  const avgRebalanceUSDCSpent = avgBigInt(acc.rebalanceUSDCSpent, runs);
  const avgRebalanceBoughtWETH = avgBigInt(acc.rebalanceBoughtWETH, runs);
  const avgRebalancePostWETH = avgBigInt(acc.rebalancePostWETH, runs);
  const avgRebalancePostUSDC = avgBigInt(acc.rebalancePostUSDC, runs);
  const avgRebalanceRemainingMissingWETH = avgBigInt(acc.rebalanceRemainingMissingWETH, runs);
  const avgRebalancePostValueUSD = avgBigInt(acc.rebalancePostValueUSD, runs);
  const rebalanceSuccessRate = (acc.rebalanceFullyReachedTargetRuns * 100) / runs;
  const bottomLine = summarizeBottomLineFromFields({
    startUSDC: avgStartUSDC,
    startWETH: avgStartWETH,
    endUSDC: avgEndUSDC,
    endWETH: avgEndWETH,
    endEquity: avgEndEquity,
    holdOnlyEnd: avgHoldOnlyEnd,
    rebalancePostUSDC: avgRebalancePostUSDC,
    rebalancePostWETH: avgRebalancePostWETH,
    rebalancePostValueUSD: avgRebalancePostValueUSD,
  });

  console.log("==================================================");
  console.log(`Average Results: ${label}`);
  console.log(`runs:                              ${runs}`);
  console.log(`avgLongsOpened:                    ${fmtNum(avgOpenedLongs, 2)}`);
  console.log(`avgOpenFailInsufficientLiquidity:  ${fmtNum(avgOpenFailInsufficientLiquidity, 2)}`);
  console.log(`avgOpenFailOther:                  ${fmtNum(avgOpenFailOther, 2)}`);
  console.log(`avgCloseAttempts:                  ${fmtNum(avgCloseAttempts, 2)}`);
  console.log(`avgCloseSuccess:                   ${fmtNum(avgCloseSuccess, 2)}`);
  console.log(`avgLongsRealizedPnL:               ${fmtUSDC6(avgLongTradePnl)} USDC`);
  console.log(`avgPoolRealizedTradePnL:           ${fmtUSDC6(avgPoolTradePnl)} USDC`);
  console.log(`avgMaxPoolUtilization:             ${(Number(avgMaxUtilizationBps) / 100).toFixed(2)}%`);
  console.log("");
  console.log("Assets (averages)");
  console.log(`avgStartUSDC:                      ${fmtUSDC6(avgStartUSDC)} USDC`);
  console.log(`avgEndUSDC:                        ${fmtUSDC6(avgEndUSDC)} USDC`);
  console.log(`avgDeltaUSDC:                      ${fmtUSDC6(avgEndUSDC - avgStartUSDC)} USDC`);
  console.log(`avgStartWETH:                      ${fmtWETH18(avgStartWETH)} WETH`);
  console.log(`avgEndWETH:                        ${fmtWETH18(avgEndWETH)} WETH`);
  console.log(`avgDeltaWETH:                      ${fmtWETH18(avgEndWETH - avgStartWETH)} WETH`);
  console.log("");
  console.log("USD Value (averages)");
  console.log(`avgStartPrice:                     ${fmtPriceE18(avgStartPrice)} USDC/ETH`);
  console.log(`avgEndPrice:                       ${fmtPriceE18(avgEndPrice)} USDC/ETH`);
  console.log(`avgStartPoolValueUSD:              ${fmtUSDC6(avgStartEquity)} USDC`);
  console.log(`avgEndPoolValueUSD:                ${fmtUSDC6(avgEndEquity)} USDC`);
  console.log(`avgPoolTotalPnL:                   ${fmtUSDC6(avgEndEquity - avgStartEquity)} USDC`);
  console.log(`avgHoldOnlyEndValueUSD:            ${fmtUSDC6(avgHoldOnlyEnd)} USDC`);
  console.log(`avgPoolVsHold:                     ${fmtUSDC6(avgEndEquity - avgHoldOnlyEnd)} USDC`);
  console.log("");
  console.log("End Rebalance To Start ETH (averages)");
  console.log(`avgRebalanceTargetWETH:            ${fmtWETH18(avgRebalanceTargetWETH)} WETH`);
  console.log(`avgRebalanceNeededWETH:            ${fmtWETH18(avgRebalanceNeededWETH)} WETH`);
  console.log(`avgRebalanceUSDCSpent:             ${fmtUSDC6(avgRebalanceUSDCSpent)} USDC`);
  console.log(`avgRebalanceBoughtWETH:            ${fmtWETH18(avgRebalanceBoughtWETH)} WETH`);
  console.log(`avgRebalancePostWETH:              ${fmtWETH18(avgRebalancePostWETH)} WETH`);
  console.log(`avgRebalancePostUSDC:              ${fmtUSDC6(avgRebalancePostUSDC)} USDC`);
  console.log(`avgRebalanceRemainingMissingWETH:  ${fmtWETH18(avgRebalanceRemainingMissingWETH)} WETH`);
  console.log(`rebalanceSuccessRate:              ${rebalanceSuccessRate.toFixed(2)}%`);
  console.log(`avgRebalancePostPoolValueUSD:      ${fmtUSDC6(avgRebalancePostValueUSD)} USDC`);
  console.log("");
  console.log("Bottomline (averages)");
  console.log(`endWETH / deltaWETH:               ${fmtWETH18(bottomLine.endWETH)} / ${fmtWETH18(bottomLine.deltaWETH)} WETH`);
  console.log(`endUSDC / deltaUSDC:               ${fmtUSDC6(bottomLine.endUSDC)} / ${fmtUSDC6(bottomLine.deltaUSDC)} USDC`);
  console.log(`valueUSDPlusETHVsHold:             ${fmtUSDC6(bottomLine.poolVsHoldUSDC)} USDC`);
  console.log(
    `rebalanceTrade:                    ${bottomLine.rebalanceAction} ${fmtWETH18(bottomLine.rebalanceBoughtWETH)} bought, ${fmtWETH18(
      bottomLine.rebalanceSoldWETH
    )} sold for ${fmtUSDC6(bottomLine.rebalanceUSDCSpent)} spent, ${fmtUSDC6(bottomLine.rebalanceUSDCReceived)} received USDC`
  );
  console.log(
    `postRebalanceWETH / deltaWETH:     ${fmtWETH18(bottomLine.postRebalanceWETH)} / ${fmtWETH18(bottomLine.postRebalanceDeltaWETH)} WETH`
  );
  console.log(
    `postRebalanceUSDC / deltaUSDC:     ${fmtUSDC6(bottomLine.postRebalanceUSDC)} / ${fmtUSDC6(bottomLine.postRebalanceDeltaUSDC)} USDC`
  );
  console.log(`postRebalanceValueVsHold:          ${fmtUSDC6(bottomLine.postRebalanceVsHoldUSDC)} USDC`);
  console.log("==================================================");

  return {
    runs,
    avgOpenedLongs,
    avgOpenFailInsufficientLiquidity,
    avgOpenFailOther,
    avgCloseAttempts,
    avgCloseSuccess,
    avgLongTradePnl,
    avgPoolTradePnl,
    avgMaxUtilizationBps,
    avgStartUSDC,
    avgEndUSDC,
    avgStartWETH,
    avgEndWETH,
    avgStartPrice,
    avgEndPrice,
    avgStartEquity,
    avgEndEquity,
    avgHoldOnlyEnd,
    avgRebalanceTargetWETH,
    avgRebalanceNeededWETH,
    avgRebalanceUSDCSpent,
    avgRebalanceBoughtWETH,
    avgRebalancePostWETH,
    avgRebalancePostUSDC,
    avgRebalanceRemainingMissingWETH,
    avgRebalancePostValueUSD,
    rebalanceSuccessRate,
    bottomLine,
  };
}

function buildTasks(runsPerScenario, scenarios) {
  const tasks = [];
  for (const scenario of scenarios) {
    for (let i = 1; i <= runsPerScenario; i++) {
      tasks.push({
        scenarioKey: scenario.key,
        priceSeed: `avg-${scenario.key}-price-${i}`,
        tradeSeed: `avg-${scenario.key}-trades-${i}`,
      });
    }
  }
  return tasks;
}

function runTaskInWorker(task) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { task } });
    let settled = false;

    worker.once("message", (message) => {
      settled = true;
      resolve(message);
    });

    worker.once("error", (err) => {
      settled = true;
      reject(err);
    });

    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        reject(new Error(`Worker stopped with exit code ${code}`));
      }
    });
  });
}

async function runTaskPool(tasks, workerCount, onComplete) {
  return new Promise((resolve, reject) => {
    let next = 0;
    let active = 0;
    let done = 0;
    let failed = false;

    function launch() {
      if (failed) return;
      while (active < workerCount && next < tasks.length) {
        const task = tasks[next++];
        active++;

        runTaskInWorker(task)
          .then((result) => {
            if (failed) return;
            active--;
            done++;
            onComplete(result, done);

            if (done === tasks.length) resolve();
            else launch();
          })
          .catch((err) => {
            failed = true;
            reject(err);
          });
      }
    }

    launch();
  });
}

async function runMain() {
  const runsPerScenario = readRunsPerScenario();
  const selectedScenarios = readSelectedScenarios();
  const tasks = buildTasks(runsPerScenario, selectedScenarios);
  const totalRuns = tasks.length;
  const workerCount = readWorkerCount(totalRuns);

  const averages = new Map();
  for (const scenario of selectedScenarios) averages.set(scenario.key, createAccumulator());

  console.log(
    `Running average simulation: ${runsPerScenario} runs/scenario, total ${totalRuns} runs, workers ${workerCount}`
  );

  await runTaskPool(tasks, workerCount, ({ scenarioKey, summary }, completed) => {
    const acc = averages.get(scenarioKey);
    addSummary(acc, summary);
    if (completed % 10 === 0 || completed === totalRuns) {
      console.log(`runs ${completed}/${totalRuns}`);
    }
  });

  for (const scenario of selectedScenarios) {
    const acc = averages.get(scenario.key);
    const averagesSummary = printAverageReport(scenario.label, acc);
    const resultPath = writeScenarioResult({
      scenarioName: `model-v2-average-100-${scenario.key}`,
      payload: {
        model: "v2",
        scenarioType: "average100",
        scenarioKey: scenario.key,
        scenarioLabel: scenario.label,
        runsPerScenario,
        averages: averagesSummary,
      },
    });
    console.log(`Result file: ${resultPath}`);
  }
}

function runWorker() {
  const { task } = workerData;
  const { summary } = simulateRandom10000TrendModelV2({
    regime: task.scenarioKey,
    priceSeed: task.priceSeed,
    tradeSeed: task.tradeSeed,
  });
  parentPort.postMessage({
    scenarioKey: task.scenarioKey,
    summary,
  });
}

if (isMainThread) {
  runMain().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exitCode = 1;
  });
} else {
  runWorker();
}
