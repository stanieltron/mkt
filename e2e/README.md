# E2E

This directory is reserved for end-to-end tests.

Planned local flow e2e:

1. Boot local stack (`npm run local:fresh`).
2. Create 10 wallets.
3. Claim faucet for each wallet.
4. Apply referral links/codes.
5. Open controlled trades.
6. Move local Uniswap price via scripted swaps.
7. Let liquidation bot process liquidations.
8. Assert on-chain status, DB state, referral totals, and WS payloads.

Run (quick scenario, assumes local stack is already running):

```bash
npm run test:e2e
```

Recommended flow:

```bash
npm run local:fresh
npm run test:e2e
```
