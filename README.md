# mkt Monorepo

This repository now supports **3 independent deploy roots**.

## Apps

1. `backend/`
- Rust API service.
- Has its own `Dockerfile`, `.env.example`, and start scripts.
- Modes:
  - `npm run start:public`
  - `npm run start:local`
  - `npm run start:local:fresh`

2. `frontend/`
- React/Vite frontend.
- Has its own `Dockerfile`, `.env.example`, and runtime gateway (`scripts/start-gateway.cjs`).
- Proxies:
  - `/api/*` -> `BACKEND_URL`
  - `/rpc` -> `FRONTEND_RPC_URL` (or `RPC_URL`)
- Includes admin runner + faucet overlays via runtime injection.

3. `local-node/`
- Local Anvil chain + contract deployment service (copied from `mkt-anvil`).
- Has its own `Dockerfile` and `.env.example`.

## Deploying separately (Railway or any platform)

Create 3 services and set root directory per service:

- Service A: `local-node/`
- Service B: `backend/`
- Service C: `frontend/`

Recommended order:

1. Deploy `local-node`.
2. Copy emitted addresses/keys to `backend` env.
3. Deploy `backend`.
4. Set `frontend` env:
- `BACKEND_URL` = backend public URL
- `FRONTEND_RPC_URL` = local-node public URL
5. Deploy `frontend`.

## Notes

- Updating one app does not require redeploying the others unless shared env/contracts changed.
- Existing root-level scripts are kept for compatibility during transition.