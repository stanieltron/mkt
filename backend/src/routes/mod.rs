use crate::db::models::{Trade, TradeStatus};
use crate::lib::cache::CacheService;
use crate::lib::utils::{is_address_like, normalize_address};
use crate::services::chain_sync::ChainSyncService;
use crate::services::liquidation_bot::LiquidationBotService;
use crate::services::realtime::RealtimeHub;
use crate::services::user_service::UserService;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use bigdecimal::BigDecimal;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use std::env;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub user_service: UserService,
    pub admin_username: String,
    pub admin_password: String,
    pub chain_sync: Option<Arc<ChainSyncService>>,
    pub liquidation_bot: Option<Arc<LiquidationBotService>>,
    pub cache: Arc<CacheService>,
    pub realtime: Arc<RealtimeHub>,
}

#[derive(FromRow)]
struct LatestPriceRow {
    price: BigDecimal,
    timestamp: chrono::NaiveDateTime,
}

#[derive(FromRow)]
struct UserRow {
    id: i32,
    #[sqlx(rename = "walletAddress")]
    wallet_address: String,
    #[sqlx(rename = "referralCode")]
    referral_code: String,
    #[sqlx(rename = "referredBy")]
    referred_by: Option<i32>,
    #[sqlx(rename = "createdAt")]
    created_at: chrono::NaiveDateTime,
    #[sqlx(rename = "totalTradingVolume")]
    total_trading_volume: BigDecimal,
}

#[derive(FromRow)]
struct Tier2ReferralRow {
    #[sqlx(rename = "walletAddress")]
    wallet_address: String,
    #[sqlx(rename = "referralCode")]
    referral_code: String,
    #[sqlx(rename = "totalTradingVolume")]
    total_trading_volume: BigDecimal,
    #[sqlx(rename = "createdAt")]
    created_at: chrono::NaiveDateTime,
    #[sqlx(rename = "parentWalletAddress")]
    parent_wallet_address: String,
    #[sqlx(rename = "parentReferralCode")]
    parent_referral_code: String,
}

#[derive(FromRow)]
struct AdminUserListRow {
    id: i32,
    #[sqlx(rename = "walletAddress")]
    wallet_address: String,
    #[sqlx(rename = "referralCode")]
    referral_code: String,
    #[sqlx(rename = "referredBy")]
    referred_by: Option<i32>,
    #[sqlx(rename = "createdAt")]
    created_at: chrono::NaiveDateTime,
    #[sqlx(rename = "totalTradingVolume")]
    total_trading_volume: BigDecimal,
    total_trades: i64,
    open_trades: i64,
    closed_trades: i64,
    liquidated_trades: i64,
    aggregate_pnl: Option<BigDecimal>,
}

#[derive(FromRow)]
struct TradeWithWalletRow {
    id: i32,
    #[sqlx(rename = "onChainTradeId")]
    on_chain_trade_id: i64,
    #[sqlx(rename = "userId")]
    user_id: i32,
    direction: String,
    leverage: i32,
    margin: BigDecimal,
    #[sqlx(rename = "entryPrice")]
    entry_price: BigDecimal,
    #[sqlx(rename = "tpPrice")]
    tp_price: BigDecimal,
    #[sqlx(rename = "slPrice")]
    sl_price: BigDecimal,
    #[sqlx(rename = "exitPrice")]
    exit_price: Option<BigDecimal>,
    #[sqlx(rename = "soldWeth")]
    sold_weth: Option<BigDecimal>,
    #[sqlx(rename = "boughtWeth")]
    bought_weth: Option<BigDecimal>,
    status: TradeStatus,
    pnl: Option<BigDecimal>,
    #[sqlx(rename = "createdAt")]
    created_at: chrono::NaiveDateTime,
    #[sqlx(rename = "closedAt")]
    closed_at: Option<chrono::NaiveDateTime>,
    #[sqlx(rename = "openTxHash")]
    open_tx_hash: Option<String>,
    #[sqlx(rename = "openBlockNumber")]
    open_block_number: Option<i64>,
    #[sqlx(rename = "closeTxHash")]
    close_tx_hash: Option<String>,
    #[sqlx(rename = "closeBlockNumber")]
    close_block_number: Option<i64>,
    #[sqlx(rename = "closeReason")]
    close_reason: Option<String>,
    #[sqlx(rename = "payoutUsdc")]
    payout_usdc: Option<BigDecimal>,
    #[sqlx(rename = "settlementAction")]
    settlement_action: Option<String>,
    #[sqlx(rename = "settlementUsdcAmount")]
    settlement_usdc_amount: Option<BigDecimal>,
    #[sqlx(rename = "settlementWethAmount")]
    settlement_weth_amount: Option<BigDecimal>,
    #[sqlx(rename = "walletAddress")]
    wallet_address: String,
    #[sqlx(rename = "referralCode")]
    referral_code: String,
}

#[derive(FromRow)]
struct TradeStatsRow {
    total_users: i64,
    total_trades: i64,
    open_trades: i64,
    closed_trades: i64,
    liquidated_trades: i64,
    total_margin: Option<BigDecimal>,
    open_margin: Option<BigDecimal>,
    closed_pnl: Option<BigDecimal>,
}

fn trade_to_json(t: &Trade) -> Value {
    json!({
        "id": t.id,
        "onChainTradeId": t.on_chain_trade_id.to_string(),
        "userId": t.user_id,
        "direction": t.direction,
        "leverage": t.leverage,
        "margin": t.margin.to_string(),
        "entryPrice": t.entry_price.to_string(),
        "tpPrice": t.tp_price.to_string(),
        "slPrice": t.sl_price.to_string(),
        "exitPrice": t.exit_price.as_ref().map(|v| v.to_string()),
        "soldWeth": t.sold_weth.as_ref().map(|v| v.to_string()),
        "boughtWeth": t.bought_weth.as_ref().map(|v| v.to_string()),
        "status": match t.status {
            TradeStatus::Open => "OPEN",
            TradeStatus::Closed => "CLOSED",
            TradeStatus::Liquidated => "LIQUIDATED",
        },
        "pnl": t.pnl.as_ref().map(|v| v.to_string()),
        "createdAt": t.created_at,
        "closedAt": t.closed_at,
        "openTxHash": t.open_tx_hash,
        "openBlockNumber": t.open_block_number,
        "closeTxHash": t.close_tx_hash,
        "closeBlockNumber": t.close_block_number,
        "closeReason": t.close_reason,
        "payoutUsdc": t.payout_usdc.as_ref().map(|v| v.to_string()),
        "settlementAction": t.settlement_action,
        "settlementUsdcAmount": t.settlement_usdc_amount.as_ref().map(|v| v.to_string()),
        "settlementWethAmount": t.settlement_weth_amount.as_ref().map(|v| v.to_string()),
    })
}

fn trade_with_wallet_to_json(t: &TradeWithWalletRow) -> Value {
    json!({
        "id": t.id,
        "onChainTradeId": t.on_chain_trade_id.to_string(),
        "userId": t.user_id,
        "direction": t.direction,
        "leverage": t.leverage,
        "margin": t.margin.to_string(),
        "entryPrice": t.entry_price.to_string(),
        "tpPrice": t.tp_price.to_string(),
        "slPrice": t.sl_price.to_string(),
        "exitPrice": t.exit_price.as_ref().map(|v| v.to_string()),
        "soldWeth": t.sold_weth.as_ref().map(|v| v.to_string()),
        "boughtWeth": t.bought_weth.as_ref().map(|v| v.to_string()),
        "status": match t.status {
            TradeStatus::Open => "OPEN",
            TradeStatus::Closed => "CLOSED",
            TradeStatus::Liquidated => "LIQUIDATED",
        },
        "pnl": t.pnl.as_ref().map(|v| v.to_string()),
        "createdAt": t.created_at,
        "closedAt": t.closed_at,
        "openTxHash": t.open_tx_hash,
        "openBlockNumber": t.open_block_number,
        "closeTxHash": t.close_tx_hash,
        "closeBlockNumber": t.close_block_number,
        "closeReason": t.close_reason,
        "payoutUsdc": t.payout_usdc.as_ref().map(|v| v.to_string()),
        "settlementAction": t.settlement_action,
        "settlementUsdcAmount": t.settlement_usdc_amount.as_ref().map(|v| v.to_string()),
        "settlementWethAmount": t.settlement_weth_amount.as_ref().map(|v| v.to_string()),
        "user": {
            "id": t.user_id,
            "walletAddress": t.wallet_address,
            "referralCode": t.referral_code,
        }
    })
}

fn user_row_to_json(row: &AdminUserListRow) -> Value {
    json!({
        "id": row.id,
        "walletAddress": row.wallet_address,
        "referralCode": row.referral_code,
        "referredBy": row.referred_by,
        "createdAt": row.created_at,
        "totalTradingVolume": row.total_trading_volume.to_string(),
        "totalTrades": row.total_trades,
        "openTrades": row.open_trades,
        "closedTrades": row.closed_trades,
        "liquidatedTrades": row.liquidated_trades,
        "aggregatePnl": row.aggregate_pnl.as_ref().map(|v| v.to_string()).unwrap_or_else(|| "0".into()),
    })
}

fn latest_price_json(latest: Option<LatestPriceRow>) -> Value {
    match latest {
        Some(p) => json!({
            "price": p.price.to_string(),
            "timestamp": p.timestamp.and_utc().to_rfc3339()
        }),
        None => json!({
            "price": null,
            "timestamp": null
        }),
    }
}

fn api_err(code: StatusCode, msg: &str) -> (StatusCode, Json<Value>) {
    (code, Json(json!({ "error": msg })))
}

fn parse_basic_auth(headers: &HeaderMap) -> Option<(String, String)> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let encoded = raw.strip_prefix("Basic ")?;
    let decoded = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let mut parts = text.splitn(2, ':');
    let username = parts.next()?.to_string();
    let password = parts.next()?.to_string();
    Some((username, password))
}

fn is_admin_authorized(headers: &HeaderMap, state: &AppState) -> bool {
    if let Some((username, password)) = parse_basic_auth(headers) {
        return username == state.admin_username && password == state.admin_password;
    }

    let header_username = headers
        .get("x-admin-username")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let header_password = headers
        .get("x-admin-password")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();

    !header_username.is_empty()
        && !header_password.is_empty()
        && header_username == state.admin_username
        && header_password == state.admin_password
}

fn require_admin(headers: &HeaderMap, state: &AppState) -> Result<(), (StatusCode, Json<Value>)> {
    if is_admin_authorized(headers, state) {
        Ok(())
    } else {
        Err(api_err(StatusCode::UNAUTHORIZED, "Invalid admin credentials"))
    }
}

async fn latest_price(pool: &PgPool) -> Option<LatestPriceRow> {
    sqlx::query_as::<_, LatestPriceRow>(
        r#"SELECT price, timestamp FROM "PriceSample" ORDER BY timestamp DESC LIMIT 1"#,
    )
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

async fn latest_price_cached(state: &AppState) -> Value {
    if let Ok(Some(v)) = state.cache.get_json("price:latest").await {
        return v;
    }
    let db_latest = latest_price(&state.pool).await;
    let as_json = latest_price_json(db_latest);
    let _ = state.cache.set_json("price:latest", &as_json, Some(5)).await;
    as_json
}

async fn collect_trade_stats(pool: &PgPool) -> TradeStatsRow {
    sqlx::query_as::<_, TradeStatsRow>(
        r#"
        SELECT
            (SELECT COUNT(*)::bigint FROM "User") AS total_users,
            COUNT(*)::bigint AS total_trades,
            COUNT(*) FILTER (WHERE status = 'OPEN')::bigint AS open_trades,
            COUNT(*) FILTER (WHERE status = 'CLOSED')::bigint AS closed_trades,
            COUNT(*) FILTER (WHERE status = 'LIQUIDATED')::bigint AS liquidated_trades,
            COALESCE(SUM(margin), 0) AS total_margin,
            COALESCE(SUM(margin) FILTER (WHERE status = 'OPEN'), 0) AS open_margin,
            COALESCE(SUM(pnl) FILTER (WHERE status <> 'OPEN'), 0) AS closed_pnl
        FROM "Trade"
        "#,
    )
    .fetch_one(pool)
    .await
    .unwrap_or(TradeStatsRow {
        total_users: 0,
        total_trades: 0,
        open_trades: 0,
        closed_trades: 0,
        liquidated_trades: 0,
        total_margin: Some(BigDecimal::from(0)),
        open_margin: Some(BigDecimal::from(0)),
        closed_pnl: Some(BigDecimal::from(0)),
    })
}

// GET /api/health
async fn health(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    let latest = latest_price_cached(&s).await;
    let liquidation_enabled = s.liquidation_bot.is_some();

    Json(json!({
        "ok": true,
        "protocolVariant": "default",
        "latestPrice": latest,
        "services": { "liquidationBot": liquidation_enabled }
    }))
}

// GET /api/config
async fn config() -> impl IntoResponse {
    let chain_id = env::var("CHAIN_ID")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(31337);
    let chain_name = env::var("CHAIN_NAME").unwrap_or_else(|_| "Anvil Local".to_string());
    let public_mode = env::var("PUBLIC_MODE")
        .ok()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let local_mode = env::var("LOCAL_MODE")
        .ok()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let lp_fee_ppm = env::var("LP_FEE_PPM")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(70);
    let protocol_fee_ppm = env::var("PROTOCOL_FEE_PPM")
        .ok()
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(30);

    Json(json!({
        "protocolVariant": "default",
        "chainId": chain_id,
        "chainName": chain_name,
        "publicMode": public_mode,
        "localMode": local_mode,
        "rpcUrl": env::var("FRONTEND_RPC_URL")
            .ok()
            .filter(|v| !v.is_empty())
            .or_else(|| env::var("RPC_URL").ok().filter(|v| !v.is_empty())),
        "backendUrl": env::var("BACKEND_URL").ok().filter(|v| !v.is_empty()),
        "makeit": env::var("MAKEIT_ADDRESS").ok().filter(|v| !v.is_empty()),
        "oracle": env::var("ORACLE_ADDRESS").ok().filter(|v| !v.is_empty()),
        "swapAdapter": env::var("SWAP_ADAPTER_ADDRESS").ok().filter(|v| !v.is_empty()),
        "pool": env::var("UNISWAP_POOL_ADDRESS").ok().filter(|v| !v.is_empty()),
        "usdc": env::var("USDC_ADDRESS").ok().filter(|v| !v.is_empty()),
        "usdt": env::var("USDT_ADDRESS").ok().filter(|v| !v.is_empty()),
        "weth": env::var("WETH_ADDRESS").ok().filter(|v| !v.is_empty()),
        "runnerAddress": env::var("RUNNER_ADDRESS").ok().filter(|v| !v.is_empty()),
        "swapperAddress": env::var("SWAPPER_ADDRESS").ok().filter(|v| !v.is_empty()),
        "faucetAddress": env::var("FAUCET_ADDRESS").ok().filter(|v| !v.is_empty()),
        "adminDefaultUser": env::var("ADMIN_USERNAME").ok().filter(|v| !v.is_empty()),
        "adminDefaultPassword": env::var("ADMIN_PASSWORD").ok().filter(|v| !v.is_empty()),
        "feeConfig": {
            "liquidityProvisionFeePpm": lp_fee_ppm,
            "protocolFeePpm": protocol_fee_ppm,
            "feeScaleFactorPpm": 1000000
        }
    }))
}

// POST /api/users/login
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginBody {
    wallet_address: Option<String>,
    referral_code: Option<String>,
}

async fn login(State(s): State<Arc<AppState>>, Json(body): Json<LoginBody>) -> impl IntoResponse {
    let wallet = body.wallet_address.unwrap_or_default();
    if wallet.is_empty() || !is_address_like(&wallet) {
        return api_err(StatusCode::BAD_REQUEST, "walletAddress is required").into_response();
    }
    match s.user_service.login(&wallet, body.referral_code.as_deref()).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, &e.to_string()).into_response(),
    }
}

// GET /api/users/:wallet
async fn get_user(State(s): State<Arc<AppState>>, Path(wallet): Path<String>) -> impl IntoResponse {
    if !is_address_like(&wallet) {
        return api_err(StatusCode::BAD_REQUEST, "invalid wallet").into_response();
    }
    match s.user_service.get_by_wallet(&wallet).await {
        Ok(Some(u)) => Json(json!({ "user": u })).into_response(),
        Ok(None) => api_err(StatusCode::NOT_FOUND, "user not found").into_response(),
        Err(e) => api_err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()).into_response(),
    }
}

// GET /api/users/:wallet/referrals
async fn get_user_referrals(State(s): State<Arc<AppState>>, Path(wallet): Path<String>) -> impl IntoResponse {
    if !is_address_like(&wallet) {
        return api_err(StatusCode::BAD_REQUEST, "invalid wallet").into_response();
    }

    let normalized = match normalize_address(&wallet) {
        Ok(value) => value,
        Err(e) => return api_err(StatusCode::BAD_REQUEST, &e.to_string()).into_response(),
    };
    let Some(user) = sqlx::query_as::<_, UserRow>(r#"SELECT * FROM "User" WHERE "walletAddress" = $1"#)
        .bind(&normalized)
        .fetch_optional(&s.pool)
        .await
        .unwrap_or(None) else {
            return api_err(StatusCode::NOT_FOUND, "user not found").into_response();
        };

    let referrer: Option<UserRow> = match user.referred_by {
        Some(referrer_id) => sqlx::query_as::<_, UserRow>(r#"SELECT * FROM "User" WHERE id = $1"#)
            .bind(referrer_id)
            .fetch_optional(&s.pool)
            .await
            .unwrap_or(None),
        None => None,
    };

    let tier1: Vec<UserRow> = sqlx::query_as::<_, UserRow>(
        r#"SELECT * FROM "User" WHERE "referredBy" = $1 ORDER BY "createdAt" DESC"#,
    )
    .bind(user.id)
    .fetch_all(&s.pool)
    .await
    .unwrap_or_default();

    let tier2: Vec<Tier2ReferralRow> = sqlx::query_as::<_, Tier2ReferralRow>(
        r#"
        SELECT
            child."walletAddress",
            child."referralCode",
            child."totalTradingVolume",
            child."createdAt",
            parent."walletAddress" AS "parentWalletAddress",
            parent."referralCode" AS "parentReferralCode"
        FROM "User" child
        JOIN "User" parent ON child."referredBy" = parent.id
        WHERE parent."referredBy" = $1
        ORDER BY child."createdAt" DESC
        "#,
    )
    .bind(user.id)
    .fetch_all(&s.pool)
    .await
    .unwrap_or_default();

    let tier1_volume: BigDecimal = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM("totalTradingVolume"), 0) FROM "User" WHERE "referredBy" = $1"#,
    )
    .bind(user.id)
    .fetch_one(&s.pool)
    .await
    .unwrap_or_else(|_| BigDecimal::from(0));

    let tier2_volume: BigDecimal = sqlx::query_scalar(
        r#"
        SELECT COALESCE(SUM(child."totalTradingVolume"), 0)
        FROM "User" child
        JOIN "User" parent ON child."referredBy" = parent.id
        WHERE parent."referredBy" = $1
        "#,
    )
    .bind(user.id)
    .fetch_one(&s.pool)
    .await
    .unwrap_or_else(|_| BigDecimal::from(0));

    let combined_volume = &tier1_volume + &tier2_volume;

    Json(json!({
        "user": {
            "id": user.id,
            "walletAddress": user.wallet_address,
            "referralCode": user.referral_code,
            "referredBy": user.referred_by,
            "createdAt": user.created_at,
            "totalTradingVolume": user.total_trading_volume.to_string(),
        },
        "referrer": referrer.map(|u| json!({
            "id": u.id,
            "walletAddress": u.wallet_address,
            "referralCode": u.referral_code,
            "totalTradingVolume": u.total_trading_volume.to_string(),
        })),
        "tier1": tier1.iter().map(|u| json!({
            "id": u.id,
            "walletAddress": u.wallet_address,
            "referralCode": u.referral_code,
            "createdAt": u.created_at,
            "totalTradingVolume": u.total_trading_volume.to_string(),
        })).collect::<Vec<_>>(),
        "tier2": tier2.iter().map(|u| json!({
            "walletAddress": u.wallet_address,
            "referralCode": u.referral_code,
            "createdAt": u.created_at,
            "totalTradingVolume": u.total_trading_volume.to_string(),
            "parentWalletAddress": u.parent_wallet_address,
            "parentReferralCode": u.parent_referral_code,
        })).collect::<Vec<_>>(),
        "totals": {
            "tier1Volume": tier1_volume.to_string(),
            "tier2Volume": tier2_volume.to_string(),
            "combinedVolume": combined_volume.to_string(),
        }
    }))
    .into_response()
}

// GET /api/price/latest
async fn price_latest(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    Json(latest_price_cached(&s).await).into_response()
}

// GET /api/price/history
#[derive(Deserialize)]
struct PriceHistoryQuery {
    range: Option<String>,
}

async fn price_history(State(s): State<Arc<AppState>>, Query(q): Query<PriceHistoryQuery>) -> impl IntoResponse {
    let range = q.range.unwrap_or_else(|| "1h".into());
    let secs = match range.as_str() {
        "15m" => 900i64,
        "6h" => 21600,
        "1d" => 86400,
        _ => 3600,
    };
    let cache_key = format!("price:history:{range}");
    if let Ok(Some(cached)) = s.cache.get_json(&cache_key).await {
        return Json(cached);
    }

    let now = chrono::Utc::now().naive_utc();
    let since = now - chrono::Duration::seconds(secs);

    #[derive(sqlx::FromRow)]
    struct Row {
        price: BigDecimal,
        timestamp: chrono::NaiveDateTime,
    }
    let rows: Vec<Row> = sqlx::query_as(
        r#"SELECT price, timestamp FROM "PriceSample" WHERE timestamp >= $1 AND timestamp <= $2 ORDER BY timestamp ASC"#,
    )
    .bind(since)
    .bind(now)
    .fetch_all(&s.pool)
    .await
    .unwrap_or_default();

    let samples: Vec<Value> = rows
        .iter()
        .map(|r| json!({ "timestamp": r.timestamp.and_utc().to_rfc3339(), "price": r.price.to_string() }))
        .collect();
    let payload = json!({ "range": range, "samples": samples });
    let _ = s.cache.set_json(&cache_key, &payload, Some(5)).await;
    Json(payload)
}

// GET /api/trades
#[derive(Deserialize)]
struct TradesQuery {
    wallet: Option<String>,
}

async fn get_trades(State(s): State<Arc<AppState>>, Query(q): Query<TradesQuery>) -> impl IntoResponse {
    match q.wallet {
        None => {
            let trades: Vec<Trade> =
                sqlx::query_as(r#"SELECT * FROM "Trade" ORDER BY "createdAt" DESC LIMIT 1000"#)
                    .fetch_all(&s.pool)
                    .await
                    .unwrap_or_default();
            Json(json!({ "trades": trades.iter().map(trade_to_json).collect::<Vec<_>>() })).into_response()
        }
        Some(wallet) => {
            if !is_address_like(&wallet) {
                return api_err(StatusCode::BAD_REQUEST, "invalid wallet").into_response();
            }
            let normalized_wallet = wallet.to_lowercase();
            let open_key = format!("user:{}:trades:open", normalized_wallet);
            let closed_key = format!("user:{}:trades:closed_head", normalized_wallet);
            if let (Ok(Some(open)), Ok(Some(closed))) = (
                s.cache.get_json(&open_key).await,
                s.cache.get_json(&closed_key).await,
            ) {
                return Json(json!({ "openTrades": open, "closedTrades": closed })).into_response();
            }

            let uid: Option<i32> = sqlx::query_scalar(r#"SELECT id FROM "User" WHERE "walletAddress" = $1"#)
                .bind(&normalized_wallet)
                .fetch_optional(&s.pool)
                .await
                .unwrap_or(None);

            match uid {
                Some(id) => {
                    let trades: Vec<Trade> =
                        sqlx::query_as(r#"SELECT * FROM "Trade" WHERE "userId" = $1 ORDER BY "createdAt" DESC"#)
                            .bind(id)
                            .fetch_all(&s.pool)
                            .await
                            .unwrap_or_default();
                    let open: Vec<Value> = trades
                        .iter()
                        .filter(|t| t.status == TradeStatus::Open)
                        .map(trade_to_json)
                        .collect();
                    let closed: Vec<Value> = trades
                        .iter()
                        .filter(|t| t.status != TradeStatus::Open)
                        .map(trade_to_json)
                        .collect();
                    let _ = s.cache.set_json(&open_key, &json!(open), Some(5)).await;
                    let _ = s.cache.set_json(&closed_key, &json!(closed), Some(5)).await;
                    Json(json!({ "openTrades": open, "closedTrades": closed })).into_response()
                }
                None => Json(json!({ "openTrades": [], "closedTrades": [] })).into_response(),
            }
        }
    }
}

// POST /api/trades/sync
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TradesSyncBody {
    trade_id: Option<i64>,
    protocol_variant: Option<String>,
}

async fn trades_sync(State(s): State<Arc<AppState>>, Json(body): Json<TradesSyncBody>) -> impl IntoResponse {
    let Some(chain_sync) = &s.chain_sync else {
        return api_err(StatusCode::SERVICE_UNAVAILABLE, "trade sync unavailable").into_response();
    };

    let sync_result = match body.trade_id {
        Some(trade_id) => chain_sync.sync_trade(trade_id).await,
        None => chain_sync.refresh_existing_open_trades().await,
    };

    match sync_result {
        Ok(()) => Json(json!({
            "ok": true,
            "result": body.trade_id.map(|id| format!("synced-trade-{id}")).unwrap_or_else(|| "synced-open-trades".to_string()),
            "protocolVariant": body.protocol_variant.unwrap_or_else(|| "default".into())
        })).into_response(),
        Err(e) => api_err(StatusCode::BAD_REQUEST, &e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct BootstrapQuery {
    wallet: Option<String>,
}

async fn bootstrap(State(s): State<Arc<AppState>>, Query(q): Query<BootstrapQuery>) -> impl IntoResponse {
    let Some(wallet) = q.wallet else {
        return api_err(StatusCode::BAD_REQUEST, "wallet is required").into_response();
    };
    if !is_address_like(&wallet) {
        return api_err(StatusCode::BAD_REQUEST, "invalid wallet").into_response();
    }
    let normalized = wallet.to_lowercase();

    let latest = latest_price_cached(&s).await;
    let open_key = format!("user:{}:trades:open", normalized);
    let closed_key = format!("user:{}:trades:closed_head", normalized);
    let referral_key = format!("user:{}:referral_summary", normalized);

    let open_trades = s
        .cache
        .get_json(&open_key)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| json!([]));
    let closed_trades = s
        .cache
        .get_json(&closed_key)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| json!([]));
    let referral_summary = s
        .cache
        .get_json(&referral_key)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| {
            json!({
                "tier1Volume": "0",
                "tier2Volume": "0",
                "combinedVolume": "0"
            })
        });

    Json(json!({
        "config": {
            "protocolVariant": "default",
            "feeConfig": { "liquidityProvisionFeePpm": 70, "protocolFeePpm": 30, "feeScaleFactorPpm": 1000000 }
        },
        "latestPrice": latest,
        "openTrades": open_trades,
        "closedTrades": closed_trades,
        "referralSummary": referral_summary,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct WsQuery {
    wallet: Option<String>,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(s): State<Arc<AppState>>,
    Query(q): Query<WsQuery>,
) -> impl IntoResponse {
    let wallet = q.wallet.unwrap_or_default().to_lowercase();
    ws.on_upgrade(move |socket| handle_ws(socket, s, wallet))
}

async fn handle_ws(mut socket: WebSocket, state: Arc<AppState>, wallet: String) {
    let mut global_rx = state.realtime.subscribe_global();
    let mut wallet_rx = if is_address_like(&wallet) {
        Some(state.realtime.subscribe_wallet(&wallet).await)
    } else {
        None
    };

    loop {
        tokio::select! {
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            evt = global_rx.recv() => {
                if let Ok(raw) = evt {
                    if socket.send(Message::Text(raw)).await.is_err() {
                        break;
                    }
                }
            }
            evt = async {
                match &mut wallet_rx {
                    Some(rx) => rx.recv().await.ok(),
                    None => None,
                }
            } => {
                if let Some(raw) = evt {
                    if socket.send(Message::Text(raw)).await.is_err() {
                        break;
                    }
                }
            }
        }
    }
}

// GET /api/admin/overview
async fn admin_overview(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(err) = require_admin(&headers, &s) {
        return err.into_response();
    }

    let stats = collect_trade_stats(&s.pool).await;
    let latest = latest_price(&s.pool).await;
    let recent_trades: Vec<TradeWithWalletRow> = sqlx::query_as::<_, TradeWithWalletRow>(
        r#"
        SELECT
            t.id, t."onChainTradeId", t."userId", t.direction, t.leverage, t.margin,
            t."entryPrice", t."tpPrice", t."slPrice", t."exitPrice", t."soldWeth",
            t."boughtWeth", t.status, t.pnl, t."createdAt", t."closedAt",
            t."openTxHash", t."openBlockNumber", t."closeTxHash", t."closeBlockNumber",
            t."closeReason", t."payoutUsdc", t."settlementAction", t."settlementUsdcAmount", t."settlementWethAmount",
            u."walletAddress", u."referralCode"
        FROM "Trade" t
        JOIN "User" u ON u.id = t."userId"
        ORDER BY t."createdAt" DESC
        LIMIT 50
        "#,
    )
    .fetch_all(&s.pool)
    .await
    .unwrap_or_default();
    let recent_users: Vec<UserRow> = sqlx::query_as::<_, UserRow>(
        r#"SELECT * FROM "User" ORDER BY "createdAt" DESC LIMIT 20"#,
    )
    .fetch_all(&s.pool)
    .await
    .unwrap_or_default();

    Json(json!({
        "summary": {
            "totalUsers": stats.total_users,
            "totalTrades": stats.total_trades,
            "openTrades": stats.open_trades,
            "closedTrades": stats.closed_trades,
            "liquidatedTrades": stats.liquidated_trades,
            "totalMargin": stats.total_margin.unwrap_or_else(|| BigDecimal::from(0)).to_string(),
            "openMargin": stats.open_margin.unwrap_or_else(|| BigDecimal::from(0)).to_string(),
            "closedPnl": stats.closed_pnl.unwrap_or_else(|| BigDecimal::from(0)).to_string(),
        },
        "latestPrice": latest_price_json(latest),
        "recentTrades": recent_trades.iter().map(trade_with_wallet_to_json).collect::<Vec<_>>(),
        "recentUsers": recent_users.iter().map(|u| json!({
            "id": u.id,
            "walletAddress": u.wallet_address,
            "referralCode": u.referral_code,
            "referredBy": u.referred_by,
            "createdAt": u.created_at,
            "totalTradingVolume": u.total_trading_volume.to_string(),
        })).collect::<Vec<_>>(),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct AdminUsersQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

// GET /api/admin/users
async fn admin_users(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<AdminUsersQuery>,
) -> impl IntoResponse {
    if let Err(err) = require_admin(&headers, &s) {
        return err.into_response();
    }

    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let offset = q.offset.unwrap_or(0).max(0);

    let users = sqlx::query_as::<_, AdminUserListRow>(
        r#"
        SELECT
            u.id,
            u."walletAddress",
            u."referralCode",
            u."referredBy",
            u."createdAt",
            u."totalTradingVolume",
            COUNT(t.id)::bigint AS total_trades,
            COUNT(t.id) FILTER (WHERE t.status = 'OPEN')::bigint AS open_trades,
            COUNT(t.id) FILTER (WHERE t.status = 'CLOSED')::bigint AS closed_trades,
            COUNT(t.id) FILTER (WHERE t.status = 'LIQUIDATED')::bigint AS liquidated_trades,
            COALESCE(SUM(t.pnl), 0) AS aggregate_pnl
        FROM "User" u
        LEFT JOIN "Trade" t ON t."userId" = u.id
        GROUP BY u.id
        ORDER BY u."createdAt" DESC
        LIMIT $1 OFFSET $2
        "#,
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&s.pool)
    .await
    .unwrap_or_default();

    let total: i64 = sqlx::query_scalar(r#"SELECT COUNT(*)::bigint FROM "User""#)
        .fetch_one(&s.pool)
        .await
        .unwrap_or(0);

    Json(json!({
        "total": total,
        "limit": limit,
        "offset": offset,
        "users": users.iter().map(user_row_to_json).collect::<Vec<_>>(),
    }))
    .into_response()
}

// GET /api/admin/users/:wallet
async fn admin_user_detail(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(wallet): Path<String>,
) -> impl IntoResponse {
    if let Err(err) = require_admin(&headers, &s) {
        return err.into_response();
    }
    if !is_address_like(&wallet) {
        return api_err(StatusCode::BAD_REQUEST, "invalid wallet").into_response();
    }

    let Some(user) = sqlx::query_as::<_, UserRow>(r#"SELECT * FROM "User" WHERE "walletAddress" = $1"#)
        .bind(wallet.to_lowercase())
        .fetch_optional(&s.pool)
        .await
        .unwrap_or(None) else {
            return api_err(StatusCode::NOT_FOUND, "user not found").into_response();
        };

    let referrer: Option<UserRow> = match user.referred_by {
        Some(referrer_id) => sqlx::query_as::<_, UserRow>(r#"SELECT * FROM "User" WHERE id = $1"#)
            .bind(referrer_id)
            .fetch_optional(&s.pool)
            .await
            .unwrap_or(None),
        None => None,
    };

    let referred_users: Vec<UserRow> = sqlx::query_as::<_, UserRow>(r#"SELECT * FROM "User" WHERE "referredBy" = $1 ORDER BY "createdAt" DESC"#)
        .bind(user.id)
        .fetch_all(&s.pool)
        .await
        .unwrap_or_default();

    let trades: Vec<Trade> = sqlx::query_as::<_, Trade>(r#"SELECT * FROM "Trade" WHERE "userId" = $1 ORDER BY "createdAt" DESC"#)
        .bind(user.id)
        .fetch_all(&s.pool)
        .await
        .unwrap_or_default();

    let open_trade_count = trades.iter().filter(|t| t.status == TradeStatus::Open).count();
    let closed_trade_count = trades.iter().filter(|t| t.status == TradeStatus::Closed).count();
    let liquidated_trade_count = trades.iter().filter(|t| t.status == TradeStatus::Liquidated).count();

    Json(json!({
        "user": {
            "id": user.id,
            "walletAddress": user.wallet_address,
            "referralCode": user.referral_code,
            "referredBy": user.referred_by,
            "createdAt": user.created_at,
            "totalTradingVolume": user.total_trading_volume.to_string(),
        },
        "referrer": referrer.map(|u| json!({
            "id": u.id,
            "walletAddress": u.wallet_address,
            "referralCode": u.referral_code,
        })),
        "referredUsers": referred_users.iter().map(|u| json!({
            "id": u.id,
            "walletAddress": u.wallet_address,
            "referralCode": u.referral_code,
            "createdAt": u.created_at,
            "totalTradingVolume": u.total_trading_volume.to_string(),
        })).collect::<Vec<_>>(),
        "tradeSummary": {
            "total": trades.len(),
            "open": open_trade_count,
            "closed": closed_trade_count,
            "liquidated": liquidated_trade_count,
        },
        "trades": trades.iter().map(trade_to_json).collect::<Vec<_>>(),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct AdminTradesQuery {
    wallet: Option<String>,
    status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

// GET /api/admin/trades
async fn admin_trades(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<AdminTradesQuery>,
) -> impl IntoResponse {
    if let Err(err) = require_admin(&headers, &s) {
        return err.into_response();
    }

    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let offset = q.offset.unwrap_or(0).max(0);

    let mut trades: Vec<TradeWithWalletRow> = sqlx::query_as::<_, TradeWithWalletRow>(
        r#"
        SELECT
            t.id, t."onChainTradeId", t."userId", t.direction, t.leverage, t.margin,
            t."entryPrice", t."tpPrice", t."slPrice", t."exitPrice", t."soldWeth",
            t."boughtWeth", t.status, t.pnl, t."createdAt", t."closedAt",
            t."openTxHash", t."openBlockNumber", t."closeTxHash", t."closeBlockNumber",
            t."closeReason", t."payoutUsdc", t."settlementAction", t."settlementUsdcAmount", t."settlementWethAmount",
            u."walletAddress", u."referralCode"
        FROM "Trade" t
        JOIN "User" u ON u.id = t."userId"
        ORDER BY t."createdAt" DESC
        LIMIT $1 OFFSET $2
        "#,
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(&s.pool)
    .await
    .unwrap_or_default();

    if let Some(wallet) = q.wallet.as_deref() {
        if !is_address_like(wallet) {
            return api_err(StatusCode::BAD_REQUEST, "invalid wallet").into_response();
        }
        let normalized = wallet.to_lowercase();
        trades.retain(|t| t.wallet_address == normalized);
    }

    if let Some(status_filter) = q.status.as_deref() {
        let status_filter = status_filter.to_ascii_uppercase();
        trades.retain(|t| match t.status {
            TradeStatus::Open => status_filter == "OPEN",
            TradeStatus::Closed => status_filter == "CLOSED",
            TradeStatus::Liquidated => status_filter == "LIQUIDATED",
        });
    }

    Json(json!({
        "limit": limit,
        "offset": offset,
        "trades": trades.iter().map(trade_with_wallet_to_json).collect::<Vec<_>>(),
    }))
    .into_response()
}

// GET /api/admin/trades/:id
async fn admin_trade_detail(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> impl IntoResponse {
    if let Err(err) = require_admin(&headers, &s) {
        return err.into_response();
    }

    let Some(trade) = sqlx::query_as::<_, TradeWithWalletRow>(
        r#"
        SELECT
            t.id, t."onChainTradeId", t."userId", t.direction, t.leverage, t.margin,
            t."entryPrice", t."tpPrice", t."slPrice", t."exitPrice", t."soldWeth",
            t."boughtWeth", t.status, t.pnl, t."createdAt", t."closedAt",
            t."openTxHash", t."openBlockNumber", t."closeTxHash", t."closeBlockNumber",
            t."closeReason", t."payoutUsdc", t."settlementAction", t."settlementUsdcAmount", t."settlementWethAmount",
            u."walletAddress", u."referralCode"
        FROM "Trade" t
        JOIN "User" u ON u.id = t."userId"
        WHERE t.id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .unwrap_or(None) else {
        return api_err(StatusCode::NOT_FOUND, "trade not found").into_response();
    };

    Json(json!({ "trade": trade_with_wallet_to_json(&trade) })).into_response()
}

// GET /api/admin/stats
async fn admin_stats(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(err) = require_admin(&headers, &s) {
        return err.into_response();
    }

    let stats = collect_trade_stats(&s.pool).await;
    let latest = latest_price(&s.pool).await;

    Json(json!({
        "totalUsers": stats.total_users,
        "totalTrades": stats.total_trades,
        "openTrades": stats.open_trades,
        "closedTrades": stats.closed_trades,
        "liquidatedTrades": stats.liquidated_trades,
        "totalMargin": stats.total_margin.unwrap_or_else(|| BigDecimal::from(0)).to_string(),
        "openMargin": stats.open_margin.unwrap_or_else(|| BigDecimal::from(0)).to_string(),
        "closedPnl": stats.closed_pnl.unwrap_or_else(|| BigDecimal::from(0)).to_string(),
        "latestPrice": latest_price_json(latest),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct AdminBotLogsQuery {
    limit: Option<usize>,
}

// GET /api/admin/bot/logs
async fn admin_bot_logs(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<AdminBotLogsQuery>,
) -> impl IntoResponse {
    if let Err(err) = require_admin(&headers, &s) {
        return err.into_response();
    }
    let Some(bot) = &s.liquidation_bot else {
        return Json(json!({ "logs": [] })).into_response();
    };
    let limit = q.limit.unwrap_or(200).clamp(1, 2000);
    let logs = bot.recent_logs(limit).await;
    Json(json!({ "logs": logs })).into_response()
}

// POST /api/admin/protocol-config
async fn admin_protocol_config(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(err) = require_admin(&headers, &s) {
        return err.into_response();
    }

    api_err(
        StatusCode::NOT_IMPLEMENTED,
        "Shared protocol config writes are not implemented yet",
    )
    .into_response()
}

// Router
pub fn setup_router(
    pool: PgPool,
    user_service: UserService,
    admin_username: String,
    admin_password: String,
    chain_sync: Option<Arc<ChainSyncService>>,
    liquidation_bot: Option<Arc<LiquidationBotService>>,
    cache: Arc<CacheService>,
    realtime: Arc<RealtimeHub>,
) -> Router {
    let state = Arc::new(AppState {
        pool,
        user_service,
        admin_username,
        admin_password,
        chain_sync,
        liquidation_bot,
        cache,
        realtime,
    });
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/api/health", get(health))
        .route("/api/config", get(config))
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/users/login", post(login))
        .route("/api/users/:wallet", get(get_user))
        .route("/api/users/:wallet/referrals", get(get_user_referrals))
        .route("/api/price/latest", get(price_latest))
        .route("/api/price/history", get(price_history))
        .route("/api/trades", get(get_trades))
        .route("/api/trades/sync", post(trades_sync))
        .route("/api/admin/overview", get(admin_overview))
        .route("/api/admin/users", get(admin_users))
        .route("/api/admin/users/:wallet", get(admin_user_detail))
        .route("/api/admin/trades", get(admin_trades))
        .route("/api/admin/trades/:id", get(admin_trade_detail))
        .route("/api/admin/stats", get(admin_stats))
        .route("/api/admin/bot/logs", get(admin_bot_logs))
        .route("/api/admin/protocol-config", post(admin_protocol_config))
        .with_state(state)
        .layer(tower_http::cors::CorsLayer::permissive())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;

    fn admin_header_value() -> String {
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("admin:admin123")
        )
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn test_health_check(pool: PgPool) {
        let user_service = UserService::new(pool.clone());
        let cache = Arc::new(CacheService::new("redis://127.0.0.1:6379").unwrap());
        let realtime = Arc::new(RealtimeHub::new());
        let app = setup_router(pool, user_service, "admin".into(), "admin123".into(), None, None, cache, realtime);

        let req = Request::builder()
            .uri("/api/health")
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn test_admin_stats_requires_auth(pool: PgPool) {
        let user_service = UserService::new(pool.clone());
        let cache = Arc::new(CacheService::new("redis://127.0.0.1:6379").unwrap());
        let realtime = Arc::new(RealtimeHub::new());
        let app = setup_router(pool, user_service, "admin".into(), "admin123".into(), None, None, cache, realtime);

        let req = Request::builder()
            .uri("/api/admin/stats")
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn test_admin_stats_with_auth(pool: PgPool) {
        let user_service = UserService::new(pool.clone());
        let cache = Arc::new(CacheService::new("redis://127.0.0.1:6379").unwrap());
        let realtime = Arc::new(RealtimeHub::new());
        let app = setup_router(pool, user_service, "admin".into(), "admin123".into(), None, None, cache, realtime);

        let req = Request::builder()
            .uri("/api/admin/stats")
            .header(header::AUTHORIZATION, admin_header_value())
            .body(axum::body::Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
}
