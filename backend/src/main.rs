#![allow(special_module_name)]

pub mod bindings;
pub mod db;
pub mod lib;
pub mod routes;
pub mod services;

use crate::bindings::{Makeit, Oracle};
use crate::lib::config::Env;
use crate::services::chain_sync::ChainSyncService;
use crate::services::liquidation_bot::LiquidationBotService;
use crate::services::price_sampler::PriceSamplerService;
use crate::services::swap_runner::SwapRunnerService;
use crate::services::user_service::UserService;
use ethers::middleware::SignerMiddleware;
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

    // Price sampler
    let price_sampler = Arc::new(PriceSamplerService::new(pool.clone(), oracle_read.clone(), env.price_poll_ms));
    price_sampler.start();
    tracing::info!("[price-sampler] started ({}ms)", env.price_poll_ms);

    // Chain sync indexer
    let sync_key = format!("trades_last_seen_id:default:{}", env.makeit_address.to_lowercase());
    let chain_sync = ChainSyncService::new(pool.clone(), makeit_read.clone(), user_service.clone(), env.events_poll_ms, sync_key);
    chain_sync.clone().start();
    tracing::info!("[chain-sync] started ({}ms)", env.events_poll_ms);

    // Swap runner stub - only in local/dev mode
    if !env.public_mode {
        SwapRunnerService::new().start();
        tracing::info!("[swap-runner] started");
    }

    // Liquidation bot (requires bot signer)
    if let Some(bot_pk) = &env.bot_private_key {
        let wallet = LocalWallet::from_str(bot_pk)?.with_chain_id(env.chain_id);
        let signer = Arc::new(SignerMiddleware::new((*provider).clone(), wallet));
        let makeit_bot = Makeit::new(makeit_addr, signer);
        let bot = LiquidationBotService::new(
            pool.clone(),
            oracle_read.clone(),
            makeit_bot,
            chain_sync.clone(),
            env.liquidation_bot_interval_ms,
        );
        bot.start();
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
    );
    let addr = format!("0.0.0.0:{}", env.port);
    tracing::info!("[backend] listening on http://{}", addr);
    axum::serve(tokio::net::TcpListener::bind(&addr).await?, app.into_make_service()).await?;

    Ok(())
}
