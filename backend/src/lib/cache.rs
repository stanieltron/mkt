use redis::AsyncCommands;
use serde_json::Value;

#[derive(Clone)]
pub struct CacheService {
    client: redis::Client,
}

impl CacheService {
    pub fn new(redis_url: &str) -> anyhow::Result<Self> {
        let client = redis::Client::open(redis_url)?;
        Ok(Self { client })
    }

    async fn conn(&self) -> anyhow::Result<redis::aio::MultiplexedConnection> {
        Ok(self.client.get_multiplexed_async_connection().await?)
    }

    pub async fn set_json(&self, key: &str, value: &Value, ttl_seconds: Option<u64>) -> anyhow::Result<()> {
        let mut conn = self.conn().await?;
        let payload = serde_json::to_string(value)?;
        match ttl_seconds {
            Some(ttl) => {
                let _: () = conn.set_ex(key, payload, ttl).await?;
            }
            None => {
                let _: () = conn.set(key, payload).await?;
            }
        }
        Ok(())
    }

    pub async fn get_json(&self, key: &str) -> anyhow::Result<Option<Value>> {
        let mut conn = self.conn().await?;
        let raw: Option<String> = conn.get(key).await?;
        match raw {
            Some(text) => Ok(serde_json::from_str(&text).ok()),
            None => Ok(None),
        }
    }

    pub async fn publish_json(&self, channel: &str, value: &Value) -> anyhow::Result<()> {
        let mut conn = self.conn().await?;
        let payload = serde_json::to_string(value)?;
        let _: () = conn.publish(channel, payload).await?;
        Ok(())
    }

    pub async fn add_price_sample(&self, ts_ms: i64, price: &str) -> anyhow::Result<()> {
        let mut conn = self.conn().await?;
        let key = "price:samples";
        let sample = serde_json::json!({
            "tsMs": ts_ms,
            "price": price,
        });
        let payload = serde_json::to_string(&sample)?;
        let _: () = redis::cmd("ZADD")
            .arg(key)
            .arg(ts_ms)
            .arg(payload)
            .query_async(&mut conn)
            .await?;

        // Keep only a rolling 2-day window to bound memory.
        let cutoff = ts_ms - (2 * 24 * 60 * 60 * 1000);
        let _: () = redis::cmd("ZREMRANGEBYSCORE")
            .arg(key)
            .arg(0)
            .arg(cutoff)
            .query_async(&mut conn)
            .await?;

        Ok(())
    }

    pub async fn get_price_samples_since(&self, since_ms: i64) -> anyhow::Result<Vec<Value>> {
        let mut conn = self.conn().await?;
        let rows: Vec<String> = redis::cmd("ZRANGEBYSCORE")
            .arg("price:samples")
            .arg(since_ms)
            .arg("+inf")
            .query_async(&mut conn)
            .await?;

        Ok(rows
            .into_iter()
            .filter_map(|raw| serde_json::from_str::<Value>(&raw).ok())
            .collect())
    }
}
