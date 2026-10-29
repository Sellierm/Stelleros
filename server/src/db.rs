//! Pool MariaDB et conversions ligne → JSON.
//!
//! Les conversions reproduisent les types renvoyés par `mysql2` côté Node :
//! entiers et flottants en nombres, DECIMAL en chaîne, DATE/DATETIME/TIMESTAMP
//! en date ISO (heure locale du serveur interprétée comme le faisait mysql2),
//! colonnes JSON parsées, le reste en chaîne.

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike, Utc};
use serde_json::{Map, Value};
use sqlx::mysql::{MySqlArguments, MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::query::Query;
use sqlx::{Column, MySql, Row, TypeInfo, ValueRef};

use crate::config::DbConfig;
use crate::js;

pub type DbQuery<'q> = Query<'q, MySql, MySqlArguments>;

pub fn create_pool(cfg: &DbConfig) -> MySqlPool {
    let mut options = MySqlConnectOptions::new()
        .host(&cfg.host)
        .port(cfg.port)
        .username(&cfg.user)
        .password(&cfg.password)
        // Pas de `SET time_zone` : la session garde le fuseau du serveur,
        // exactement comme mysql2. Les TIMESTAMP existants restent cohérents.
        .timezone(None)
        .pipes_as_concat(false)
        .no_engine_substitution(false);
    if let Some(database) = &cfg.database {
        options = options.database(database);
    }
    MySqlPoolOptions::new()
        .max_connections(10)
        .connect_lazy_with(options)
}

/// Applique les migrations de `server/migrations` (embarquées à la compilation).
///
/// Une migration déjà appliquée mais inconnue de ce binaire est tolérée : c'est
/// le cas après un retour à une image précédente (deploy/retour-arriere.sh).
/// Les migrations doivent donc rester compatibles avec le code d'avant
/// (ajouts plutôt que suppressions ou renommages).
pub async fn migrate(pool: &MySqlPool) -> Result<(), sqlx::migrate::MigrateError> {
    let mut migrator = sqlx::migrate!();
    migrator.set_ignore_missing(true);
    migrator.run(pool).await
}

/// Interprète une date/heure naïve comme heure locale (comportement mysql2).
pub fn local_naive_to_utc(naive: NaiveDateTime) -> DateTime<Utc> {
    match Local.from_local_datetime(&naive).earliest() {
        Some(dt) => dt.with_timezone(&Utc),
        None => {
            // Heure inexistante (passage à l'heure d'été) : on avance d'une heure.
            let shifted = naive + chrono::Duration::hours(1);
            Local
                .from_local_datetime(&shifted)
                .earliest()
                .map(|dt| dt.with_timezone(&Utc))
                .unwrap_or_else(|| Utc.from_utc_datetime(&naive))
        }
    }
}

/// Date/heure locale tronquée à la milliseconde (précision TIMESTAMP(3)),
/// format sous lequel mysql2 écrivait les objets `Date`.
pub fn local_naive_from_utc(dt: DateTime<Utc>) -> NaiveDateTime {
    let naive = dt.with_timezone(&Local).naive_local();
    naive
        .with_nanosecond(naive.nanosecond() / 1_000_000 * 1_000_000)
        .unwrap_or(naive)
}

/// Format de `Date.prototype.toISOString()`.
pub fn iso_string(dt: DateTime<Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn decode_column(row: &MySqlRow, idx: usize) -> Value {
    let Ok(raw) = row.try_get_raw(idx) else {
        return Value::Null;
    };
    if raw.is_null() {
        return Value::Null;
    }
    let type_name = raw.type_info().name().to_string();
    let decoded = match type_name.as_str() {
        "BOOLEAN" | "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "BIGINT" | "YEAR" => {
            row.try_get_unchecked::<i64, _>(idx).map(Value::from).ok()
        }
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "MEDIUMINT UNSIGNED"
        | "BIGINT UNSIGNED" => row.try_get_unchecked::<u64, _>(idx).map(Value::from).ok(),
        "FLOAT" => row.try_get_unchecked::<f32, _>(idx).map(js::clean_f32).ok(),
        "DOUBLE" => row
            .try_get_unchecked::<f64, _>(idx)
            .map(js::number_value)
            .ok(),
        "DECIMAL" => row
            .try_get_unchecked::<String, _>(idx)
            .map(Value::String)
            .ok(),
        "DATE" => row
            .try_get_unchecked::<NaiveDate, _>(idx)
            .ok()
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .map(|n| Value::String(iso_string(local_naive_to_utc(n)))),
        "DATETIME" | "TIMESTAMP" => row
            .try_get_unchecked::<NaiveDateTime, _>(idx)
            .ok()
            .map(|n| Value::String(iso_string(local_naive_to_utc(n)))),
        "TIME" => row
            .try_get_unchecked::<NaiveTime, _>(idx)
            .ok()
            .map(|t| Value::String(t.format("%H:%M:%S").to_string())),
        "JSON" => row
            .try_get_unchecked::<String, _>(idx)
            .ok()
            .map(|s| serde_json::from_str(&s).unwrap_or(Value::String(s))),
        "NULL" => Some(Value::Null),
        _ => row
            .try_get_unchecked::<Vec<u8>, _>(idx)
            .ok()
            .map(|bytes| Value::String(String::from_utf8_lossy(&bytes).into_owned())),
    };
    decoded.unwrap_or(Value::Null)
}

/// Convertit une ligne en objet JSON (équivalent d'une ligne mysql2).
pub fn row_to_json(row: &MySqlRow) -> Map<String, Value> {
    let mut map = Map::new();
    for (idx, column) in row.columns().iter().enumerate() {
        map.insert(column.name().to_string(), decode_column(row, idx));
    }
    map
}

pub fn rows_to_json(rows: &[MySqlRow]) -> Vec<Value> {
    rows.iter().map(|r| Value::Object(row_to_json(r))).collect()
}

/// Lie une valeur JSON comme le faisait mysql2 (`undefined`/`null` → NULL).
pub fn bind_json<'q>(query: DbQuery<'q>, value: Option<&Value>) -> DbQuery<'q> {
    match value {
        None | Some(Value::Null) => query.bind(None::<String>),
        Some(Value::Bool(b)) => query.bind(*b),
        Some(Value::Number(n)) => {
            if let Some(i) = n.as_i64() {
                query.bind(i)
            } else if let Some(u) = n.as_u64() {
                query.bind(u)
            } else {
                query.bind(n.as_f64().unwrap_or(0.0))
            }
        }
        Some(Value::String(s)) => query.bind(s.clone()),
        Some(other) => query.bind(other.to_string()),
    }
}
