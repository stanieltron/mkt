# Solidity Local Deploy V4 Workspace

This workspace contains the contracts used by the local `v4` deployment flow.

Unlike `solidity_local_deploy_v3`, this folder includes both local infrastructure contracts and copied `v4` protocol contracts so the local deploy script can build a full local stack from one workspace.

## Role In The Repo

This folder is used for local Anvil deployment with:

- mintable mock tokens
- a wrapped-ETH mock
- a router compatibility shim for the local Uniswap setup
- copied protocol contracts

The canonical source for the protocol remains `solidity`. The copied protocol contracts here expose the same API.

## How It Differs From The Other Solidity Workspaces

- compared with `solidity`: same protocol behavior, but includes local-only deployment helpers and mocks
- compared with `solidity_local_deploy_v3`: includes the actual protocol contracts in addition to local deployment infrastructure

## Included Contracts

- local-only contracts:
  - `MockERC20.sol`
  - `MockWETH.sol`
  - `SwapRouterCompat.sol`
- copied protocol contracts:
  - `Makeit.sol`
  - `MakeitProxy.sol` via the main `solidity_v4` workspace
  - `UniswapV3PoolOracleV3.sol`
  - `UniswapV3SwapAdapterV3.sol`

## Build

From repo root:

- `npm run build:solidity:local:v4`

## Local Deployment

From repo root:

- `npm run deploy:local:v4`

## Protocol Behavior

The copied `Makeit.sol` in this folder behaves the same as `solidity_v4`:

- supports long and short trades
- short capacity is gated by existing long notional
- ETH coverage is enforced on net long exposure
- settlement uses the inventory model where the pool can sell `WETH` to raise missing `USDC` and buy `WETH` with lost `USDC`
- traders can manually close early before TP or SL is hit

## Function Reference

### Local-only contracts

#### `MockERC20`

- `constructor(string tokenName, string tokenSymbol, uint8 tokenDecimals)`
  Creates a mintable mock ERC-20 token with custom metadata.

- `transfer(address to, uint256 amount)`
  Transfers tokens from the caller to `to`.

- `approve(address spender, uint256 amount)`
  Sets allowance for `spender`.

- `transferFrom(address from, address to, uint256 amount)`
  Transfers tokens using allowance.

- `mint(address to, uint256 amount)`
  Mints tokens to `to`.

- `burn(address from, uint256 amount)`
  Burns tokens from `from`.

#### `MockWETH`

- `receive()`
  Wraps received native ETH into mock `WETH`.

- `deposit()`
  Wraps native ETH sent with the call into mock `WETH`.

- `mint(address to, uint256 amount)`
  Mints wrapped ETH to `to`, requiring `msg.value == amount`.

- `withdraw(uint256 amount)`
  Burns wrapped ETH and sends native ETH back to the caller.

#### `SwapRouterCompat`

- `constructor(address routerAddress)`
  Stores the address of the canonical Uniswap-style router that this wrapper will call.

- `exactInputSingle(ExactInputSingleParams params)`
  Pulls input tokens from the caller, approves the real router if needed, and forwards an exact-input single-hop swap.

- `exactOutputSingle(ExactOutputSingleParams params)`
  Pulls up to `amountInMaximum` from the caller, forwards an exact-output single-hop swap, and refunds any unused input amount.

### Copied protocol contracts

These contracts expose the same functions documented in `solidity_v4/README.md`.

#### `Makeit`

- `receive()`
- `initialize(address usdc, address weth, address initialOwner)`
- `setOracle(address newOracle)`
- `setExternalDex(address newExternalDex)`
- `setProduct(uint96 newMarginUSDC, uint32 newLeverage)`
- `setFeeBps(uint16 newFeeBps)`
- `setTradingFrozen(bool frozen)`
- `fundETH(uint256 wethAmount18)`
- `fundStable(uint256 usdcAmount6)`
- `getOraclePriceE18()`
- `getTrade(uint256 tradeId)`
- `openTrade(uint256 expectedPriceE18, uint256 toleranceBps, uint16 profitTargetBps, uint32 tradeLeverage)`
- `openLongTrade(uint256 expectedPriceE18, uint256 toleranceBps, uint16 profitTargetBps, uint32 tradeLeverage)`
- `openShortTrade(uint256 expectedPriceE18, uint256 toleranceBps, uint16 profitTargetBps, uint32 tradeLeverage)`
- `close(uint256 tradeId)`
- `liquidateTrade(uint256 tradeId)`
- `liquidate(uint256 tradeId)`
- `ownerWithdrawUSDC(uint256 usdcAmount6, address to)`
- `ownerWithdrawETH(uint256 wethAmount18, address payable to)`
- `rebalanceTopUpToTargetWETH(uint256 targetWETH18)`

#### `UniswapV3PoolOracleV3`

- `constructor(address initialPool, address usdc, address weth, address initialOwner)`
- `setPool(address newPool)`
- `getPriceE18()`

#### `UniswapV3SwapAdapterV3`

- `constructor(address usdc, address weth, address initialPool, address router, address oracle, uint16 initialMaxSlippageBps, address initialOwner)`
- `setPool(address newPool)`
- `setSwapRouter(address newRouter)`
- `setOracle(address oracle)`
- `setMaxSlippageBps(uint16 newMaxSlippageBps)`
- `sellWETHForExactUSDC(uint256 usdcNeeded6, address payer, address recipient)`
- `buyWETHWithExactUSDC(uint256 usdcIn6, address payer, address recipient)`
