use crate::services::chain_sync::ChainSyncService;
use bigdecimal::BigDecimal;
use ethers::middleware::SignerMiddleware;
use ethers::providers::{Http, Provider};
use ethers::signers::LocalWallet;
use ethers::types::U256;
use crate::bindings::{Makeit, Oracle};
use sqlx::PgPool;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::Duration;

pub struct LiquidationBotService {
    pool: PgPool,
    oracle: Oracle<Provider<Http>>,
    makeit_bot: Arc<Makeit<SignerMiddleware<Provider<Http>, LocalWallet>>>,
    chain_sync: Arc<ChainSyncService>,
    pub interval_ms: Arc<Mutex<u64>>,
    in_flight: Arc<Mutex<HashSet<i64>>>,
}

impl LiquidationBotService {
    pub fn new(
        pool: PgPool,
        oracle: Oracle<Provider<Http>>,
        makeit_bot: Makeit<SignerMiddleware<Provider<Http>, LocalWallet>>,
        chain_sync: Arc<ChainSyncService>,
        interval_ms: u64,
    ) -> Arc<Self> {
        Arc::new(Self {
            pool,
            oracle,
            makeit_bot: Arc::new(makeit_bot),
            chain_sync,
            interval_ms: Arc::new(Mutex::new(interval_ms)),
            in_flight: Arc::new(Mutex::new(HashSet::new())),
        })
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

            let makeit = self.makeit_bot.clone();
            let tracker = self.in_flight.clone();
            let chain_sync = self.chain_sync.clone();

            tokio::spawn(async move {
                match makeit.liquidate_trade(U256::from(trade_id as u64)).send().await {
                    Ok(pending) => match pending.await {
                        Ok(Some(r)) => {
                            tracing::info!("[bot] liquidated {}: {:?}", trade_id, r.transaction_hash);
                            if let Err(e) = chain_sync.sync_trade(trade_id).await {
                                tracing::warn!("[bot] post-liquidation sync failed for {}: {}", trade_id, e);
                            }
                        }
                        Ok(None) => tracing::warn!("[bot] tx dropped for {}", trade_id),
                        Err(e) => tracing::error!("[bot] receipt err {}: {:?}", trade_id, e),
                    },
                    Err(e) => tracing::warn!("[bot] revert {}: {:?}", trade_id, e),
                }
                tracker.lock().await.remove(&trade_id);
            });
        }
        Ok(())
    }
}
