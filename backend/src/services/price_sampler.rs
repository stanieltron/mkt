use crate::bindings::Oracle;
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
}

impl PriceSamplerService {
    pub fn new(pool: PgPool, oracle: Oracle<Provider<Http>>, poll_ms: u64) -> Self {
        Self { pool, oracle, poll_ms }
    }

    pub fn start(self: Arc<Self>) {
        tokio::spawn(async move {
            let mut ticker = interval(Duration::from_millis(self.poll_ms));
            loop {
                ticker.tick().await;
                match self.oracle.get_price_e18().call().await {
                    Ok(price) => {
                        let raw = BigDecimal::from_str(&price.to_string()).unwrap_or_default();
                        if let Err(e) = sqlx::query(r#"INSERT INTO "PriceSample" (price) VALUES ($1)"#)
                            .bind(&raw)
                            .execute(&self.pool)
                            .await
                        {
                            tracing::error!("[price-sampler] DB insert failed: {}", e);
                        }
                    }
                    Err(e) => tracing::warn!("[price-sampler] oracle read failed: {}", e),
                }
            }
        });
    }
}
