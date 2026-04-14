use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

#[derive(Clone)]
pub struct RealtimeHub {
    global_tx: broadcast::Sender<String>,
    user_channels: Arc<RwLock<HashMap<String, broadcast::Sender<String>>>>,
    seq: Arc<AtomicU64>,
}

impl RealtimeHub {
    pub fn new() -> Self {
        let (global_tx, _) = broadcast::channel(4096);
        Self {
            global_tx,
            user_channels: Arc::new(RwLock::new(HashMap::new())),
            seq: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn subscribe_global(&self) -> broadcast::Receiver<String> {
        self.global_tx.subscribe()
    }

    pub async fn subscribe_wallet(&self, wallet: &str) -> broadcast::Receiver<String> {
        let key = wallet.to_lowercase();
        {
            let map = self.user_channels.read().await;
            if let Some(tx) = map.get(&key) {
                return tx.subscribe();
            }
        }
        let mut map = self.user_channels.write().await;
        if let Some(tx) = map.get(&key) {
            return tx.subscribe();
        }
        let (tx, _) = broadcast::channel(1024);
        map.insert(key, tx.clone());
        tx.subscribe()
    }

    pub fn make_event(&self, event_type: &str, wallet: Option<&str>, payload: Value) -> Value {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        serde_json::json!({
            "event": event_type,
            "wallet": wallet.map(|w| w.to_lowercase()),
            "seq": seq,
            "ts": chrono::Utc::now().to_rfc3339(),
            "payload": payload,
        })
    }

    pub fn publish_global(&self, event: &Value) {
        if let Ok(raw) = serde_json::to_string(event) {
            let _ = self.global_tx.send(raw);
        }
    }

    pub async fn publish_wallet(&self, wallet: &str, event: &Value) {
        let key = wallet.to_lowercase();
        let tx = {
            let mut map = self.user_channels.write().await;
            map.entry(key)
                .or_insert_with(|| {
                    let (tx, _) = broadcast::channel(1024);
                    tx
                })
                .clone()
        };
        if let Ok(raw) = serde_json::to_string(event) {
            let _ = tx.send(raw);
        }
    }
}
