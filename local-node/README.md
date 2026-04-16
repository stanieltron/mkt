# mkt-anvil

Standalone Anvil + local contract deploy service extracted from `mkt`.

## Local

```bash
npm ci
npm start
```

`npm start` does:
- ensure Foundry is installed (`prestart`)
- run fresh local chain bootstrap (`scripts/run-local-chain.js --fresh`)
- keep Anvil running as the service process

## Deploy Anywhere

- Build/install command: `npm ci`
- Start command: `npm start`

This service starts Anvil on `0.0.0.0:$PORT`, deploys contracts, and keeps the chain running.
Use this service URL as `RPC_URL` for the separate FE/BE service.
