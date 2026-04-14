CREATE TABLE IF NOT EXISTS "ProcessedChainEvent" (
    id SERIAL PRIMARY KEY,
    "txHash" VARCHAR(66) NOT NULL,
    "logIndex" BIGINT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE ("txHash", "logIndex")
);

CREATE INDEX IF NOT EXISTS "ProcessedChainEvent_block_idx" ON "ProcessedChainEvent"("blockNumber");
