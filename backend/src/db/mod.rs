pub mod models;

use sqlx::{postgres::PgPoolOptions, PgPool};
use anyhow::{Result, Context};
use std::env;

pub async fn connect() -> Result<PgPool> {
    let database_url = env::var("DATABASE_URL").context("DATABASE_URL must be set in .env")?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await
        .context("Failed to connect to the database")?;
    Ok(pool)
}
