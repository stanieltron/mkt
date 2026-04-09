# Scenarios

These scripts model `mkt1.sol` behavior in JavaScript to explore pool outcomes without loading Foundry tests.

## How It Works

1. Pool inventory starts with WETH only (no initial USDC pool seed).
2. Price comes from the oracle (`setMockPriceE18`) and all trade logic is marked to that oracle price.
3. A long open locks fixed margin from trader (`10 USDC` in current config) and creates a leveraged notional (`margin * leverage`, currently `3000 USDC`).
4. On open, TP and SL levels are created around entry price from the chosen `profitTargetBps`.
5. Coverage check on open is `openNotional <= poolETHValueInUSDC`. This is the core risk guard.
6. Conceptually, open notional is the part of pool ETH risk that is "assigned" to active trades. Any unassigned pool ETH keeps pure directional ETH exposure.
7. Every simulation step can attempt close/liquidation on all open trades. A trade closes only when oracle price hits TP or SL.
8. Pool equity at any point is `poolUSDC + poolWETH * oraclePrice`.
9. Results are compared to hold-only baseline (`startUSDC + startWETH * endPrice`).

## Execution And Settlement Model

- Price-path generation is in `scenarios/common/price-simulator.js` (bounded step moves, no instant 10x jumps).
- Trade timing is randomized across the path; opens are not forced to be balanced TP/SL.
- Close attempts are frequent; most attempts do nothing until TP/SL is actually hit.
- Internal "sell ETH for USDC" and "buy ETH with USDC" are model bookkeeping operations at oracle price.
- There is no AMM curve, no slippage, no LP fee accrual, and no gas-cost deduction unless explicitly modeled.

## Model Differences

- `model-v1`:
  TP pays trader margin in USDC and profit in WETH.
  SL keeps trader margin in pool USDC.
- `model-v2`:
  TP pays trader fully in USDC (`margin + profit`).
  Pool uses existing USDC first and sells ETH only for any USDC shortfall.
  With zero initial USDC, that USDC buffer must be built from collected margins/losses.
  SL keeps trader margin in pool USDC.
- `model-v3`:
  TP is same as v2.
  SL converts lost margin USDC into WETH immediately (buy ETH on loss).
- `model-v4`:
  Uses v3-style settlement and adds shorts.
  Shorts are allowed only when there is open long notional to offset them.
  Net long exposure (`openLongNotional - openShortNotional`) is what consumes ETH coverage.
  This means opening short can restore long capacity by reducing net exposure.
- `model-v5`:
  Uses separate capacity pools: spot ETH pool for longs and dedicated short-hedge pool for shorts.
  Shorts do not require a previously opened long.
  Long and short notionals still offset each other through net exposure accounting.
  On short open, a 1x short-ETH hedge is opened with notional equal to short notional.
  On short close, hedge PnL is realized in USDC terms; open short hedges contribute unrealized PnL.
  Hedge PnL is included in final equity/result metrics, but ETH rebalance remains spot-only.

## Run

- `npm run scenario:v1:verbose10`
- `npm run scenario:v1:uptrend10000`
- `npm run scenario:v1:downtrend10000`
- `npm run scenario:v1:neutral10000`
- `npm run scenario:v1:average100`
- `npm run scenario:v1:average100:uptrend`
- `npm run scenario:v1:average100:downtrend`
- `npm run scenario:v1:average100:neutral`
- `npm run scenario:v1:all10000`
- `npm run scenario:v2:verbose10`
- `npm run scenario:v2:uptrend10000`
- `npm run scenario:v2:downtrend10000`
- `npm run scenario:v2:neutral10000`
- `npm run scenario:v2:average100`
- `npm run scenario:v2:average100:uptrend`
- `npm run scenario:v2:average100:downtrend`
- `npm run scenario:v2:average100:neutral`
- `npm run scenario:v2:all10000`
- `npm run scenario:v3:verbose10`
- `npm run scenario:v3:uptrend10000`
- `npm run scenario:v3:downtrend10000`
- `npm run scenario:v3:neutral10000`
- `npm run scenario:v3:average100`
- `npm run scenario:v3:average100:uptrend`
- `npm run scenario:v3:average100:downtrend`
- `npm run scenario:v3:average100:neutral`
- `npm run scenario:v3:all10000`
- `npm run scenario:v4:verbose10`
- `npm run scenario:v4:uptrend10000`
- `npm run scenario:v4:downtrend10000`
- `npm run scenario:v4:neutral10000`
- `npm run scenario:v4:average100`
- `npm run scenario:v4:average100:uptrend`
- `npm run scenario:v4:average100:downtrend`
- `npm run scenario:v4:average100:neutral`
- `npm run scenario:v4:all10000`
- `npm run scenario:v5:verbose10`
- `npm run scenario:v5:uptrend10000`
- `npm run scenario:v5:downtrend10000`
- `npm run scenario:v5:neutral10000`
- `npm run scenario:v5:average100`
- `npm run scenario:v5:average100:uptrend`
- `npm run scenario:v5:average100:downtrend`
- `npm run scenario:v5:average100:neutral`
- `npm run scenario:v5:all10000`

For average runs you can tune:
- `RUNS_PER_SCENARIO` (default `100`)
- `PARALLEL_WORKERS` (default = available CPU cores, capped by total runs)
- `--scenario=uptrend|downtrend|neutral` (or comma-separated, e.g. `--scenario=downtrend,neutral`)

## Result Files

- Every scenario run writes a JSON result file to `scenarios/results/`.
- File name is scenario-based (for example `model-v1-random-10000-downtrend.json`).
- Re-running the same scenario overwrites the same file with the latest result.
- Big integer values are stored as strings in JSON.
- Final outputs include a `Bottomline` block (and JSON `bottomLine`) with:
  - end/delta WETH
  - end/delta USDC
  - pool value vs hold
  - rebalance trade (`BUY/SELL/NONE`) and size in WETH/USDC
  - post-rebalance end/delta WETH and USDC
  - post-rebalance value vs hold

## Files

- `scenarios/common/price-simulator.js`: reusable price-path simulator.
- `scenarios/model-v1/dex-model.js`: model v1 DEX logic with Solidity-like actions.
  - Pool starts with no USDC seed in scenario setup.
- `scenarios/model-v1/scenario-core.js`: model v1 scenario logic used by the scenario entry files.
- `scenarios/model-v1/verbose-10-trades.js`: verbose 10-trade walkthrough.
- `scenarios/model-v1/random-10000-uptrend.js`: 10,000 random-timed trades in uptrend (~2x final price target).
- `scenarios/model-v1/random-10000-downtrend.js`: 10,000 random-timed trades in downtrend (~0.5x final price target).
- `scenarios/model-v1/random-10000-neutral.js`: 10,000 random-timed trades in neutral market.
- `scenarios/model-v1/random-10000-average.js`: runs `uptrend/downtrend/neutral` many times (default 100 each, 300 total), logs progress as `runs 10/300`, and prints average final metrics.
- `scenarios/model-v2/dex-model.js`: model v2 DEX logic.
  - TP: pays in USDC (`margin + profit`), sells ETH only if pool USDC is insufficient.
  - SL: trader margin stays in pool USDC.
  - Pool starts with no USDC seed in scenario setup; USDC is formed from trader margin flow.
- `scenarios/model-v2/scenario-core.js`: model v2 scenario logic used by the scenario entry files.
- `scenarios/model-v2/verbose-10-trades.js`: verbose 10-trade walkthrough.
- `scenarios/model-v2/random-10000-uptrend.js`: 10,000 random-timed trades in uptrend (~2x final price target).
- `scenarios/model-v2/random-10000-downtrend.js`: 10,000 random-timed trades in downtrend (~0.5x final price target).
- `scenarios/model-v2/random-10000-neutral.js`: 10,000 random-timed trades in neutral market.
- `scenarios/model-v2/random-10000-average.js`: runs `uptrend/downtrend/neutral` many times (default 100 each, 300 total), logs progress as `runs 10/300`, and prints average final metrics.
- `scenarios/model-v3/dex-model.js`: model v3 DEX logic.
  - TP: same as v2 (pays in USDC, sells ETH only if USDC is insufficient).
  - SL: converts margin USDC into ETH (buy ETH on loss).
  - Pool starts with no USDC seed in scenario setup.
- `scenarios/model-v3/scenario-core.js`: model v3 scenario logic used by the scenario entry files.
- `scenarios/model-v3/verbose-10-trades.js`: verbose 10-trade walkthrough.
- `scenarios/model-v3/random-10000-uptrend.js`: 10,000 random-timed trades in uptrend (~2x final price target).
- `scenarios/model-v3/random-10000-downtrend.js`: 10,000 random-timed trades in downtrend (~0.5x final price target).
- `scenarios/model-v3/random-10000-neutral.js`: 10,000 random-timed trades in neutral market.
- `scenarios/model-v3/random-10000-average.js`: runs `uptrend/downtrend/neutral` many times (default 100 each, 300 total), logs progress as `runs 10/300`, and prints average final metrics.
- `scenarios/model-v4/dex-model.js`: model v4 DEX logic.
  - Adds shorts with offset gating: short notional can open only up to currently open long notional.
  - Coverage uses net long notional.
  - Settlement matches v3-style inventory management:
    TP pays fully in USDC (`margin + profit`) and can sell WETH to raise missing USDC.
    SL converts lost margin USDC into WETH immediately.
  - Pool starts with no USDC seed in scenario setup.
- `scenarios/model-v4/scenario-core.js`: model v4 scenario logic used by the scenario entry files.
- `scenarios/model-v4/verbose-10-trades.js`: verbose 10-trade walkthrough with long+short behavior.
- `scenarios/model-v4/random-10000-uptrend.js`: 10,000 random-timed trades in uptrend.
- `scenarios/model-v4/random-10000-downtrend.js`: 10,000 random-timed trades in downtrend.
- `scenarios/model-v4/random-10000-neutral.js`: 10,000 random-timed trades in neutral market.
- `scenarios/model-v4/random-10000-average.js`: runs `uptrend/downtrend/neutral` many times (default 100 each, 300 total), logs progress as `runs 10/300`, and prints average final metrics.
- `scenarios/model-v5/dex-model.js`: model v5 DEX logic.
  - Independent long pool and short-hedge pool capacity checks.
  - Shorts can open without prior longs.
  - Long and short open notional still offset through net exposure.
  - Adds virtual hedge leg for every short (`notional` sized short-ETH exposure).
  - Hedge realized/unrealized PnL is counted in final pool value metrics.
- `scenarios/model-v5/scenario-core.js`: model v5 scenario logic used by the scenario entry files.
- `scenarios/model-v5/verbose-10-trades.js`: verbose 10-trade walkthrough with short hedge accounting.
- `scenarios/model-v5/random-10000-uptrend.js`: 10,000 random-timed trades in uptrend.
- `scenarios/model-v5/random-10000-downtrend.js`: 10,000 random-timed trades in downtrend.
- `scenarios/model-v5/random-10000-neutral.js`: 10,000 random-timed trades in neutral market.
- `scenarios/model-v5/random-10000-average.js`: runs `uptrend/downtrend/neutral` many times (default 100 each, 300 total), logs progress as `runs 10/300`, and prints average final metrics.

Final outputs also include an end-of-run rebalance block:
- Rebalance target is the starting ETH amount.
- If end ETH is below target, USDC is used to buy ETH at end price.
- If USDC is insufficient, all USDC is spent and remaining ETH shortfall is reported.
