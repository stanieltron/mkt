use anyhow::{Context, Result};
use std::env;

#[derive(Debug, Clone)]
pub struct Env {
    pub port: u16,
    pub rpc_url: String,
    pub chain_id: u64,
    pub database_url: String,
    pub makeit_address: String,
    pub oracle_address: String,
    pub swap_adapter_address: String,
    pub pool_address: String,
    pub runner_private_key: Option<String>,
    pub bot_private_key: Option<String>,
    pub lp_fee_ppm: u32,
    pub protocol_fee_ppm: u32,
    pub liquidation_bot_interval_ms: u64,
    pub price_poll_ms: u64,
    pub events_poll_ms: u64,
    pub redis_url: String,
    pub admin_username: String,
    pub admin_password: String,
    pub public_mode: bool,
}

impl Env {
    pub fn from_env() -> Result<Self> {
        let public_mode = env::var("PUBLIC_MODE").unwrap_or_else(|_| "false".into()).parse::<bool>().unwrap_or(false);
        Ok(Self {
            port: env::var("PORT").unwrap_or_else(|_| "8787".into()).parse().unwrap_or(8787),
            rpc_url: env::var("RPC_URL").context("RPC_URL required")?,
            chain_id: env::var("CHAIN_ID").unwrap_or_else(|_| "31337".into()).parse().unwrap_or(31337),
            database_url: env::var("DATABASE_URL").context("DATABASE_URL required")?,
            makeit_address: env::var("MAKEIT_ADDRESS").context("MAKEIT_ADDRESS required")?,
            oracle_address: env::var("ORACLE_ADDRESS").context("ORACLE_ADDRESS required")?,
            swap_adapter_address: env::var("SWAP_ADAPTER_ADDRESS").context("SWAP_ADAPTER_ADDRESS required")?,
            pool_address: env::var("UNISWAP_POOL_ADDRESS").context("UNISWAP_POOL_ADDRESS required")?,
            runner_private_key: env::var("RUNNER_PRIVATE_KEY").ok().filter(|s| !s.is_empty()),
            bot_private_key: env::var("BOT_PRIVATE_KEY").ok().filter(|s| !s.is_empty()),
            lp_fee_ppm: env::var("LP_FEE_PPM").unwrap_or_else(|_| "70".into()).parse().unwrap_or(70),
            protocol_fee_ppm: env::var("PROTOCOL_FEE_PPM").unwrap_or_else(|_| "30".into()).parse().unwrap_or(30),
            liquidation_bot_interval_ms: env::var("LIQUIDATION_BOT_INTERVAL_MS").unwrap_or_else(|_| "2000".into()).parse().unwrap_or(2000),
            price_poll_ms: env::var("PRICE_POLL_MS").unwrap_or_else(|_| "1000".into()).parse().unwrap_or(1000),
            events_poll_ms: env::var("EVENTS_POLL_MS").unwrap_or_else(|_| "2000".into()).parse().unwrap_or(2000),
            redis_url: env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".into()),
            admin_username: env::var("ADMIN_USERNAME").unwrap_or_else(|_| "admin".into()),
            admin_password: env::var("ADMIN_PASSWORD").unwrap_or_else(|_| "admin123".into()),
            public_mode,
        })
    }
}
