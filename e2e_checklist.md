# MKT End-to-End Checklist

This checklist is for validating the whole local MKT app across:

- frontend
- backend API
- database
- chain services
- deployed contracts

Use it as a manual QA checklist and as a source for future automated tests.

## Scope

Main areas covered:

- app boot and local wiring
- wallet connect and chain switching
- price feed and charting
- faucet funding
- referral linking
- USDC approval
- long trade open
- short trade open (`v4`)
- close and liquidation
- backend indexing and persistence
- admin runner and market play

## Environment Bring-Up

### Stack boots cleanly

- [ ] `npm run deploy:all:with-db:fresh:v4` completes without fatal errors.
- [ ] Frontend loads at `http://127.0.0.1:5173`.
- [ ] Backend health is reachable at `http://127.0.0.1:8787/api/health`.
- [ ] Backend health reports:
  - [ ] `ok: true`
  - [ ] `protocolVariant: "v4"`
  - [ ] `makeitAddress` matches generated env
  - [ ] `latestPrice` is present after startup
- [ ] Generated env files exist and are aligned:
  - [ ] `.env.local`
  - [ ] `backend/.env.local`
  - [ ] `frontend/.env.local`
  - [ ] `frontend/src/generated/network.generated.js`

### Contracts are deployed and wired

- [ ] Deployment file exists at [solidity_local_deploy_v4\deployments\local.json](C:\mangata\mkt\solidity_local_deploy_v4\deployments\local.json).
- [ ] `MAKEIT_ADDRESS`, `ORACLE_ADDRESS`, `SWAP_ADAPTER_ADDRESS`, `UNISWAP_POOL_ADDRESS` all exist in env.
- [ ] Frontend and backend point to the same contract addresses.
- [ ] Backend starts with those same addresses without config errors.

## Wallet And Session

### Connect wallet

Frontend reference: [frontend\src\components\UserPage.jsx](C:\mangata\mkt\frontend\src\components\UserPage.jsx)

- [ ] Clicking `Connect Wallet` prompts MetaMask.
- [ ] Connected wallet address appears in the top bar.
- [ ] App detects the current chain id.
- [ ] If the wallet is on the wrong chain, the app offers and performs a switch to the configured local chain.
- [ ] On connect, FE performs:
  - [ ] wallet/provider setup
  - [ ] backend login call
  - [ ] trade load
  - [ ] balance load
  - [ ] faucet info load

### Backend login side effects

Backend references:
- [backend\src\index.js](C:\mangata\mkt\backend\src\index.js)
- [backend\src\services\user-service.js](C:\mangata\mkt\backend\src\services\user-service.js)

- [ ] FE calls `POST /api/users/login`.
- [ ] Backend creates user if wallet is new.
- [ ] Existing wallet logs in without duplicate user creation.
- [ ] Returned user contains:
  - [ ] `walletAddress`
  - [ ] `referralCode`
  - [ ] `totalTradingVolume`
- [ ] User row exists in DB `User` table after first login.

## Price Feed And Charting

References:
- [backend\src\services\price-sampler-service.js](C:\mangata\mkt\backend\src\services\price-sampler-service.js)
- [backend\src\index.js](C:\mangata\mkt\backend\src\index.js)

- [ ] Backend samples oracle price every second.
- [ ] `PriceSample` rows are being written to the DB.
- [ ] `GET /api/price/latest` returns a current price and timestamp.
- [ ] `GET /api/price/history?range=...` returns ordered samples.
- [ ] Frontend chart loads historical data on first render.
- [ ] Frontend chart updates with live price ticks.
- [ ] Displayed current price matches backend latest price reasonably.

## Faucet Funding

References:
- [frontend\src\components\UserPage.jsx](C:\mangata\mkt\frontend\src\components\UserPage.jsx)
- [backend\src\index.js](C:\mangata\mkt\backend\src\index.js)

- [ ] Clicking `Get Test Funds` sends `POST /api/faucet/claim`.
- [ ] Backend validates wallet address and faucet config.
- [ ] Backend sends:
  - [ ] ETH transfer if enabled
  - [ ] USDC transfer if enabled
- [ ] Backend returns tx hashes.
- [ ] Frontend waits for transaction confirmations.
- [ ] Wallet ETH balance updates after faucet.
- [ ] Wallet USDC balance updates after faucet.
- [ ] Cooldown is enforced correctly on repeated claims.

## Referral Flow

References:
- [frontend\src\components\UserPage.jsx](C:\mangata\mkt\frontend\src\components\UserPage.jsx)
- [backend\src\services\user-service.js](C:\mangata\mkt\backend\src\services\user-service.js)

- [ ] Referral link with `?ref=CODE` is captured by FE.
- [ ] Referral code survives connect/login flow.
- [ ] First login with valid referral code links referrer.
- [ ] Invalid referral code does not crash login and returns a clean result.
- [ ] Self-referral is blocked.
- [ ] Re-linking to a different referrer is blocked after referrer is set.
- [ ] `GET /api/users/:wallet/referrals` returns tier 1 and tier 2 structure.
- [ ] Referral totals update when referred users trade.

## Approval Flow

References:
- [frontend\src\components\UserPage.jsx](C:\mangata\mkt\frontend\src\components\UserPage.jsx)

- [ ] Opening a trade without enough USDC allowance shows approval prompt.
- [ ] `Approve Trade Amount + Trade` approves required amount and then continues.
- [ ] `Approve Max` sets large allowance without opening trade.
- [ ] `Approve Custom` validates positive amount.
- [ ] Approval transaction is sent to the active Makeit contract address.
- [ ] Approval failure surfaces a readable error to the user.

## Long Trade Open

Main FE/BE/contract path:

- FE action in [frontend\src\components\UserPage.jsx](C:\mangata\mkt\frontend\src\components\UserPage.jsx)
- BE indexing in [backend\src\services\chain-sync-service.js](C:\mangata\mkt\backend\src\services\chain-sync-service.js)

### Preconditions

- [ ] Wallet connected.
- [ ] Correct chain selected.
- [ ] Backend protocol variant matches frontend variant.
- [ ] Wallet has enough USDC.
- [ ] Wallet has enough USDC allowance.
- [ ] Pool has enough long capacity.

### FE behavior

- [ ] Clicking a long preset chooses the expected leverage.
- [ ] FE reads current `marginUSDC` from protocol state if needed.
- [ ] FE checks allowance before submitting.
- [ ] FE builds the transaction with expected price and tolerance.
- [ ] FE sends the long open transaction to the active Makeit contract.
- [ ] FE shows submitted tx hash.
- [ ] FE waits for receipt and fails if receipt status is not `1`.

### On-chain expectations

- [ ] Correct contract function is called for the active variant.
- [ ] Stored trade side is `LONG`.
- [ ] Trade leverage matches clicked preset.
- [ ] Trade margin matches contract net margin rules.
- [ ] Entry price is close to current oracle price, within tolerance.
- [ ] TP and SL are computed correctly for the product.
- [ ] `nextTradeId` increments exactly once.
- [ ] USDC moves from trader wallet into protocol as expected.
- [ ] Protocol exposure counters update correctly.

### Backend expectations after open

- [ ] FE triggers `POST /api/trades/sync`.
- [ ] Backend `syncNewTrades()` notices `nextTradeId` increased.
- [ ] Backend fetches the new trade via `makeit.getTrade(tradeId)`.
- [ ] Backend creates or reuses the `User` row safely.
- [ ] Backend inserts a `Trade` row with:
  - [ ] `onChainTradeId`
  - [ ] `direction = LONG`
  - [ ] `status = OPEN`
  - [ ] `margin`
  - [ ] `entryPrice`
  - [ ] `tpPrice`
  - [ ] `slPrice`
  - [ ] `leverage`
- [ ] Backend increments `User.totalTradingVolume` once for the new trade.
- [ ] Backend updates `AppState` last-seen trade id.

### FE expectations after backend refresh

- [ ] New trade appears in `Open Trades`.
- [ ] Values shown in table match the on-chain trade:
  - [ ] side
  - [ ] leverage
  - [ ] entry
  - [ ] TP
  - [ ] SL
- [ ] Live PnL starts updating with price changes.

## Short Trade Open (`v4`)

### Preconditions

- [ ] Active protocol is `v4`.
- [ ] Backend is also running `v4`.
- [ ] There is enough short capacity from open long notional.

### FE behavior

- [ ] Short buttons are only enabled when capacity is sufficient.
- [ ] If short capacity is unavailable, FE keeps short buttons disabled or shows explanatory messaging.
- [ ] Clicking a short preset opens a short with the chosen leverage.

### On-chain expectations

- [ ] Trade side is stored as `SHORT`.
- [ ] Long-offset gating is enforced.
- [ ] Revert `NoLongNotionalToOffsetShort` is surfaced as a readable FE error.
- [ ] Short TP/SL directions are correct.
- [ ] Exposure accounting updates correctly for long/short buckets.

### Backend expectations

- [ ] Indexed trade row has `direction = SHORT`.
- [ ] Trade appears in FE open trades with `SHORT` tag.

## Close And Liquidation

### Manual close path

- [ ] Clicking `Close` on an open trade submits a close transaction.
- [ ] FE uses `close(tradeId)` first.
- [ ] If early close is allowed, tx confirms successfully.
- [ ] After backend refresh, trade leaves `Open Trades` and appears in `Closed Trades`.
- [ ] Indexed close data includes:
  - [ ] `status`
  - [ ] `exitPrice`
  - [ ] `pnl`
  - [ ] `closedAt`

### Liquidation fallback path

- [ ] If TP/SL already hit, FE catches the close error and falls back to `liquidateTrade(tradeId)`.
- [ ] Liquidation tx confirms successfully.
- [ ] Trade becomes `LIQUIDATED` or equivalent closed status in DB/UI.

### Backend close indexing

- [ ] `refreshOpenTrades()` re-reads open trades from chain.
- [ ] Backend detects status changed from `OPEN`.
- [ ] Backend queries `TradeClosed` logs for close details.
- [ ] Backend stores final `exitPrice`, `pnl`, and `closedAt`.

## Trade Numbers Integrity

For both long and short flows:

- [ ] Margin displayed on FE matches indexed DB margin.
- [ ] DB margin matches contract net margin, not accidental gross amount.
- [ ] Entry, TP, SL displayed on FE match indexed DB values.
- [ ] Closed trade `pnl` in FE matches indexed DB `pnl`.
- [ ] Closed trade payout shown on FE equals `margin + pnl`, floored at `0`.
- [ ] User `totalTradingVolume` is cumulative and monotonic.
- [ ] No duplicate `Trade` rows are created for one `onChainTradeId`.

## Polling And Sync Behavior

References:
- [backend\src\services\chain-sync-service.js](C:\mangata\mkt\backend\src\services\chain-sync-service.js)
- [backend\src\lib\env.js](C:\mangata\mkt\backend\src\lib\env.js)

- [ ] Backend chain sync runs immediately on startup.
- [ ] Backend chain sync repeats on configured interval.
- [ ] New trades are discovered from `nextTradeId()`.
- [ ] Existing open trades are re-checked from DB and refreshed from chain.
- [ ] Sync does not create duplicate users for the same wallet.
- [ ] Sync does not create duplicate trades for the same `onChainTradeId`.
- [ ] Manual `POST /api/trades/sync` works and returns `ok: true`.

## Admin / Market Play

References:
- [frontend\src\components\AdminPage.jsx](C:\mangata\mkt\frontend\src\components\AdminPage.jsx)
- [backend\src\services\swap-runner-service.js](C:\mangata\mkt\backend\src\services\swap-runner-service.js)

- [ ] Admin login works with configured credentials.
- [ ] `GET /api/admin/runner` works only with auth.
- [ ] `GET /api/admin/overview` returns:
  - [ ] pool state
  - [ ] runner state
  - [ ] liquidation bot state
  - [ ] indexed trades
- [ ] Start/Stop controls start and stop market runner behavior.
- [ ] Trend slider updates backend runner config.
- [ ] Volatility slider updates backend runner config.
- [ ] At max trend, aligned runner trades are dramatically stronger.
- [ ] Runner logs show submitted and confirmed transactions.
- [ ] Price chart responds to market-play activity.

## Variant Switching

- [ ] FE can switch between `v3` and `v4` when both addresses are present.
- [ ] FE blocks trading when selected FE variant does not match backend variant.
- [ ] FE explains mismatch clearly instead of silently failing.
- [ ] When switching back to backend-supported variant, trade list loads again.

## DB Integrity

References:
- [backend\prisma\schema.prisma](C:\mangata\mkt\backend\prisma\schema.prisma)

- [ ] `User` rows remain unique by `walletAddress`.
- [ ] `referralCode` remains unique.
- [ ] `Trade` rows remain unique by `onChainTradeId`.
- [ ] `PriceSample` rows continue to append over time.
- [ ] `AppState` stores last-seen sync key for the active deployment.
- [ ] No transaction-aborted loops occur during concurrent sync.

## Error Handling

- [ ] Wrong chain shows actionable FE message.
- [ ] Missing MetaMask shows actionable FE message.
- [ ] Missing allowance shows approval prompt instead of a raw revert.
- [ ] `PriceOutOfTolerance` shows readable FE error.
- [ ] `NoLongNotionalToOffsetShort` shows readable FE error.
- [ ] `InsufficientEthCoverage` shows readable FE error.
- [ ] Backend unreachable shows readable FE error.
- [ ] Backend sync lag after on-chain success is surfaced as pending refresh, not as trade failure.

## Suggested Manual Smoke Journeys

### Journey 1: First-Time Long Trade

- [ ] Boot stack
- [ ] Connect wallet
- [ ] Claim faucet funds
- [ ] Approve USDC
- [ ] Open long
- [ ] Verify open trade appears
- [ ] Close trade
- [ ] Verify closed trade appears with exit price and PnL

### Journey 2: Short Trade In `v4`

- [ ] Open one or more longs first
- [ ] Confirm short capacity becomes available
- [ ] Open short
- [ ] Verify short trade is indexed and displayed correctly
- [ ] Drive price with market play if needed
- [ ] Close or liquidate short

### Journey 3: Referral + Trade Volume

- [ ] Wallet A connects and copies referral link
- [ ] Wallet B opens app with Wallet A referral link
- [ ] Wallet B connects and gets paired
- [ ] Wallet B opens trade
- [ ] Wallet A referral totals increase after indexing

### Journey 4: Admin Runner

- [ ] Login to admin
- [ ] Start market play
- [ ] Move trend lever to max
- [ ] Verify stronger directional price pressure
- [ ] Stop market play

## Notes

- This checklist describes the current local app behavior, where the backend indexes chain state into Postgres and the frontend reads trades from backend APIs.
- The most important cross-layer path is:
  - user action in FE
  - on-chain tx confirmation
  - backend sync/indexing
  - FE refresh from backend
