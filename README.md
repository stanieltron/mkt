# Makeit Local Trading Simulation

This repository contains the Makeit protocol contracts, local deployment tooling, Rust backend services, frontend app, and scenario simulation code for local development.

At a high level:

- traders open leveraged positions using fixed-margin products
- protocol state is driven by an oracle price + liquidation logic
- local stack runs on Anvil + PostgreSQL + Rust backend + Vite frontend

## Repository Layout

- `solidity`
  Protocol contracts and tests (Foundry)
- `local_deploy_rust`
  Local-only contracts, deployment outputs, and local dev helpers
- `backend`
  Rust backend service and SQL migrations
- `frontend`
  Frontend app (Vite)
- `scripts`
  Local orchestration scripts (`anvil`, deploy, db, dev)
- `scenarios`
  Off-chain simulation assets and scenario work

## Prerequisites

- Node.js + npm
- Foundry (`forge` and `anvil`)
- Rust toolchain (`cargo`)
- Docker (for local PostgreSQL via compose)

Optional (recommended for backend hot reload):

- `cargo-watch` (`cargo install cargo-watch`)

## Quick Start

Start full local stack (Anvil + deploy + DB + Rust backend + frontend):

```bash
npm run dev
```

Fresh reset mode (resets chain + DB schema before startup):

```bash
npm run dev:fresh
```

## Common Commands

- Full local stack:

```bash
npm run dev
```

- Full local stack (fresh):

```bash
npm run dev:fresh
```

- Deploy contracts only:

```bash
npm run deploy:local
```

- Start Anvil only:

```bash
npm run anvil
```

- Bring up PostgreSQL container:

```bash
npm run db:up
```

- Reset PostgreSQL container volume + start:

```bash
npm run db:up:fresh
```

- One-command deployment wrapper:

```bash
npm run deploy:all
npm run deploy:all:with-db
npm run deploy:all:reset-db
```

- Build Solidity contracts:

```bash
npm run build:solidity
npm run build:solidity:local
```

- Run Solidity tests:

```bash
npm run test:solidity
npm run test:solidity:local
npm run test:solidity:invariant
```

- Frontend only:

```bash
npm run frontend:dev
npm run frontend:build
```

## Environment Files

`npm run deploy:local` generates and updates:

- `.env.local`
- `backend/.env`
- `backend/.env.local`
- `frontend/.env.local`

Deployment data is written to:

- `local_deploy_rust/deployments/local.json`

## Notes

- Current root flow is Rust-first (`scripts/dev-rust.js`) and does not use the old multi-variant `v3/v4` split documented in older versions of this README.
- `npm run dev:apps` currently forwards to the full rust stack flow.
