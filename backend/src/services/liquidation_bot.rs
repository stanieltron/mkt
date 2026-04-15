use crate::services::chain_sync::ChainSyncService;
use bigdecimal::BigDecimal;
use chrono::Utc;
use ethers::middleware::{NonceManagerMiddleware, SignerMiddleware};
use ethers::providers::Middleware;
use ethers::providers::{Http, Provider};
use ethers::signers::LocalWallet;
use ethers::types::{Address, BlockNumber, U256};
use crate::bindings::{Makeit, Oracle};
use serde::Serialize;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::Duration;
use std::time::{Duration as StdDuration, Instant};

type BotMiddleware = NonceManagerMiddleware<SignerMiddleware<Provider<Http>, LocalWallet>>;
const BOT_LOG_CAPACITY: usize = 2000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotLogEntry {
    pub ts: String,
    pub trade_id: i64,
    pub attempt: u8,
    pub nonce: Option<String>,
    pub target_price: String,
    pub price_at_fire: String,
    pub tx_hash: Option<String>,
    pub status: String,
    pub error: Option<String>,
}

pub struct LiquidationBotService {
    pool: PgPool,
    oracle: Oracle<Provider<Http>>,
    makeit_bot: Arc<Makeit<BotMiddleware>>,
    bot_address: Address,
    chain_sync: Arc<ChainSyncService>,
    pub interval_ms: Arc<Mutex<u64>>,
    in_flight: Arc<Mutex<HashSet<i64>>>,
    recently_submitted: Arc<Mutex<HashMap<i64, Instant>>>,
    next_nonce: Arc<Mutex<Option<U256>>>,
    logs: Arc<Mutex<VecDeque<BotLogEntry>>>,
}

impl LiquidationBotService {
    pub fn new(
        pool: PgPool,
        oracle: Oracle<Provider<Http>>,
        makeit_bot: Makeit<BotMiddleware>,
        bot_address: Address,
        chain_sync: Arc<ChainSyncService>,
        interval_ms: u64,
    ) -> Arc<Self> {
        Arc::new(Self {
            pool,
            oracle,
            makeit_bot: Arc::new(makeit_bot),
            bot_address,
            chain_sync,
            interval_ms: Arc::new(Mutex::new(interval_ms)),
            in_flight: Arc::new(Mutex::new(HashSet::new())),
            recently_submitted: Arc::new(Mutex::new(HashMap::new())),
            next_nonce: Arc::new(Mutex::new(None)),
            logs: Arc::new(Mutex::new(VecDeque::new())),
        })
    }

    async fn push_log(
        &self,
        trade_id: i64,
        attempt: u8,
        nonce: Option<U256>,
        target_price: U256,
        price_at_fire: U256,
        tx_hash: Option<String>,
        status: &str,
        error: Option<String>,
    ) {
        let mut logs = self.logs.lock().await;
        logs.push_back(BotLogEntry {
            ts: Utc::now().to_rfc3339(),
            trade_id,
            attempt,
            nonce: nonce.map(|v| v.to_string()),
            target_price: target_price.to_string(),
            price_at_fire: price_at_fire.to_string(),
            tx_hash,
            status: status.to_string(),
            error,
        });
        while logs.len() > BOT_LOG_CAPACITY {
            logs.pop_front();
        }
    }

    pub async fn recent_logs(&self, limit: usize) -> Vec<BotLogEntry> {
        let cap = limit.clamp(1, BOT_LOG_CAPACITY);
        let logs = self.logs.lock().await;
        logs.iter().rev().take(cap).cloned().collect()
    }

    async fn reserve_nonce(&self) -> anyhow::Result<U256> {
        let mut guard = self.next_nonce.lock().await;
        if let Some(current) = *guard {
            *guard = Some(current + U256::one());
            return Ok(current);
        }

        let pending = self
            .makeit_bot
            .client()
            .get_transaction_count(self.bot_address, Some(BlockNumber::Pending.into()))
            .await?;
        *guard = Some(pending + U256::one());
        Ok(pending)
    }

    async fn reset_nonce_cursor(&self) {
        let mut guard = self.next_nonce.lock().await;
        *guard = None;
    }

    pub fn start(self: Arc<Self>) {
        tokio::spawn(async move {
            loop {
                let ms = *self.interval_ms.lock().await;
                tokio::time::sleep(Duration::from_millis(ms)).await;
                if let Err(e) = self.tick().await {
                    tracing::error!("[liquidation-bot] tick error: {}", e);
                }
            }
        });
    }

    async fn tick(&self) -> anyhow::Result<()> {
        let price_e18: U256 = self.oracle.get_price_e18().call().await?;

        #[derive(sqlx::FromRow)]
        struct OpenTrade {
            #[sqlx(rename = "onChainTradeId")]
            on_chain_trade_id: i64,
            #[sqlx(rename = "tpPrice")]
            tp_price: BigDecimal,
            #[sqlx(rename = "slPrice")]
            sl_price: BigDecimal,
        }

        let open_trades: Vec<OpenTrade> = sqlx::query_as(
            r#"SELECT "onChainTradeId", "tpPrice", "slPrice"
               FROM "Trade"
               WHERE status = 'OPEN'
                 AND "onChainTradeId" > 0
                 AND "tpPrice" > 0
                 AND "slPrice" > 0
               ORDER BY id ASC
               LIMIT 1000"#
        ).fetch_all(&self.pool).await?;

        for trade in open_trades {
            let trade_id = trade.on_chain_trade_id;
            {
                let mut submitted = self.recently_submitted.lock().await;
                submitted.retain(|_, at| at.elapsed() < StdDuration::from_secs(30));
                if submitted.contains_key(&trade_id) {
                    continue;
                }
            }
            let mut in_flight = self.in_flight.lock().await;
            if in_flight.contains(&trade_id) { continue; }

            // Convert BigDecimal back to U256 for comparison with oracle U256 price
            let tp: U256 = U256::from_dec_str(&trade.tp_price.to_string().split('.').next().unwrap_or("0")).unwrap_or_default();
            let sl: U256 = U256::from_dec_str(&trade.sl_price.to_string().split('.').next().unwrap_or("0")).unwrap_or_default();
            let lower = tp.min(sl);
            let upper = tp.max(sl);

            if price_e18 > lower && price_e18 < upper { continue; }

            in_flight.insert(trade_id);
            drop(in_flight);

            let svc = Arc::new(self.clone_for_task());
            let tracker = self.in_flight.clone();
            let price_at_fire = price_e18;
            let target_price = if price_at_fire <= lower { lower } else { upper };

            tokio::spawn(async move {
                let mut sent = false;
                for attempt in 1..=3 {
                    let nonce = match svc.reserve_nonce().await {
                        Ok(v) => v,
                        Err(e) => {
                            tracing::warn!("[bot] nonce reserve failed {}: {}", trade_id, e);
                            svc.push_log(
                                trade_id,
                                attempt,
                                None,
                                target_price,
                                price_at_fire,
                                None,
                                "NONCE_RESERVE_FAILED",
                                Some(e.to_string()),
                            ).await;
                            break;
                        }
                    };
                    svc.push_log(
                        trade_id,
                        attempt,
                        Some(nonce),
                        target_price,
                        price_at_fire,
                        None,
                        "TX_SEND_ATTEMPT",
                        None,
                    ).await;

                    match svc
                        .makeit_bot
                        .liquidate_trade(U256::from(trade_id as u64))
                        .nonce(nonce)
                        .send()
                        .await
                    {
                        Ok(pending) => {
                            sent = true;
                            match pending.await {
                                Ok(Some(r)) => {
                                    let ok = r.status.map(|s| s.as_u64() == 1).unwrap_or(true);
                                    if ok {
                                        let mut submitted = svc.recently_submitted.lock().await;
                                        submitted.insert(trade_id, Instant::now());
                                        if let Err(e) = svc.chain_sync.sync_trade(trade_id).await {
                                            tracing::warn!("[bot] sync_trade after liquidation {} failed: {}", trade_id, e);
                                        }
                                    }
                                    svc.push_log(
                                        trade_id,
                                        attempt,
                                        Some(nonce),
                                        target_price,
                                        price_at_fire,
                                        Some(format!("{:#x}", r.transaction_hash)),
                                        if ok { "MINED_OK" } else { "MINED_FAIL" },
                                        None,
                                    ).await;
                                    tracing::info!(
                                        "[bot] liquidation receipt {}: {:?} nonce={} status={}",
                                        trade_id,
                                        r.transaction_hash,
                                        nonce,
                                        if ok { "ok" } else { "failed" }
                                    );
                                }
                                Ok(None) => {
                                    svc.push_log(
                                        trade_id,
                                        attempt,
                                        Some(nonce),
                                        target_price,
                                        price_at_fire,
                                        None,
                                        "DROPPED",
                                        None,
                                    ).await;
                                    tracing::warn!("[bot] tx dropped for {} nonce={}", trade_id, nonce)
                                }
                                Err(e) => {
                                    svc.push_log(
                                        trade_id,
                                        attempt,
                                        Some(nonce),
                                        target_price,
                                        price_at_fire,
                                        None,
                                        "RECEIPT_ERROR",
                                        Some(format!("{:?}", e)),
                                    ).await;
                                    tracing::error!("[bot] receipt err {} nonce={} {:?}", trade_id, nonce, e)
                                }
                            }
                            break;
                        }
                        Err(e) => {
                            let text = format!("{:?}", e).to_lowercase();
                            let is_nonce_err = text.contains("nonce too low")
                                || text.contains("nonce has already been used")
                                || text.contains("replacement transaction underpriced");
                            let is_trade_not_open = text.contains("0x3ccdfa11")
                                || text.contains("tradenotopen");
                            if is_nonce_err && attempt < 3 {
                                tracing::warn!(
                                    "[bot] nonce drift {} attempt={} nonce={} -> resync",
                                    trade_id,
                                    attempt,
                                    nonce
                                );
                                svc.push_log(
                                    trade_id,
                                    attempt,
                                    Some(nonce),
                                    target_price,
                                    price_at_fire,
                                    None,
                                    "NONCE_DRIFT",
                                    Some(format!("{:?}", e)),
                                ).await;
                                svc.reset_nonce_cursor().await;
                                continue;
                            }
                            if is_trade_not_open {
                                sent = true;
                                {
                                    let mut submitted = svc.recently_submitted.lock().await;
                                    submitted.insert(trade_id, Instant::now());
                                }
                                if let Err(sync_err) = svc.chain_sync.sync_trade(trade_id).await {
                                    tracing::warn!(
                                        "[bot] sync_trade for already-not-open {} failed: {}",
                                        trade_id,
                                        sync_err
                                    );
                                }
                                svc.push_log(
                                    trade_id,
                                    attempt,
                                    Some(nonce),
                                    target_price,
                                    price_at_fire,
                                    None,
                                    "SKIP_NOT_OPEN",
                                    Some(format!("{:?}", e)),
                                ).await;
                                tracing::info!(
                                    "[bot] skip {} nonce={} attempt={} (already not open)",
                                    trade_id,
                                    nonce,
                                    attempt
                                );
                                break;
                            }
                            svc.push_log(
                                trade_id,
                                attempt,
                                Some(nonce),
                                target_price,
                                price_at_fire,
                                None,
                                "SEND_REVERT",
                                Some(format!("{:?}", e)),
                            ).await;
                            tracing::warn!("[bot] revert {} nonce={} attempt={} : {:?}", trade_id, nonce, attempt, e);
                            break;
                        }
                    }
                }
                if !sent {
                    svc.push_log(
                        trade_id,
                        0,
                        None,
                        target_price,
                        price_at_fire,
                        None,
                        "NOT_SENT",
                        None,
                    ).await;
                    tracing::warn!("[bot] liquidation not sent for {}", trade_id);
                }
                tracker.lock().await.remove(&trade_id);
            });
        }
        Ok(())
    }

    fn clone_for_task(&self) -> Self {
        Self {
            pool: self.pool.clone(),
            oracle: self.oracle.clone(),
            makeit_bot: self.makeit_bot.clone(),
            bot_address: self.bot_address,
            chain_sync: self.chain_sync.clone(),
            interval_ms: self.interval_ms.clone(),
            in_flight: self.in_flight.clone(),
            recently_submitted: self.recently_submitted.clone(),
            next_nonce: self.next_nonce.clone(),
            logs: self.logs.clone(),
        }
    }
}
