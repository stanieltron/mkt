# Makeit Frontend

React + Vite UI for the deployed Sepolia contracts.

## Contracts

Configured in `src/config/contracts.js`:

- Oracle: `0x45604f3fBa0B901c6334C658eF3d242d910749f5`
- Swap Adapter: `0x307aA6fD4de41B0141f941BFEe7D461f79244527`
- Makeit: `0xEDa129BBBd6915e012CCa6bcfE539b9eFe3cFe4F`
- Optional USDT wallet display: set `usdt` address in config

## Features

- 1-second oracle polling and live ETH/USDC chart
- Wallet connection and Sepolia network checks
- USDC approval flow
- One-click "Get USDC" wallet swap (ETH -> WETH -> USDC) using the same router+pool fee from your swap adapter
- Open-trade form for `openTrade(expectedPriceE18, toleranceBps, profitTargetPct, tradeLeverage)`
- Open positions with live PnL, close, and liquidate actions

## Run

From repo root:

- `npm --prefix frontend install`
- `npm --prefix frontend run dev`

Build:

- `npm --prefix frontend run build`
