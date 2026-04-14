#![allow(special_module_name)]

pub mod bindings;
pub mod db;
pub mod lib;
pub mod routes;
pub mod services;

use crate::bindings::{Makeit, Oracle};
use crate::lib::cache::CacheService;
use crate::lib::config::Env;
use crate::services::chain_sync::ChainSyncService;
use crate::services::liquidation_bot::LiquidationBotService;
use crate::services::price_sampler::PriceSamplerService;
use crate::services::realtime::RealtimeHub;
use crate::services::swap_runner::SwapRunnerService;
use crate::services::user_service::UserService;
use ethers::middleware::{NonceManagerMiddleware, SignerMiddleware};
use ethers::providers::{Http, Provider};
use ethers::signers::{LocalWallet, Signer};
use ethers::types::Address;
use std::convert::TryFrom;
use std::str::FromStr;
use std::sync::Arc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    dotenvy::dotenv().ok();

    let env = Env::from_env()?;

    tracing::info!("[backend] Connecting to Postgres...");
    let pool = db::connect().await?;

    tracing::info!("[backend] Connecting to RPC: {}", env.rpc_url);
    let provider = Arc::new(Provider::<Http>::try_from(env.rpc_url.as_str())?);

    let makeit_addr = Address::from_str(&env.makeit_address)?;
    let oracle_addr  = Address::from_str(&env.oracle_address)?;

    let oracle_read = Oracle::new(oracle_addr, provider.clone());
    let makeit_read = Makeit::new(makeit_addr, provider.clone());

    let user_service = UserService::new(pool.clone());
    let cache = Arc::new(CacheService::new(&env.redis_url)?);
    let realtime = Arc::new(RealtimeHub::new());

    // Price sampler
    let price_sampler = Arc::new(PriceSamplerService::new(
        pool.clone(),
        oracle_read.clone(),
        env.price_poll_ms,
        cache.clone(),
        realtime.clone(),
    ));
    price_sampler.start();
    tracing::info!("[price-sampler] started ({}ms)", env.price_poll_ms);

    // Chain sync indexer
    let sync_key = format!("trades_last_seen_id:default:{}", env.makeit_address.to_lowercase());
    let chain_sync = ChainSyncService::new(
        pool.clone(),
        makeit_read.clone(),
        user_service.clone(),
        env.events_poll_ms,
        sync_key,
        cache.clone(),
        realtime.clone(),
    );
    chain_sync.clone().start();
    tracing::info!("[chain-sync] started ({}ms)", env.events_poll_ms);
    let mut liquidation_bot: Option<Arc<LiquidationBotService>> = None;

    // Swap runner stub - only in local/dev mode
    if !env.public_mode {
        SwapRunnerService::new().start();
        tracing::info!("[swap-runner] started");
    }

    // Liquidation bot (requires bot signer)
    if let Some(bot_pk) = &env.bot_private_key {
        let wallet = LocalWallet::from_str(bot_pk)?.with_chain_id(env.chain_id);
        let signer = SignerMiddleware::new((*provider).clone(), wallet);
        let signer_addr = signer.address();
        let nonce_managed = NonceManagerMiddleware::new(signer, signer_addr);
        let signer = Arc::new(nonce_managed);
        let makeit_bot = Makeit::new(makeit_addr, signer.clone());
        let bot = LiquidationBotService::new(
            pool.clone(),
            oracle_read.clone(),
            makeit_bot,
            signer_addr,
            chain_sync.clone(),
            env.liquidation_bot_interval_ms,
        );
        bot.clone().start();
        liquidation_bot = Some(bot);
        tracing::info!("[liquidation-bot] started ({}ms)", env.liquidation_bot_interval_ms);
    } else {
        tracing::warn!("[liquidation-bot] BOT_PRIVATE_KEY not set — disabled");
    }

    // Axum HTTP server
    let app = routes::setup_router(
        pool.clone(),
        user_service,
        env.admin_username.clone(),
        env.admin_password.clone(),
        Some(chain_sync.clone()),
        liquidation_bot,
        cache.clone(),
        realtime.clone(),
    );
    let addr = format!("0.0.0.0:{}", env.port);
    tracing::info!("[backend] listening on http://{}", addr);
    axum::serve(tokio::net::TcpListener::bind(&addr).await?, app.into_make_service()).await?;

    Ok(())
}
