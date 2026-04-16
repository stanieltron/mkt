use crate::bindings::makeit::{TradeClosedFilter, TradeOpenedFilter};
use crate::bindings::Makeit;
use crate::db::models::{Trade, TradeStatus};
use crate::lib::cache::CacheService;
use crate::services::realtime::RealtimeHub;
use crate::services::user_service::UserService;
use bigdecimal::BigDecimal;
use chrono::Utc;
use ethers::contract::LogMeta;
use ethers::providers::{Http, Middleware, Provider};
use ethers::types::U256;
use sqlx::PgPool;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use tokio::time::{interval, Duration};

#[derive(Clone, Debug)]
struct ClosedEventData {
    close_price_e18: BigDecimal,
    pnl_usdc6: BigDecimal,
    sold_weth18: BigDecimal,
    bought_weth18: BigDecimal,
    payout_usdc6: BigDecimal,
    close_reason: String,
    settlement_action: String,
    settlement_usdc_amount: BigDecimal,
    settlement_weth_amount: BigDecimal,
}

pub struct ChainSyncService {
    pool: PgPool,
    makeit: Makeit<Provider<Http>>,
    user_service: UserService,
    poll_ms: u64,
    state_key: String,
    start_block: Option<u64>,
    cache: Arc<CacheService>,
    realtime: Arc<RealtimeHub>,
}

impl ChainSyncService {
    pub fn new(
        pool: PgPool,
        makeit: Makeit<Provider<Http>>,
        user_service: UserService,
        poll_ms: u64,
        state_key: String,
        start_block: Option<u64>,
        cache: Arc<CacheService>,
        realtime: Arc<RealtimeHub>,
    ) -> Arc<Self> {
        Arc::new(Self {
            pool,
            makeit,
            user_service,
            poll_ms,
            state_key,
            start_block,
            cache,
            realtime,
        })
    }

    async fn get_checkpoint(&self) -> anyhow::Result<(u64, u64, bool)> {
        let block_key = format!("{}:last_block", self.state_key);
        let log_key = format!("{}:last_log", self.state_key);
        let block_val: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "AppState" WHERE key = $1"#)
            .bind(&block_key)
            .fetch_optional(&self.pool)
            .await?;
        let log_val: Option<String> = sqlx::query_scalar(r#"SELECT value FROM "AppState" WHERE key = $1"#)
            .bind(&log_key)
            .fetch_optional(&self.pool)
            .await?;

        let has_checkpoint = block_val.is_some() && log_val.is_some();
        Ok((
            block_val.and_then(|v| v.parse::<u64>().ok()).unwrap_or(0),
            log_val.and_then(|v| v.parse::<u64>().ok()).unwrap_or(0),
            has_checkpoint,
        ))
    }

    async fn set_checkpoint(&self, block: u64, log_idx: u64) -> anyhow::Result<()> {
        let now = Utc::now();
        let block_key = format!("{}:last_block", self.state_key);
        let log_key = format!("{}:last_log", self.state_key);

        sqlx::query(
            r#"
            INSERT INTO "AppState" (key, value, "updatedAt") VALUES ($1, $2, $3)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = EXCLUDED."updatedAt"
            "#,
        )
        .bind(&block_key)
        .bind(block.to_string())
        .bind(now)
        .execute(&self.pool)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO "AppState" (key, value, "updatedAt") VALUES ($1, $2, $3)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = EXCLUDED."updatedAt"
            "#,
        )
        .bind(&log_key)
        .bind(log_idx.to_string())
        .bind(now)
        .execute(&self.pool)
        .await?;

        Ok(())
    }

    async fn is_processed(&self, tx_hash: &str, log_index: i64) -> anyhow::Result<bool> {
        let exists: Option<i32> = sqlx::query_scalar(
            r#"SELECT 1 FROM "ProcessedChainEvent" WHERE "txHash" = $1 AND "logIndex" = $2"#,
        )
        .bind(tx_hash)
        .bind(log_index)
        .fetch_optional(&self.pool)
        .await?;
        Ok(exists.is_some())
    }

    async fn mark_processed(&self, tx_hash: &str, log_index: i64, block_number: i64) -> anyhow::Result<()> {
        sqlx::query(
            r#"
            INSERT INTO "ProcessedChainEvent" ("txHash", "logIndex", "blockNumber")
            VALUES ($1, $2, $3)
            ON CONFLICT ("txHash", "logIndex") DO NOTHING
            "#,
        )
        .bind(tx_hash)
        .bind(log_index)
        .bind(block_number)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn refresh_existing_open_trades(&self) -> anyhow::Result<()> {
        let open_trade_ids: Vec<i64> = sqlx::query_scalar(
            r#"SELECT "onChainTradeId" FROM "Trade" WHERE status = 'OPEN' AND "onChainTradeId" > 0 ORDER BY id ASC LIMIT 1000"#,
        )
        .fetch_all(&self.pool)
        .await?;

        for trade_id in open_trade_ids {
            if let Err(e) = self
                .upsert_trade(trade_id, None, None, None, None, None, None)
                .await
            {
                tracing::warn!("[chain-sync] refresh open trade {} failed: {}", trade_id, e);
            }
        }
        Ok(())
    }

    async fn refresh_recent_onchain_trades(&self, window: u64) -> anyhow::Result<()> {
        let next_trade_id = self.makeit.next_trade_id().call().await?.as_u64();
        if next_trade_id == 0 {
            return Ok(());
        }
        let newest = next_trade_id.saturating_sub(1);
        let start = newest.saturating_sub(window.saturating_sub(1));
        for id in start..=newest {
            if let Err(e) = self.upsert_trade(id as i64, None, None, None, None, None, None).await {
                tracing::warn!("[chain-sync] refresh recent trade {} failed: {}", id, e);
            }
        }
        Ok(())
    }

    pub async fn sync_trade(&self, trade_id: i64) -> anyhow::Result<()> {
        if trade_id <= 0 {
            anyhow::bail!("trade_id must be positive");
        }
        self.upsert_trade(trade_id, None, None, None, None, None, None)
            .await
            .map(|_| ())
    }

    async fn refresh_user_cache(&self, user_id: i32, wallet: &str) -> anyhow::Result<()> {
        let trades: Vec<Trade> = sqlx::query_as(
            r#"SELECT * FROM "Trade" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 500"#,
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .unwrap_or_default();

        let open: Vec<serde_json::Value> = trades
            .iter()
            .filter(|t| t.status == TradeStatus::Open)
            .map(Self::trade_to_json)
            .collect();
        let closed: Vec<serde_json::Value> = trades
            .iter()
            .filter(|t| t.status != TradeStatus::Open)
            .take(50)
            .map(Self::trade_to_json)
            .collect();

        self.cache
            .set_json(
                &format!("user:{}:trades:open", wallet.to_lowercase()),
                &serde_json::json!(open),
                Some(60),
            )
            .await?;
        self.cache
            .set_json(
                &format!("user:{}:trades:closed_head", wallet.to_lowercase()),
                &serde_json::json!(closed),
                Some(60),
            )
            .await?;

        let tier1_volume: BigDecimal = sqlx::query_scalar(
            r#"SELECT COALESCE(SUM("totalTradingVolume"), 0) FROM "User" WHERE "referredBy" = $1"#,
        )
        .bind(user_id)
        .fetch_one(&self.pool)
        .await
        .unwrap_or_else(|_| BigDecimal::from(0));

        let tier2_volume: BigDecimal = sqlx::query_scalar(
            r#"
            SELECT COALESCE(SUM(child."totalTradingVolume"), 0)
            FROM "User" child
            JOIN "User" parent ON child."referredBy" = parent.id
            WHERE parent."referredBy" = $1
            "#,
        )
        .bind(user_id)
        .fetch_one(&self.pool)
        .await
        .unwrap_or_else(|_| BigDecimal::from(0));

        let summary = serde_json::json!({
            "tier1Volume": tier1_volume.to_string(),
            "tier2Volume": tier2_volume.to_string(),
            "combinedVolume": (&tier1_volume + &tier2_volume).to_string(),
        });
        self.cache
            .set_json(
                &format!("user:{}:referral_summary", wallet.to_lowercase()),
                &summary,
                Some(60),
            )
            .await?;

        let evt = self
            .realtime
            .make_event("referral_summary", Some(wallet), summary.clone());
        self.realtime.publish_wallet(wallet, &evt).await;
        let _ = self
            .cache
            .publish_json(&format!("stream:user:{}", wallet.to_lowercase()), &evt)
            .await;

        Ok(())
    }

    fn trade_to_json(t: &Trade) -> serde_json::Value {
        serde_json::json!({
            "id": t.id,
            "onChainTradeId": t.on_chain_trade_id.to_string(),
            "userId": t.user_id,
            "direction": t.direction,
            "leverage": t.leverage,
            "margin": t.margin.to_string(),
            "entryPrice": t.entry_price.to_string(),
            "tpPrice": t.tp_price.to_string(),
            "slPrice": t.sl_price.to_string(),
            "exitPrice": t.exit_price.as_ref().map(|v| v.to_string()),
            "soldWeth": t.sold_weth.as_ref().map(|v| v.to_string()),
            "boughtWeth": t.bought_weth.as_ref().map(|v| v.to_string()),
            "status": match t.status {
                TradeStatus::Open => "OPEN",
                TradeStatus::Closed => "CLOSED",
                TradeStatus::Liquidated => "LIQUIDATED",
            },
            "pnl": t.pnl.as_ref().map(|v| v.to_string()),
            "createdAt": t.created_at,
            "closedAt": t.closed_at,
            "openTxHash": t.open_tx_hash,
            "openBlockNumber": t.open_block_number,
            "closeTxHash": t.close_tx_hash,
            "closeBlockNumber": t.close_block_number,
            "closeReason": t.close_reason,
            "payoutUsdc": t.payout_usdc.as_ref().map(|v| v.to_string()),
            "settlementAction": t.settlement_action,
            "settlementUsdcAmount": t.settlement_usdc_amount.as_ref().map(|v| v.to_string()),
            "settlementWethAmount": t.settlement_weth_amount.as_ref().map(|v| v.to_string()),
        })
    }

    fn close_reason_from_status_code(code: u8) -> &'static str {
        match code {
            1 => "CLOSED_TP",
            2 => "CLOSED_SL",
            3 => "CLOSED_EARLY",
            _ => "CLOSED_UNKNOWN",
        }
    }

    async fn upsert_trade(
        &self,
        trade_id: i64,
        closed_at_override: Option<chrono::DateTime<Utc>>,
        closed_event: Option<ClosedEventData>,
        open_tx_hash: Option<String>,
        open_block_number: Option<i64>,
        close_tx_hash: Option<String>,
        close_block_number: Option<i64>,
    ) -> anyhow::Result<(String, serde_json::Value, bool)> {
        let data = self.makeit.get_trade(U256::from(trade_id as u64)).call().await?;

        let trader = format!("{:#x}", data.0);
        let side = data.1;
        let status_u8 = data.2;
        let opened_at = data.3 as i64;
        let leverage = data.5 as i32;

        let margin_bd: BigDecimal = BigDecimal::from_str(&data.6.to_string())?;
        let entry_bd: BigDecimal = BigDecimal::from_str(&data.8.to_string())?;
        let tp_bd: BigDecimal = BigDecimal::from_str(&data.9.to_string())?;
        let sl_bd: BigDecimal = BigDecimal::from_str(&data.10.to_string())?;

        let direction = if side == 1 { "SHORT" } else { "LONG" };
        let mut status_str = match status_u8 {
            0 => "OPEN",
            1 | 2 => "LIQUIDATED",
            3 => "CLOSED",
            _ => "CLOSED",
        };
        if let Some(ref ev) = closed_event {
            status_str = if ev.close_reason == "CLOSED_EARLY" {
                "CLOSED"
            } else {
                "LIQUIDATED"
            };
        }
        if closed_event.is_some() && status_u8 == 0 {
            // If event-driven close arrived before getTrade reflects status, prefer closed classification.
            status_str = "LIQUIDATED";
        }

        let created_at = chrono::DateTime::<Utc>::from_timestamp(opened_at, 0).unwrap_or_else(Utc::now);
        let closed_at: Option<chrono::DateTime<Utc>> = if status_u8 != 0 || closed_event.is_some() {
            Some(closed_at_override.unwrap_or_else(Utc::now))
        } else {
            None
        };
        let exit_price = closed_event.as_ref().map(|v| v.close_price_e18.clone());
        let pnl = closed_event.as_ref().map(|v| v.pnl_usdc6.clone());
        let sold_weth = closed_event.as_ref().map(|v| v.sold_weth18.clone());
        let bought_weth = closed_event.as_ref().map(|v| v.bought_weth18.clone());
        let payout_usdc = closed_event.as_ref().map(|v| v.payout_usdc6.clone());
        let close_reason = closed_event
            .as_ref()
            .map(|v| v.close_reason.clone())
            .or_else(|| {
                if status_u8 == 0 {
                    None
                } else {
                    Some(Self::close_reason_from_status_code(status_u8).to_string())
                }
            });
        let settlement_action = closed_event.as_ref().map(|v| v.settlement_action.clone());
        let settlement_usdc_amount = closed_event
            .as_ref()
            .map(|v| v.settlement_usdc_amount.clone());
        let settlement_weth_amount = closed_event
            .as_ref()
            .map(|v| v.settlement_weth_amount.clone());

        let mut tx = self.pool.begin().await?;
        let user = self.user_service.ensure_user(&trader, &mut tx).await?;

        let exists: Option<i32> = sqlx::query_scalar(r#"SELECT id FROM "Trade" WHERE "onChainTradeId" = $1"#)
            .bind(trade_id)
            .fetch_optional(&mut *tx)
            .await?;

        if exists.is_none() {
            sqlx::query(
                r##"
                INSERT INTO "Trade"
                    ("onChainTradeId","userId",direction,leverage,margin,"entryPrice","tpPrice","slPrice","exitPrice","soldWeth","boughtWeth",status,pnl,"createdAt","closedAt","openTxHash","openBlockNumber","closeTxHash","closeBlockNumber","closeReason","payoutUsdc","settlementAction","settlementUsdcAmount","settlementWethAmount")
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::"TradeStatus",$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
            "##,
            )
            .bind(trade_id)
            .bind(user.id)
            .bind(direction)
            .bind(leverage)
            .bind(&margin_bd)
            .bind(&entry_bd)
            .bind(&tp_bd)
            .bind(&sl_bd)
            .bind(exit_price)
            .bind(sold_weth)
            .bind(bought_weth)
            .bind(status_str)
            .bind(pnl)
            .bind(created_at)
            .bind(closed_at)
            .bind(open_tx_hash)
            .bind(open_block_number)
            .bind(close_tx_hash)
            .bind(close_block_number)
            .bind(close_reason)
            .bind(payout_usdc)
            .bind(settlement_action)
            .bind(settlement_usdc_amount)
            .bind(settlement_weth_amount)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query(
                r##"
                UPDATE "Trade"
                SET direction=$2, leverage=$3, margin=$4,"entryPrice"=$5,"tpPrice"=$6,"slPrice"=$7,
                    "exitPrice"=COALESCE($8, "exitPrice"),
                    "soldWeth"=COALESCE($9, "soldWeth"),
                    "boughtWeth"=COALESCE($10, "boughtWeth"),
                    status=$11::"TradeStatus",
                    pnl=COALESCE($12, pnl),
                    "closedAt"=COALESCE($13, "closedAt"),
                    "openTxHash"=COALESCE($14, "openTxHash"),
                    "openBlockNumber"=COALESCE($15, "openBlockNumber"),
                    "closeTxHash"=COALESCE($16, "closeTxHash"),
                    "closeBlockNumber"=COALESCE($17, "closeBlockNumber"),
                    "closeReason"=COALESCE($18, "closeReason"),
                    "payoutUsdc"=COALESCE($19, "payoutUsdc"),
                    "settlementAction"=COALESCE($20, "settlementAction"),
                    "settlementUsdcAmount"=COALESCE($21, "settlementUsdcAmount"),
                    "settlementWethAmount"=COALESCE($22, "settlementWethAmount")
                WHERE "onChainTradeId" = $1
            "##,
            )
            .bind(trade_id)
            .bind(direction)
            .bind(leverage)
            .bind(&margin_bd)
            .bind(&entry_bd)
            .bind(&tp_bd)
            .bind(&sl_bd)
            .bind(exit_price)
            .bind(sold_weth)
            .bind(bought_weth)
            .bind(status_str)
            .bind(pnl)
            .bind(closed_at)
            .bind(open_tx_hash)
            .bind(open_block_number)
            .bind(close_tx_hash)
            .bind(close_block_number)
            .bind(close_reason)
            .bind(payout_usdc)
            .bind(settlement_action)
            .bind(settlement_usdc_amount)
            .bind(settlement_weth_amount)
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query(
            r#"
            UPDATE "User"
            SET "totalTradingVolume" = COALESCE(
                (
                    SELECT SUM(margin * leverage::numeric)
                    FROM "Trade"
                    WHERE "userId" = $1
                ),
                0
            )
            WHERE id = $1
            "#,
        )
        .bind(user.id)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;

        let trade_row: Trade = sqlx::query_as(r#"SELECT * FROM "Trade" WHERE "onChainTradeId" = $1"#)
            .bind(trade_id)
            .fetch_one(&self.pool)
            .await?;
        self.refresh_user_cache(user.id, &trader).await?;

        let trade_json = Self::trade_to_json(&trade_row);
        Ok((trader, trade_json, status_u8 != 0))
    }

    async fn process_trade_event(
        &self,
        trade_id: i64,
        meta: &LogMeta,
        block_ts_cache: &mut HashMap<u64, chrono::DateTime<Utc>>,
    ) -> anyhow::Result<()> {
        let tx_hash = format!("{:#x}", meta.transaction_hash);
        let log_index = meta.log_index.as_u64() as i64;
        if self.is_processed(&tx_hash, log_index).await? {
            return Ok(());
        }

        let block_number = meta.block_number.as_u64();
        let closed_at_override = if let Some(ts) = block_ts_cache.get(&block_number) {
            Some(*ts)
        } else {
            let fetched = self
                .makeit
                .client()
                .get_block(block_number)
                .await?
                .and_then(|b| chrono::DateTime::<Utc>::from_timestamp(b.timestamp.as_u64() as i64, 0))
                .unwrap_or_else(Utc::now);
            block_ts_cache.insert(block_number, fetched);
            Some(fetched)
        };

        let (wallet, trade_json, is_closed) = self
            .upsert_trade(
                trade_id,
                closed_at_override,
                None,
                Some(tx_hash.clone()),
                Some(block_number as i64),
                None,
                None,
            )
            .await?;
        self.mark_processed(&tx_hash, log_index, block_number as i64).await?;
        tracing::info!(
            "[chain-sync] trade opened seen: tradeId={} wallet={} tx={} block={} logIndex={}",
            trade_id,
            wallet,
            tx_hash,
            block_number,
            log_index
        );

        let event_name = if is_closed { "trade_closed" } else { "trade_upsert" };
        let evt = self.realtime.make_event(
            event_name,
            Some(&wallet),
            serde_json::json!({
                "trade": trade_json,
                "txHash": tx_hash,
                "logIndex": log_index,
                "blockNumber": block_number,
            }),
        );
        self.realtime.publish_wallet(&wallet, &evt).await;
        let _ = self
            .cache
            .publish_json(&format!("stream:user:{}", wallet.to_lowercase()), &evt)
            .await;

        Ok(())
    }

    pub fn start(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut ticker = interval(Duration::from_millis(self.poll_ms));
            let mut refresh_counter: u32 = 0;
            loop {
                ticker.tick().await;
                if let Err(e) = self.tick().await {
                    tracing::error!("[chain-sync] tick failed: {}", e);
                }
                refresh_counter = refresh_counter.wrapping_add(1);
                // Fast self-heal: if an event is missed or delayed, reconcile OPEN rows from chain frequently.
                if refresh_counter % 5 == 0 {
                    if let Err(e) = self.refresh_existing_open_trades().await {
                        tracing::warn!("[chain-sync] open refresh failed: {}", e);
                    }
                    if let Err(e) = self.refresh_recent_onchain_trades(200).await {
                        tracing::warn!("[chain-sync] recent refresh failed: {}", e);
                    }
                }
            }
        });
    }

    async fn tick(&self) -> anyhow::Result<()> {
        let head = self.makeit.client().get_block_number().await?.as_u64();
        let (mut last_block, mut last_log, has_checkpoint) = self.get_checkpoint().await?;
        let mut apply_log_skip = true;

        if !has_checkpoint {
            last_block = self.start_block.unwrap_or(0).min(head);
            last_log = 0;
            apply_log_skip = false;
            tracing::info!(
                "[chain-sync] initializing checkpoint from block {} (head={})",
                last_block,
                head
            );
        }

        if head < last_block {
            return Ok(());
        }

        let to_block = (last_block + 1000).min(head);

        let opened = self
            .makeit
            .event::<TradeOpenedFilter>()
            .from_block(last_block)
            .to_block(to_block)
            .query_with_meta()
            .await?;
        let closed = self
            .makeit
            .event::<TradeClosedFilter>()
            .from_block(last_block)
            .to_block(to_block)
            .query_with_meta()
            .await?;
        tracing::info!(
            "[chain-sync] events caught: opened={} closed={} range={}..{}",
            opened.len(),
            closed.len(),
            last_block,
            to_block
        );

        #[derive(Clone)]
        enum IndexedEvent {
            Opened { trade_id: i64, meta: LogMeta },
            Closed {
                trade_id: i64,
                meta: LogMeta,
                close: ClosedEventData,
            },
        }

        let mut events: Vec<IndexedEvent> = Vec::with_capacity(opened.len() + closed.len());
        for (ev, meta) in opened {
            events.push(IndexedEvent::Opened {
                trade_id: ev.trade_id.as_u64() as i64,
                meta,
            });
        }
        for (ev, meta) in closed {
            let close_reason = Self::close_reason_from_status_code(ev.status).to_string();
            let settlement_action = if !ev.sold_weth_for_profit.is_zero() {
                "SELL_WETH_FOR_PROFIT".to_string()
            } else if !ev.bought_weth_on_sl.is_zero() {
                "BUY_WETH_ON_SL".to_string()
            } else if !ev.payout_usdc.is_zero() {
                "USDC_POOL_PAYOUT".to_string()
            } else {
                "MARGIN_RETAINED".to_string()
            };
            events.push(IndexedEvent::Closed {
                trade_id: ev.trade_id.as_u64() as i64,
                meta,
                close: ClosedEventData {
                    close_price_e18: BigDecimal::from_str(&ev.close_price_e18.to_string())?,
                    pnl_usdc6: BigDecimal::from_str(&ev.pnl_usdc.to_string())?,
                    sold_weth18: BigDecimal::from_str(&ev.sold_weth_for_profit.to_string())?,
                    bought_weth18: BigDecimal::from_str(&ev.bought_weth_on_sl.to_string())?,
                    payout_usdc6: BigDecimal::from_str(&ev.payout_usdc.to_string())?,
                    close_reason,
                    settlement_action,
                    settlement_usdc_amount: BigDecimal::from_str(&ev.payout_usdc.to_string())?,
                    settlement_weth_amount: if !ev.sold_weth_for_profit.is_zero() {
                        BigDecimal::from_str(&ev.sold_weth_for_profit.to_string())?
                    } else if !ev.bought_weth_on_sl.is_zero() {
                        BigDecimal::from_str(&ev.bought_weth_on_sl.to_string())?
                    } else {
                        BigDecimal::from(0)
                    },
                },
            });
        }

        let had_events = !events.is_empty();
        events.sort_by_key(|ev| match ev {
            IndexedEvent::Opened { meta, .. } => (meta.block_number.as_u64(), meta.log_index.as_u64()),
            IndexedEvent::Closed { meta, .. } => (meta.block_number.as_u64(), meta.log_index.as_u64()),
        });

        let mut block_ts_cache: HashMap<u64, chrono::DateTime<Utc>> = HashMap::new();
        for ev in events {
            let (trade_id, meta_ref, close_data) = match &ev {
                IndexedEvent::Opened { trade_id, meta } => (*trade_id, meta, None),
                IndexedEvent::Closed {
                    trade_id,
                    meta,
                    close,
                } => (*trade_id, meta, Some(close.clone())),
            };
            let meta_block = meta_ref.block_number.as_u64();
            if apply_log_skip && meta_block == last_block && meta_ref.log_index.as_u64() <= last_log {
                continue;
            }

            let process_res = if let Some(close) = close_data {
                self.process_trade_closed_event(trade_id, &close, meta_ref, &mut block_ts_cache).await
            } else {
                self.process_trade_event(trade_id, meta_ref, &mut block_ts_cache).await
            };
            if let Err(e) = process_res {
                tracing::warn!("[chain-sync] process event failed for trade {}: {}", trade_id, e);
            }

            self.set_checkpoint(meta_block, meta_ref.log_index.as_u64()).await?;
            last_block = meta_block;
            last_log = meta_ref.log_index.as_u64();
        }

        if !had_events {
            self.set_checkpoint(to_block, 0).await?;
        } else if to_block > last_block {
            self.set_checkpoint(to_block, 0).await?;
        }

        Ok(())
    }

    async fn process_trade_closed_event(
        &self,
        trade_id: i64,
        close: &ClosedEventData,
        meta: &LogMeta,
        block_ts_cache: &mut HashMap<u64, chrono::DateTime<Utc>>,
    ) -> anyhow::Result<()> {
        let tx_hash = format!("{:#x}", meta.transaction_hash);
        let log_index = meta.log_index.as_u64() as i64;
        if self.is_processed(&tx_hash, log_index).await? {
            return Ok(());
        }

        let block_number = meta.block_number.as_u64();
        let closed_at_override = if let Some(ts) = block_ts_cache.get(&block_number) {
            Some(*ts)
        } else {
            let fetched = self
                .makeit
                .client()
                .get_block(block_number)
                .await?
                .and_then(|b| chrono::DateTime::<Utc>::from_timestamp(b.timestamp.as_u64() as i64, 0))
                .unwrap_or_else(Utc::now);
            block_ts_cache.insert(block_number, fetched);
            Some(fetched)
        };

        let (wallet, trade_json, is_closed) = self
            .upsert_trade(
                trade_id,
                closed_at_override,
                Some(close.clone()),
                None,
                None,
                Some(tx_hash.clone()),
                Some(block_number as i64),
            )
            .await?;
        self.mark_processed(&tx_hash, log_index, block_number as i64).await?;
        tracing::info!(
            "[chain-sync] trade closed seen: tradeId={} wallet={} reason={} tx={} block={} logIndex={}",
            trade_id,
            wallet,
            close.close_reason,
            tx_hash,
            block_number,
            log_index
        );

        let event_name = if is_closed { "trade_closed" } else { "trade_upsert" };
        let evt = self.realtime.make_event(
            event_name,
            Some(&wallet),
            serde_json::json!({
                "trade": trade_json,
                "txHash": tx_hash,
                "logIndex": log_index,
                "blockNumber": block_number,
            }),
        );
        self.realtime.publish_wallet(&wallet, &evt).await;
        let _ = self
            .cache
            .publish_json(&format!("stream:user:{}", wallet.to_lowercase()), &evt)
            .await;

        Ok(())
    }
}
