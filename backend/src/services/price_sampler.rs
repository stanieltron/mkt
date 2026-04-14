use crate::bindings::Oracle;
use crate::lib::cache::CacheService;
use crate::services::realtime::RealtimeHub;
use bigdecimal::BigDecimal;
use ethers::providers::{Http, Provider};
use sqlx::PgPool;
use std::str::FromStr;
use std::sync::Arc;
use tokio::time::{interval, Duration};

pub struct PriceSamplerService {
    pool: PgPool,
    oracle: Oracle<Provider<Http>>,
    poll_ms: u64,
    cache: Arc<CacheService>,
    realtime: Arc<RealtimeHub>,
}

impl PriceSamplerService {
    pub fn new(
        pool: PgPool,
        oracle: Oracle<Provider<Http>>,
        poll_ms: u64,
        cache: Arc<CacheService>,
        realtime: Arc<RealtimeHub>,
    ) -> Self {
        Self {
            pool,
            oracle,
            poll_ms,
            cache,
            realtime,
        }
    }

    pub fn start(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut ticker = interval(Duration::from_millis(self.poll_ms));
            loop {
                ticker.tick().await;
                match self.oracle.get_price_e18().call().await {
                    Ok(price) => {
                        let raw = BigDecimal::from_str(&price.to_string()).unwrap_or_default();
                        let ts = chrono::Utc::now();
                        let ts_ms = ts.timestamp_millis();
                        let price_str = raw.to_string();
                        if let Err(e) = sqlx::query(r#"INSERT INTO "PriceSample" (price) VALUES ($1)"#)
                            .bind(&raw)
                            .execute(&self.pool)
                            .await
                        {
                            tracing::error!("[price-sampler] DB insert failed: {}", e);
                        }
                        let latest = serde_json::json!({
                            "price": price_str,
                            "timestamp": ts.to_rfc3339(),
                        });
                        if let Err(e) = self.cache.set_json("price:latest", &latest, None).await {
                            tracing::warn!("[price-sampler] redis latest set failed: {}", e);
                        }
                        if let Err(e) = self.cache.add_price_sample(ts_ms, latest["price"].as_str().unwrap_or("0")).await {
                            tracing::warn!("[price-sampler] redis sample add failed: {}", e);
                        }
                        let evt = self.realtime.make_event("price_tick", None, latest.clone());
                        self.realtime.publish_global(&evt);
                        if let Err(e) = self.cache.publish_json("stream:price", &evt).await {
                            tracing::warn!("[price-sampler] redis publish failed: {}", e);
                        }
                    }
                    Err(e) => tracing::warn!("[price-sampler] oracle read failed: {}", e),
                }
            }
        });
    }
}
