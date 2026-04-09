# Solidity Testing Implementation Plan

## Goal

Build a practical Solidity test suite for this repo that:

- covers `Makeit` v3 and v4 contract behavior first
- validates upgradeable deployment assumptions
- tests protocol-critical math, permissions, state transitions, and economic flows
- adds integration coverage for oracle and swap adapter behavior
- fits the current Foundry-based setup already present in the Solidity workspaces

This plan is written to be executed later step by step.

## Current State

- There are no existing Foundry test files in:
  - `solidity_v3/test`
  - `solidity_v4/test`
  - `solidity_local_deploy_v3/test`
  - `solidity_local_deploy_v4/test`
- Main protocol contracts:
  - `solidity_v3/src/Makeit.sol`
  - `solidity_v4/src/Makeit.sol`
- Upgradeable deployment path exists:
  - `solidity_v3/src/MakeitProxy.sol`
  - `solidity_v4/src/MakeitProxy.sol`
  - `scripts/deploy-local.js`
- Local mock assets and local-only helpers exist in:
  - `solidity_local_deploy_v3/src`
  - `solidity_local_deploy_v4/src`

## Testing Strategy

Testing should be added in this order:

1. v3 unit tests
2. v4 unit tests
3. upgradeability tests
4. oracle and swap adapter integration tests
5. invariants and fuzzing
6. local deployment smoke tests

The reason for this order is simple:

- `Makeit` is the highest-risk code
- v3 and v4 are the core business logic
- upgradeability is now structural risk
- integration and invariant tests are more valuable after deterministic unit coverage exists

## Test Workspace Layout

Create these directories:

- `solidity_v3/test`
- `solidity_v4/test`
- `solidity_local_deploy_v4/test`

Recommended structure:

- `solidity_v3/test/helpers`
- `solidity_v4/test/helpers`
- `solidity_local_deploy_v4/test/helpers`

Recommended file layout:

- `Makeit.Init.t.sol`
- `Makeit.OpenTrade.t.sol`
- `Makeit.CloseTrade.t.sol`
- `Makeit.Liquidation.t.sol`
- `Makeit.Admin.t.sol`
- `Makeit.Fee.t.sol`
- `Makeit.Upgrade.t.sol`
- `Makeit.Invariant.t.sol`
- `Oracle.t.sol`
- `SwapAdapter.t.sol`
- `DeployLocalSmoke.t.sol` or script-level smoke harness if needed

## Shared Testing Helpers

Implement shared helpers early to avoid duplicated setup:

- mock user addresses
- default product config
- default pool/oracle wiring
- helper to deploy implementation + proxy + initialize
- helper to fund contract with WETH and USDC
- helper to open trades under deterministic price conditions
- helper assertions for balances, events, and trade structs

Recommended helper contracts:

- `BaseMakeitTest.sol`
- `BaseMakeitV4Test.sol`
- `MockOracle.sol`
- `MockSwapAdapter.sol`

Notes:

- For protocol unit tests, prefer lightweight mocks over real Uniswap machinery.
- Use real local Uniswap stack only in dedicated integration tests.

## Phase 1: Foundation

### Deliverables

- test directories created
- base helper contracts created
- mock oracle created
- mock swap adapter created
- proxy deployment helper created

### Required behavior

- deploy v3 through proxy and initialize
- deploy v4 through proxy and initialize
- expose deterministic price control for tests
- allow configurable adapter return values when needed

### Validation

- `forge test --root solidity_v3`
- `forge test --root solidity_v4`

## Phase 2: v3 Unit Tests

### Priority areas

- initialization
- owner permissions
- funding
- open trade
- manual early close
- TP liquidation
- SL liquidation
- fee behavior
- fee setter behavior
- product config behavior
- no-double-close behavior

### Specific cases

#### Initialization

- cannot call `initialize` twice
- zero-address params revert
- default values are set correctly:
  - `marginUSDC`
  - `feeBps`
  - `leverage`
  - `nextTradeId`
  - owner

#### Admin and permissions

- only owner can:
  - `setOracle`
  - `setExternalDex`
  - `setProduct`
  - `setFeeBps`
  - `setTradingFrozen`
  - `ownerWithdrawUSDC`
  - `ownerWithdrawETH`
  - upgrades
- non-owner calls revert
- owner withdrawal blocked when open trades exist

#### Open trade

- opens successfully with valid parameters
- reverts on:
  - frozen trading
  - invalid expected price
  - invalid tolerance
  - invalid leverage
  - invalid profit target
  - insufficient ETH coverage
- check on success:
  - trade struct values
  - `nextTradeId`
  - `openNotionalUSDC`
  - `openMarginUSDC`
  - emitted `TradeOpened`

#### Fee behavior

- default fee is `100` bps
- `marginUSDC` charged from trader is gross margin
- stored `trade.marginUSDC` is net margin
- `notionalUSDC` uses net margin, not gross margin
- changing `feeBps` changes future trades only
- invalid fee above `10000` reverts
- edge case: margin fully eaten by fee reverts

#### Early close

- only trader can early close
- early close before TP/SL succeeds
- early close after TP/SL reverts with `MustUseLiquidation`
- realized PnL is calculated from actual price
- realized PnL is capped correctly
- payout and pool inventory changes are correct
- emitted `TradeClosed` fields are correct

#### Liquidation

- liquidation only works after TP or SL hit
- anyone can liquidate
- TP gives positive capped profit target payout
- SL uses negative target profit amount
- state transitions are correct
- cannot liquidate already closed trade

## Phase 3: v4 Unit Tests

### Priority areas

- all v3-equivalent behavior where applicable
- long vs short opening rules
- net exposure accounting
- short offset rule
- short early close math
- short liquidation behavior

### Specific cases

#### Opening longs

- same categories as v3
- verify:
  - `openLongNotionalUSDC`
  - `openLongMarginUSDC`
  - `openNotionalUSDC`
  - `openMarginUSDC`

#### Opening shorts

- short open succeeds only when enough long notional exists
- short open reverts with `NoLongNotionalToOffsetShort` if not enough long notional
- short open updates:
  - `openShortNotionalUSDC`
  - `openShortMarginUSDC`
  - `openNotionalUSDC` netting logic

#### Short close and liquidation

- early close by trader before TP/SL works for short
- short TP and SL are directionally correct
- short realized PnL sign is correct
- short liquidation can be called by anyone after TP/SL
- net exposure counters decrement correctly

#### Fee behavior

- same fee tests as v3
- verify fee affects both long and short notional consistently

## Phase 4: Upgradeability Tests

This is mandatory because the contracts were moved to UUPS.

### Scope

- initializer lock
- proxy state correctness
- upgrade auth
- storage preservation across upgrade

### Recommended approach

Create test-only V2 implementations:

- `MakeitHarnessV2.sol`
- `MakeitV4HarnessV2.sol`

These should:

- inherit the current contract
- add one new storage field
- add one simple getter/setter

### Specific tests

- implementation contract cannot be initialized directly after constructor disable
- proxy initializes once
- only owner can upgrade
- upgrade keeps:
  - owner
  - oracle
  - externalDex
  - margin
  - fee
  - leverage
  - nextTradeId
  - open exposures
  - existing trade structs
- new implementation function works after upgrade

## Phase 5: Oracle and Swap Adapter Integration Tests

These should be separated from core `Makeit` logic.

### Oracle tests

For `UniswapV3PoolOracleV3`:

- returns non-zero price after valid pool setup
- rejects invalid token pair
- owner-only updates behave correctly

### Swap adapter tests

For `UniswapV3SwapAdapterV3`:

- constructor setup
- owner-only setters
- slippage config validation
- buy path works
- sell path works
- invalid pool/token configuration reverts

### Environment

Use `solidity_local_deploy_v4` for real local integration with mocks and local Uniswap stack where practical.

## Phase 6: Fuzz Tests

After deterministic unit tests are stable, add fuzzing for:

- leverage
- profit target
- tolerance
- fee values
- prices around TP and SL boundaries
- open/close sequences with varying actors

### v3 fuzz focus

- early close PnL cap
- trade creation constraints
- no impossible payout under configured caps

### v4 fuzz focus

- short offset rule
- net exposure accounting
- long and short price-direction correctness

## Phase 7: Invariant Tests

Add invariants only after core tests are already green.

### Candidate invariants

- `nextTradeId` never decreases
- open exposure counters never go negative
- closed trades never return to `OPEN`
- only one initialization is possible
- `openMarginUSDC` equals sum of open margin counters
- for v4:
  - `openNotionalUSDC == max(openLongNotionalUSDC - openShortNotionalUSDC, 0)`
- no trade payout exceeds allowed capped economics

### Harness idea

Use handler-based invariants with controlled actions:

- owner actions
- fund actions
- open long
- open short
- early close
- liquidate

## Phase 8: Local Deployment Smoke Coverage

These are not deep logic tests. They are smoke tests for dev flow.

### Goal

Validate that local deploy assumptions still hold after changes.

### Scope

- local deploy script builds and deploys
- proxy address is what app uses
- implementation address is recorded
- initialized values match expectations
- oracle and adapter are wired

This can be implemented as:

- a script-level smoke command, or
- a small Node test harness, or
- Foundry script assertion pass if that is simpler

## Suggested Implementation Order

Work in this exact order:

1. Create test directories and helper contracts
2. Add proxy deployment helper for tests
3. Add v3 initialization/admin/open tests
4. Add v3 close/liquidation/fee tests
5. Add v4 initialization/admin/open tests
6. Add v4 short/open exposure tests
7. Add v4 close/liquidation/fee tests
8. Add upgrade tests
9. Add oracle and swap adapter integration tests
10. Add fuzz tests
11. Add invariant tests
12. Add local deploy smoke coverage
13. Add npm scripts for test execution

## Recommended Commands To Add Later

Add these scripts to root `package.json` later:

- `test:solidity:v3`
- `test:solidity:v4`
- `test:solidity:all`
- `test:solidity:v3:match`
- `test:solidity:v4:match`
- `test:solidity:v3:invariant`
- `test:solidity:v4:invariant`

Suggested forms:

- `node scripts/forge.js test --root solidity_v3`
- `node scripts/forge.js test --root solidity_v4`

Optional later:

- gas snapshots
- CI matrix by workspace

## Done Criteria

The testing implementation should be considered complete only when:

- v3 and v4 both have deterministic unit coverage for core flows
- upgrade tests exist and pass
- fee behavior is explicitly tested
- v4 short logic is explicitly tested
- at least one fuzz suite exists for each version
- at least one invariant suite exists for each version
- local deployment smoke coverage exists
- test scripts exist in `package.json`

## Non-Goals For First Pass

Do not block initial rollout on:

- 100% line coverage
- exhaustive Uniswap fork tests
- frontend/backend tests
- scenario JS replacement with Solidity tests

The first pass should focus on correctness of the on-chain core.

## First Implementation Step

When execution starts later, begin with:

1. create `test` folders
2. add base test harness + mock oracle + mock adapter
3. get a single proxy initialization test passing for v3

That will validate the testing foundation before expanding coverage.
