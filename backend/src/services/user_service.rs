use crate::db::models::User;
use crate::lib::utils::{normalize_address, random_referral_code};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
use std::collections::HashSet;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FormattedUser {
    pub id: i32,
    pub wallet_address: String,
    pub referral_code: String,
    pub referred_by: Option<i32>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub total_trading_volume: String,
}

impl From<User> for FormattedUser {
    fn from(user: User) -> Self {
        Self {
            id: user.id,
            wallet_address: user.wallet_address,
            referral_code: user.referral_code,
            referred_by: user.referred_by,
            created_at: chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(user.created_at, chrono::Utc),
            total_trading_volume: user.total_trading_volume.to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReferralResult {
    pub attempted: bool,
    pub status: String,
    pub code: String,
    pub message: String,
    pub referrer_wallet_address: Option<String>,
    pub referrer_code: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub user: FormattedUser,
    pub referral: ReferralResult,
}

#[derive(Clone)]
pub struct UserService {
    pub pool: PgPool,
}

impl UserService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    fn referral_code_candidates(wallet_address: &str, attempts: usize) -> Vec<String> {
        let clean = wallet_address.trim_start_matches("0x").to_uppercase();
        let mut candidates = Vec::new();
        if clean.len() >= 40 {
            candidates.push(clean[0..8].to_string());
            candidates.push(clean[8..16].to_string());
            candidates.push(clean[16..24].to_string());
            candidates.push(clean[24..32].to_string());
            candidates.push(clean[32..40].to_string());
            candidates.push(format!("{}{}", &clean[0..4], &clean[36..40]));
        }
        candidates.retain(|c| c.len() == 8);
        while candidates.len() < attempts {
            candidates.push(random_referral_code(8));
        }
        let mut unique: Vec<String> = Vec::new();
        for c in candidates {
            if !unique.contains(&c) { unique.push(c); }
        }
        unique.into_iter().take(attempts).collect()
    }

    pub async fn ensure_user(&self, wallet_address: &str, tx: &mut Transaction<'_, Postgres>) -> Result<User> {
        let normalized = normalize_address(wallet_address)?;
        for code in Self::referral_code_candidates(&normalized, 12) {
            sqlx::query(r#"INSERT INTO "User" ("walletAddress", "referralCode") VALUES ($1, $2) ON CONFLICT DO NOTHING"#)
                .bind(&normalized)
                .bind(&code)
                .execute(&mut **tx)
                .await?;

            let row: Option<User> = sqlx::query_as(r#"SELECT * FROM "User" WHERE "walletAddress" = $1"#)
                .bind(&normalized)
                .fetch_optional(&mut **tx)
                .await?;

            if let Some(user) = row {
                return Ok(user);
            }
        }
        Err(anyhow!("Failed to create user after retries"))
    }

    async fn would_create_referral_cycle(tx: &mut Transaction<'_, Postgres>, user_id: i32, candidate_referrer_id: i32) -> Result<bool> {
        let mut current_id = Some(candidate_referrer_id);
        let mut seen = HashSet::new();
        while let Some(id) = current_id {
            if id == user_id { return Ok(true); }
            if seen.contains(&id) { return Ok(true); }
            seen.insert(id);
            let row = sqlx::query!(r#"SELECT "referredBy" FROM "User" WHERE id = $1"#, id)
                .fetch_optional(&mut **tx).await?;
            current_id = row.and_then(|r| r.referredBy);
        }
        Ok(false)
    }

    pub async fn login(&self, wallet_address: &str, referral_code_input: Option<&str>) -> Result<LoginResult> {
        let mut tx = self.pool.begin().await?;
        let normalized = normalize_address(wallet_address)?;
        let mut user = self.ensure_user(&normalized, &mut tx).await?;

        let referral_code = referral_code_input.unwrap_or("").trim().to_uppercase();
        let mut referral = ReferralResult { status: "none".to_string(), ..Default::default() };

        if !referral_code.is_empty() {
            referral.attempted = true;
            referral.code = referral_code.clone();

            if let Some(ref_by) = user.referred_by {
                let existing = sqlx::query!(r#"SELECT "walletAddress", "referralCode" FROM "User" WHERE id = $1"#, ref_by)
                    .fetch_optional(&mut *tx).await?;
                referral.status = "already_set".to_string();
                referral.message = "Referrer is already set and cannot be changed.".to_string();
                if let Some(e) = existing {
                    referral.referrer_wallet_address = Some(e.walletAddress);
                    referral.referrer_code = Some(e.referralCode);
                }
            } else {
                let referrer = sqlx::query!(r#"SELECT id, "walletAddress", "referralCode" FROM "User" WHERE "referralCode" = $1"#, referral_code)
                    .fetch_optional(&mut *tx).await?;

                if let Some(r) = referrer {
                    if r.id == user.id {
                        referral.status = "self_referral".to_string();
                        referral.message = "Self referral is not allowed.".to_string();
                    } else if Self::would_create_referral_cycle(&mut tx, user.id, r.id).await? {
                        referral.status = "circular_referral".to_string();
                        referral.message = "Circular referral is not allowed.".to_string();
                    } else {
                        sqlx::query!(r#"UPDATE "User" SET "referredBy" = $1 WHERE id = $2"#, r.id, user.id)
                            .execute(&mut *tx).await?;
                        user = sqlx::query_as(r#"SELECT * FROM "User" WHERE id = $1"#)
                            .bind(user.id)
                            .fetch_one(&mut *tx).await?;
                        referral.status = "applied".to_string();
                        referral.message = "Referral applied.".to_string();
                        referral.referrer_wallet_address = Some(r.walletAddress);
                        referral.referrer_code = Some(r.referralCode);
                    }
                } else {
                    referral.status = "not_found".to_string();
                    referral.message = "Referral code not found.".to_string();
                }
            }
        }

        tx.commit().await?;
        Ok(LoginResult { user: user.into(), referral })
    }

    pub async fn get_by_wallet(&self, wallet_address: &str) -> Result<Option<FormattedUser>> {
        let normalized = normalize_address(wallet_address)?;
        let user: Option<User> = sqlx::query_as(r#"SELECT * FROM "User" WHERE "walletAddress" = $1"#)
            .bind(normalized)
            .fetch_optional(&self.pool).await?;
        Ok(user.map(|u| u.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[sqlx::test(migrations = "./migrations")]
    async fn test_user_login_creates_user(pool: PgPool) -> Result<()> {
        let service = UserService::new(pool);
        
        let wallet = "0x9E545E3C0baAB3E08CdfD552C960A1050f373042";
        let result = service.login(wallet, None).await?;
        
        assert_eq!(result.user.wallet_address.to_lowercase(), wallet.to_lowercase());
        
        // Login again should return the same user
        let result_again = service.login(wallet, None).await?;
        assert_eq!(result.user.id, result_again.user.id);
        
        Ok(())
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn test_user_referral_workflow(pool: PgPool) -> Result<()> {
        let service = UserService::new(pool);
        
        // 1. Create a referrer
        let referrer_wallet = "0x1111111111111111111111111111111111111111";
        let r1 = service.login(referrer_wallet, None).await?;
        let ref_code = r1.user.referral_code;

        // 2. Create referred user using the code
        let new_user_wallet = "0x2222222222222222222222222222222222222222";
        let r2 = service.login(new_user_wallet, Some(&ref_code)).await?;

        assert_eq!(r2.referral.status, "applied");
        assert_eq!(r2.referral.referrer_wallet_address.as_ref().unwrap().to_lowercase(), referrer_wallet.to_lowercase());
        assert_eq!(r2.user.referred_by, Some(r1.user.id));

        // 3. Try to self-refer
        let r3 = service.login(referrer_wallet, Some(&ref_code)).await?;
        assert_eq!(r3.referral.status, "self_referral");

        // 4. Try circular referral
        let r4 = service.login(referrer_wallet, Some(&r2.user.referral_code)).await?;
        assert_eq!(r4.referral.status, "circular_referral");

        Ok(())
    }
}
