# Solidity V4 Workspace

This workspace contains the `v4` Makeit protocol contracts and their Foundry tests.

## What Makeit Does

Makeit is a pool-backed leveraged trading protocol around a `WETH` / `USDC` inventory.

At a high level:

- traders pay a fixed gross `USDC` margin from their wallet
- a configurable fee is withheld from that gross margin
- the remaining net margin is the actual trade margin
- `v4` supports both long and short trades
- long capacity is limited by how much `WETH` value the pool can support
- short capacity is limited by already-open long notional
- the pool settles trades in `USDC`, using `WETH` inventory when needed
- traders can manually close early before TP or SL is hit
- anyone can liquidate after TP or SL is hit

`v4` is upgradeable through a UUPS proxy.

## How V4 Differs From V3

- `v4` supports both longs and shorts
- `v3` is long-only
- `v4` uses direct `profitTargetBps` distance around entry price
- `v3` uses `profitTargetPct` together with leverage to derive TP/SL distance
- `v4` enforces ETH coverage on net long exposure only
- `v4` requires short notional to be offset by existing long notional
- `v4` tracks separate long and short notional and margin buckets
- both versions use the same inventory settlement pattern and both support trader-only early close before TP/SL

## Workspace Layout

- `src/`: protocol contracts
- `src/interfaces/`: external interfaces
- `src/libraries/`: shared math helpers
- `test/`: Foundry tests

## Build

From repo root:

- `npm run build:solidity:v4`

Direct Forge:

- `node scripts/forge.js build --root solidity_v4`

## Main Contracts

- `Makeit.sol`: main trading protocol
- `MakeitProxy.sol`: ERC-1967 proxy wrapper used for UUPS deployments
- `UniswapV3PoolOracleV3.sol`: oracle that reads the `WETH` / `USDC` price from a Uniswap v3 pool
- `UniswapV3SwapAdapterV3.sol`: swap adapter used by `Makeit` to buy or sell `WETH` against `USDC`

Public state variables also expose auto-generated getters. The function list below covers explicit contract functions.

## Function Reference

### `MakeitProxy`

- `constructor(address implementation, bytes data)`
  Deploys an ERC-1967 proxy pointing at `implementation` and optionally executes `data` as initialization calldata.

### `Makeit`

- `receive()`
  Accepts native ETH. This is mainly needed when `WETH` is unwrapped during owner withdrawals.

- `initialize(address usdc, address weth, address initialOwner)`
  Initializes the upgradeable contract. Sets token addresses, owner, default margin, default fee, default leverage, and the first trade ID.

- `setOracle(address newOracle)`
  Owner-only. Sets the oracle contract used to read the live price.

- `setExternalDex(address newExternalDex)`
  Owner-only. Sets the swap adapter used for settlement and rebalancing, and refreshes token approvals to that adapter.

- `setProduct(uint96 newMarginUSDC, uint32 newLeverage)`
  Owner-only. Updates the fixed gross margin per trade and the maximum allowed leverage.

- `setFeeBps(uint16 newFeeBps)`
  Owner-only. Updates the fee charged on gross margin. `100` means `1%`.

- `setTradingFrozen(bool frozen)`
  Owner-only. Enables or disables new trade creation.

- `fundETH(uint256 wethAmount18)`
  Transfers `WETH` from the caller into the pool.

- `fundStable(uint256 usdcAmount6)`
  Transfers `USDC` from the caller into the pool.

- `getOraclePriceE18()`
  Returns the current oracle price, scaled to `1e18`.

- `getTrade(uint256 tradeId)`
  Returns the stored trade struct for a trade ID.

- `openTrade(uint256 expectedPriceE18, uint256 toleranceBps, uint16 profitTargetBps, uint32 tradeLeverage)`
  Opens a long trade. This is the backward-compatible alias for `openLongTrade`.

- `openLongTrade(uint256 expectedPriceE18, uint256 toleranceBps, uint16 profitTargetBps, uint32 tradeLeverage)`
  Opens a new long trade if price tolerance, leverage, fee-adjusted margin, and net-long ETH coverage checks all pass.

- `openShortTrade(uint256 expectedPriceE18, uint256 toleranceBps, uint16 profitTargetBps, uint32 tradeLeverage)`
  Opens a new short trade if price tolerance, leverage, fee-adjusted margin, and long-notional offset checks all pass.

- `close(uint256 tradeId)`
  Trader-only early close. Allowed only while price is still between TP and SL. Realized PnL is computed from the current oracle price and capped to `+/- margin`.

- `liquidateTrade(uint256 tradeId)`
  Closes an open trade after TP or SL is hit. Callable by anyone.

- `liquidate(uint256 tradeId)`
  Thin alias for `liquidateTrade`.

- `ownerWithdrawUSDC(uint256 usdcAmount6, address to)`
  Owner-only. Withdraws pool `USDC` when there are no open trades.

- `ownerWithdrawETH(uint256 wethAmount18, address payable to)`
  Owner-only. Withdraws pool `WETH` as native ETH when there are no open trades.

- `rebalanceTopUpToTargetWETH(uint256 targetWETH18)`
  Owner-only. Uses available `USDC` to buy enough `WETH` to reach a target inventory level.

### `UniswapV3PoolOracleV3`

- `constructor(address initialPool, address usdc, address weth, address initialOwner)`
  Validates the token pair and decimals, stores token configuration, sets ownership, and installs the first Uniswap pool.

- `setPool(address newPool)`
  Owner-only. Changes the Uniswap pool that the oracle reads from.

- `getPriceE18()`
  Reads the pool `slot0` price and converts it into `USDC per 1 WETH`, scaled to `1e18`.

### `UniswapV3SwapAdapterV3`

- `constructor(address usdc, address weth, address initialPool, address router, address oracle, uint16 initialMaxSlippageBps, address initialOwner)`
  Sets token addresses, initial pool, router, oracle, owner, and max slippage.

- `setPool(address newPool)`
  Owner-only. Points the adapter at a different Uniswap pool and refreshes the fee tier.

- `setSwapRouter(address newRouter)`
  Owner-only. Changes the swap router and refreshes token approvals.

- `setOracle(address oracle)`
  Owner-only. Changes the oracle used for quoting and slippage bounds.

- `setMaxSlippageBps(uint16 newMaxSlippageBps)`
  Owner-only. Updates the slippage ceiling used for swap bounds.

- `sellWETHForExactUSDC(uint256 usdcNeeded6, address payer, address recipient)`
  Pulls up to a bounded amount of `WETH` from `payer`, executes an exact-output swap, sends exact `USDC` to `recipient`, and refunds unused `WETH`.

- `buyWETHWithExactUSDC(uint256 usdcIn6, address payer, address recipient)`
  Pulls exact `USDC` from `payer`, executes an exact-input swap, and sends received `WETH` to `recipient`.
