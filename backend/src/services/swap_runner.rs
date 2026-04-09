use std::sync::Arc;

pub struct SwapRunnerService {
    pub enabled: bool,
    pub interval_ms: u64,
}

impl SwapRunnerService {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            enabled: false,
            interval_ms: 1000,
        })
    }
    
    pub fn start(self: Arc<Self>) {
        // Simulation Runner logic natively bound
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_millis(self.interval_ms)).await;
                if self.enabled {
                    tracing::info!("[swap-runner] Simulation tick");
                }
            }
        });
    }
}
