use crate::bindings::Makeit;
use crate::services::user_service::UserService;
use bigdecimal::BigDecimal;
use chrono::Utc;
use ethers::providers::{Http, Provider};
use ethers::types::U256;
use sqlx::PgPool;
use std::str::FromStr;
use std::sync::Arc;
use tokio::time::{interval, Duration};

pub struct ChainSyncService {
    pool: PgPool,
    makeit: Makeit<Provider<Http>>,
    user_service: UserService,
    poll_ms: u64,
    state_key: String,
}

impl ChainSyncService {
    pub fn new(
        pool: PgPool,
        makeit: Makeit<Provider<Http>>,
        user_service: UserService,
        poll_ms: u64,
        state_key: String,
    ) -> Arc<Self> {
        Arc::new(Self { pool, makeit, user_service, poll_ms, state_key })
    }

    async fn get_last_seen_trade_id(&self) -> anyhow::Result<i64> {
        let max: Option<i64> = sqlx::query_scalar(r#"SELECT MAX("onChainTradeId") FROM "Trade""#)
            .fetch_one(&self.pool).await?;
        let max_db = max.unwrap_or(-1);
        let stored: Option<String> = sqlx::query_scalar(
            r#"SELECT value FROM "AppState" WHERE key = $1"#
        ).bind(&self.state_key).fetch_optional(&self.pool).await?;
        let stored_val = stored.and_then(|s| s.parse::<i64>().ok()).unwrap_or(-1);
        Ok(stored_val.max(max_db))
    }

    async fn set_last_seen_trade_id(&self, value: i64) -> anyhow::Result<()> {
        let now = Utc::now();
        sqlx::query(r#"
            INSERT INTO "AppState" (key, value, "updatedAt") VALUES ($1, $2, $3)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = EXCLUDED."updatedAt"
        "#).bind(&self.state_key).bind(value.to_string()).bind(now)
           .execute(&self.pool).await?;
        Ok(())
    }

    pub async fn refresh_existing_open_trades(&self) -> anyhow::Result<()> {
        let open_trade_ids: Vec<i64> = sqlx::query_scalar(
            r#"SELECT "onChainTradeId" FROM "Trade" WHERE status = 'OPEN' AND "onChainTradeId" > 0 ORDER BY id ASC LIMIT 1000"#
        )
        .fetch_all(&self.pool)
        .await?;

        for trade_id in open_trade_ids {
            if let Err(e) = self.upsert_trade(trade_id).await {
                tracing::warn!("[chain-sync] refresh open trade {} failed: {}", trade_id, e);
            }
        }
        Ok(())
    }

    pub async fn sync_trade(&self, trade_id: i64) -> anyhow::Result<()> {
        if trade_id <= 0 {
            anyhow::bail!("trade_id must be positive");
        }
        self.upsert_trade(trade_id).await
    }

    async fn upsert_trade(&self, trade_id: i64) -> anyhow::Result<()> {
        let data = self.makeit.get_trade(U256::from(trade_id as u64)).call().await?;

        let trader     = format!("{:#x}", data.0);
        let side       = data.1;
        let status_u8  = data.2;
        let opened_at  = data.3 as i64;
        let leverage   = data.5 as i32;

        // U256 values from contract → BigDecimal for correct NUMERIC(40,x) storage
        let margin_bd: BigDecimal = BigDecimal::from_str(&data.6.to_string())?;
        let entry_bd:  BigDecimal = BigDecimal::from_str(&data.8.to_string())?;
        let tp_bd:     BigDecimal = BigDecimal::from_str(&data.9.to_string())?;
        let sl_bd:     BigDecimal = BigDecimal::from_str(&data.10.to_string())?;

        let direction  = if side == 1 { "SHORT" } else { "LONG" };
        let status_str = match status_u8 {
            0 => "OPEN",
            1 | 2 => "LIQUIDATED",
            3 => "CLOSED",
            _ => "CLOSED",
        };

        let created_at = chrono::DateTime::<Utc>::from_timestamp(opened_at, 0)
            .unwrap_or_else(Utc::now);
        let closed_at: Option<chrono::DateTime<Utc>> =
            if status_u8 != 0 { Some(Utc::now()) } else { None };

        let mut tx = self.pool.begin().await?;
        let user = self.user_service.ensure_user(&trader, &mut tx).await?;

        let exists: Option<i32> = sqlx::query_scalar(
            r#"SELECT id FROM "Trade" WHERE "onChainTradeId" = $1"#
        ).bind(trade_id).fetch_optional(&mut *tx).await?;

        if exists.is_none() {
            sqlx::query(r##"
                INSERT INTO "Trade"
                    ("onChainTradeId","userId",direction,leverage,margin,"entryPrice","tpPrice","slPrice",status,"createdAt","closedAt")
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::"TradeStatus",$10,$11)
            "##)
            .bind(trade_id).bind(user.id).bind(direction).bind(leverage)
            .bind(&margin_bd).bind(&entry_bd).bind(&tp_bd).bind(&sl_bd)
            .bind(status_str).bind(created_at).bind(closed_at)
            .execute(&mut *tx).await?;
        } else {
            sqlx::query(r##"
                UPDATE "Trade"
                SET direction=$2, leverage=$3, margin=$4,"entryPrice"=$5,"tpPrice"=$6,"slPrice"=$7,status=$8::"TradeStatus","closedAt"=$9
                WHERE "onChainTradeId" = $1
            "##)
            .bind(trade_id).bind(direction).bind(leverage)
            .bind(&margin_bd).bind(&entry_bd).bind(&tp_bd).bind(&sl_bd).bind(status_str).bind(closed_at)
            .execute(&mut *tx).await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub fn start(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut ticker = interval(Duration::from_millis(self.poll_ms));
            loop {
                ticker.tick().await;
                if let Err(e) = self.tick().await {
                    tracing::error!("[chain-sync] tick failed: {}", e);
                }
            }
        });
    }

    async fn tick(&self) -> anyhow::Result<()> {
        self.refresh_existing_open_trades().await?;

        let next_id = self.makeit.next_trade_id().call().await?.as_u64() as i64;
        let last_seen = self.get_last_seen_trade_id().await?;
        let mut current = (last_seen + 1).max(1);
        if next_id <= current { return Ok(()); }

        while current < next_id {
            if let Err(e) = self.upsert_trade(current).await {
                tracing::warn!("[chain-sync] upsert trade {} failed: {}", current, e);
            }
            self.set_last_seen_trade_id(current).await?;
            current += 1;
        }
        Ok(())
    }
}
