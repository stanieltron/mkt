ALTER TABLE "User"
    ALTER COLUMN "totalTradingVolume" TYPE DECIMAL(78,0)
    USING trunc("totalTradingVolume")::DECIMAL(78,0);

ALTER TABLE "Trade"
    ALTER COLUMN margin TYPE DECIMAL(78,0) USING trunc(margin)::DECIMAL(78,0),
    ALTER COLUMN "entryPrice" TYPE DECIMAL(78,0) USING trunc("entryPrice")::DECIMAL(78,0),
    ALTER COLUMN "tpPrice" TYPE DECIMAL(78,0) USING trunc("tpPrice")::DECIMAL(78,0),
    ALTER COLUMN "slPrice" TYPE DECIMAL(78,0) USING trunc("slPrice")::DECIMAL(78,0),
    ALTER COLUMN "exitPrice" TYPE DECIMAL(78,0) USING trunc("exitPrice")::DECIMAL(78,0),
    ALTER COLUMN "soldWeth" TYPE DECIMAL(78,0) USING trunc("soldWeth")::DECIMAL(78,0),
    ALTER COLUMN "boughtWeth" TYPE DECIMAL(78,0) USING trunc("boughtWeth")::DECIMAL(78,0),
    ALTER COLUMN pnl TYPE DECIMAL(78,0) USING trunc(pnl)::DECIMAL(78,0);

ALTER TABLE "PriceSample"
    ALTER COLUMN price TYPE DECIMAL(78,0)
    USING trunc(price)::DECIMAL(78,0);
