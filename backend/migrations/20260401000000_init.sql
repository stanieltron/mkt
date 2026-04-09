CREATE TYPE "TradeStatus" AS ENUM ('OPEN', 'CLOSED', 'LIQUIDATED');

CREATE TABLE "User" (
    id SERIAL PRIMARY KEY,
    "walletAddress" VARCHAR(42) NOT NULL UNIQUE,
    "referralCode" VARCHAR(32) NOT NULL UNIQUE,
    "referredBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totalTradingVolume" DECIMAL(40, 6) NOT NULL DEFAULT 0,
    CONSTRAINT "User_referredBy_fkey" FOREIGN KEY ("referredBy") REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "User_referredBy_idx" ON "User"("referredBy");

CREATE TABLE "Trade" (
    id SERIAL PRIMARY KEY,
    "onChainTradeId" BIGINT NOT NULL UNIQUE,
    "userId" INTEGER NOT NULL,
    direction VARCHAR(16) NOT NULL,
    leverage INTEGER NOT NULL,
    margin DECIMAL(40, 6) NOT NULL,
    "entryPrice" DECIMAL(40, 18) NOT NULL,
    "tpPrice" DECIMAL(40, 18) NOT NULL,
    "slPrice" DECIMAL(40, 18) NOT NULL,
    "exitPrice" DECIMAL(40, 18),
    "soldWeth" DECIMAL(40, 18),
    "boughtWeth" DECIMAL(40, 18),
    status "TradeStatus" NOT NULL DEFAULT 'OPEN',
    pnl DECIMAL(40, 6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "Trade_userId_status_idx" ON "Trade"("userId", status);
CREATE INDEX "Trade_status_createdAt_idx" ON "Trade"(status, "createdAt");

CREATE TABLE "PriceSample" (
    id SERIAL PRIMARY KEY,
    price DECIMAL(40, 18) NOT NULL,
    timestamp TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "PriceSample_timestamp_idx" ON "PriceSample"(timestamp);

CREATE TABLE "AppState" (
    key VARCHAR(128) PRIMARY KEY,
    value TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL
);
