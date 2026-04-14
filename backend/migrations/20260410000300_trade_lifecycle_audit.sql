ALTER TABLE "Trade"
    ADD COLUMN IF NOT EXISTS "openTxHash" VARCHAR(66),
    ADD COLUMN IF NOT EXISTS "openBlockNumber" BIGINT,
    ADD COLUMN IF NOT EXISTS "closeTxHash" VARCHAR(66),
    ADD COLUMN IF NOT EXISTS "closeBlockNumber" BIGINT,
    ADD COLUMN IF NOT EXISTS "closeReason" VARCHAR(32),
    ADD COLUMN IF NOT EXISTS "payoutUsdc" DECIMAL(78, 0),
    ADD COLUMN IF NOT EXISTS "settlementAction" VARCHAR(40),
    ADD COLUMN IF NOT EXISTS "settlementUsdcAmount" DECIMAL(78, 0),
    ADD COLUMN IF NOT EXISTS "settlementWethAmount" DECIMAL(78, 0);

CREATE INDEX IF NOT EXISTS "Trade_openBlockNumber_idx" ON "Trade"("openBlockNumber");
CREATE INDEX IF NOT EXISTS "Trade_closeBlockNumber_idx" ON "Trade"("closeBlockNumber");
