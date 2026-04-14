use bigdecimal::BigDecimal;
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// TradeStatus mirrors the Postgres ENUM exactly.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::Type, PartialEq, Eq)]
#[sqlx(type_name = "TradeStatus", rename_all = "SCREAMING_SNAKE_CASE")]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TradeStatus {
    Open,
    Closed,
    Liquidated,
}

/// On-chain values are stored as raw integers in Postgres DECIMAL(78,0),
/// then mapped to BigDecimal in Rust to avoid floating-point loss.
/// Human-readable unit conversion is done in the frontend display layer.


#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: i32,
    #[sqlx(rename = "walletAddress")]
    #[serde(rename = "walletAddress")]
    pub wallet_address: String,
    #[sqlx(rename = "referralCode")]
    #[serde(rename = "referralCode")]
    pub referral_code: String,
    #[sqlx(rename = "referredBy")]
    #[serde(rename = "referredBy")]
    pub referred_by: Option<i32>,
    #[sqlx(rename = "createdAt")]
    #[serde(rename = "createdAt")]
    pub created_at: NaiveDateTime,
    #[sqlx(rename = "totalTradingVolume")]
    #[serde(rename = "totalTradingVolume")]
    pub total_trading_volume: BigDecimal,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Trade {
    pub id: i32,
    #[sqlx(rename = "onChainTradeId")]
    #[serde(rename = "onChainTradeId")]
    pub on_chain_trade_id: i64,
    #[sqlx(rename = "userId")]
    #[serde(rename = "userId")]
    pub user_id: i32,
    pub direction: String,
    pub leverage: i32,
    pub margin: BigDecimal,
    #[sqlx(rename = "entryPrice")]
    #[serde(rename = "entryPrice")]
    pub entry_price: BigDecimal,
    #[sqlx(rename = "tpPrice")]
    #[serde(rename = "tpPrice")]
    pub tp_price: BigDecimal,
    #[sqlx(rename = "slPrice")]
    #[serde(rename = "slPrice")]
    pub sl_price: BigDecimal,
    #[sqlx(rename = "exitPrice")]
    #[serde(rename = "exitPrice")]
    pub exit_price: Option<BigDecimal>,
    #[sqlx(rename = "soldWeth")]
    #[serde(rename = "soldWeth")]
    pub sold_weth: Option<BigDecimal>,
    #[sqlx(rename = "boughtWeth")]
    #[serde(rename = "boughtWeth")]
    pub bought_weth: Option<BigDecimal>,
    pub status: TradeStatus,
    pub pnl: Option<BigDecimal>,
    #[sqlx(rename = "createdAt")]
    #[serde(rename = "createdAt")]
    pub created_at: NaiveDateTime,
    #[sqlx(rename = "closedAt")]
    #[serde(rename = "closedAt")]
    pub closed_at: Option<NaiveDateTime>,
    #[sqlx(rename = "openTxHash")]
    #[serde(rename = "openTxHash")]
    pub open_tx_hash: Option<String>,
    #[sqlx(rename = "openBlockNumber")]
    #[serde(rename = "openBlockNumber")]
    pub open_block_number: Option<i64>,
    #[sqlx(rename = "closeTxHash")]
    #[serde(rename = "closeTxHash")]
    pub close_tx_hash: Option<String>,
    #[sqlx(rename = "closeBlockNumber")]
    #[serde(rename = "closeBlockNumber")]
    pub close_block_number: Option<i64>,
    #[sqlx(rename = "closeReason")]
    #[serde(rename = "closeReason")]
    pub close_reason: Option<String>,
    #[sqlx(rename = "payoutUsdc")]
    #[serde(rename = "payoutUsdc")]
    pub payout_usdc: Option<BigDecimal>,
    #[sqlx(rename = "settlementAction")]
    #[serde(rename = "settlementAction")]
    pub settlement_action: Option<String>,
    #[sqlx(rename = "settlementUsdcAmount")]
    #[serde(rename = "settlementUsdcAmount")]
    pub settlement_usdc_amount: Option<BigDecimal>,
    #[sqlx(rename = "settlementWethAmount")]
    #[serde(rename = "settlementWethAmount")]
    pub settlement_weth_amount: Option<BigDecimal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PriceSample {
    pub id: i32,
    pub price: BigDecimal,
    pub timestamp: NaiveDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct AppState {
    pub key: String,
    pub value: String,
    #[sqlx(rename = "updatedAt")]
    #[serde(rename = "updatedAt")]
    pub updated_at: NaiveDateTime,
}
