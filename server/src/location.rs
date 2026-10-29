//! Store partagé des positions GPS (persistance MariaDB).
//!
//! Utilisé à la fois par la route HTTP `POST /api/location` (conservée pour
//! compatibilité/tests) et par l'événement Socket.IO `location` (canal de la
//! tablette RTK).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::db::{self, bind_json, iso_string};
use crate::js;
use crate::state::AppState;
use crate::track::{TrackPoint, simplify};

/// Points acceptés par seconde et par device. Les devices émettent à 10, 5,
/// 2, 1, 0,5, 0,2 Hz ou toutes les 10 s : 10 Hz nominal + 20 % de marge pour
/// la gigue réseau, sinon un point à 10 Hz pile serait parfois rejeté.
pub const MAX_POINTS_PER_SEC: u32 = 12;

/// Intervalle minimal entre deux lignes "Position reçue" pour un device.
const POSITION_LOG_INTERVAL: Duration = Duration::from_secs(10);

/// Limite le journal des positions : à 10 Hz, une ligne par point noierait
/// les logs. On journalise au plus un point par intervalle et par device,
/// avec le nombre de points reçus entre-temps.
#[derive(Default)]
pub struct PositionLog {
    devices: Mutex<HashMap<String, (Instant, u32)>>,
}

impl PositionLog {
    /// `Some(n)` si ce point doit être journalisé (`n` = points non
    /// journalisés depuis la dernière ligne), `None` sinon.
    pub fn should_log(&self, device_id: &str) -> Option<u32> {
        let now = Instant::now();
        let mut devices = self.devices.lock().unwrap_or_else(|e| e.into_inner());
        match devices.get_mut(device_id) {
            Some((last, skipped)) if now.duration_since(*last) < POSITION_LOG_INTERVAL => {
                *skipped += 1;
                None
            }
            Some(entry) => {
                let skipped = entry.1;
                *entry = (now, 0);
                Some(skipped)
            }
            None => {
                devices.insert(device_id.to_string(), (now, 0));
                Some(0)
            }
        }
    }
}

/// Journalise un point accepté, en respectant [`PositionLog`].
pub fn log_point(state: &AppState, ip: &str, channel: &str, point: &Map<String, Value>) {
    let device_id = js::to_js_string(point.get("device_id"));
    let Some(skipped) = state.position_log.should_log(&device_id) else {
        return;
    };
    let extra = if skipped > 0 {
        format!(" (+{skipped} points depuis le dernier log)")
    } else {
        String::new()
    };
    crate::middleware::auth_log(
        ip,
        "OK",
        &format!("Position reçue ({channel}) : {}{extra}", fmt_point(point)),
    );
}

/// Ancienneté maximale d'un point accepté : couvre une longue coupure réseau
/// pendant laquelle la tablette a gardé ses positions en file.
const MAX_POINT_AGE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Avance tolérée sur l'horloge du serveur (dérive d'horloge du device).
const MAX_POINT_FUTURE_MS: i64 = 60 * 1000;
/// Longueur de la colonne `source` : au-delà, l'insert échouerait.
const SOURCE_MAX_CHARS: usize = 30;
/// Points maximum par événement `location_batch`.
pub const MAX_BATCH_POINTS: usize = 100;

/// Nombre fini uniquement (nombre JSON ou chaîne numérique) : `null`, `""`,
/// booléens, NaN et infinis sont refusés.
fn finite_number(value: Option<&Value>) -> Option<f64> {
    let f = match value? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) if !s.trim().is_empty() => js::string_to_number(s),
        _ => return None,
    };
    f.is_finite().then_some(f)
}

/// Construit et valide un point de position à partir d'un payload brut.
///
/// Toute valeur pouvant faire échouer l'insert est refusée ou neutralisée ici :
/// l'ack n'étant envoyé qu'après l'écriture, un point inscriptible serait
/// sinon renvoyé indéfiniment par la tablette.
pub fn build_location_point(
    device_id: &str,
    body: Option<&Value>,
) -> Result<Map<String, Value>, &'static str> {
    build_location_point_at(device_id, body, chrono::Utc::now())
}

fn build_location_point_at(
    device_id: &str,
    body: Option<&Value>,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Map<String, Value>, &'static str> {
    let field = |name: &str| match body {
        Some(Value::Object(map)) => map.get(name),
        _ => None,
    };
    let (Some(lat), Some(lon), Some(timestamp)) = (
        finite_number(field("latitude")),
        finite_number(field("longitude")),
        finite_number(field("timestamp")),
    ) else {
        return Err("Missing required fields");
    };
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return Err("Invalid coordinates");
    }
    let now_ms = now.timestamp_millis();
    let timestamp = timestamp.trunc() as i64;
    if timestamp < now_ms - MAX_POINT_AGE_MS || timestamp > now_ms + MAX_POINT_FUTURE_MS {
        return Err("Invalid timestamp");
    }

    // Champs facultatifs : une valeur non numérique devient `null`.
    let optional = |name: &str| {
        finite_number(field(name))
            .map(js::number_value)
            .unwrap_or(Value::Null)
    };
    let source = match field("source") {
        Some(Value::String(s)) if !s.is_empty() => s.chars().take(SOURCE_MAX_CHARS).collect(),
        _ => "unknown".to_string(),
    };

    let mut point = Map::new();
    point.insert("latitude".into(), js::number_value(lat));
    point.insert("longitude".into(), js::number_value(lon));
    point.insert("timestamp".into(), Value::from(timestamp));
    point.insert("device_id".into(), Value::String(device_id.to_string()));
    point.insert("updated_at".into(), Value::String(iso_string(now)));
    point.insert("source".into(), Value::String(source));
    point.insert("altitude".into(), optional("altitude"));
    point.insert("accuracy".into(), optional("accuracy"));
    point.insert("speed".into(), optional("speed"));
    point.insert("heading".into(), optional("heading"));
    Ok(point)
}

/// Vérifie qu'un lot ne contient pas plus de points que la cadence maximale
/// ne peut en produire sur l'intervalle couvert par ses timestamps (+ 1 s).
/// La limite porte ainsi sur les positions et non sur les messages : un lot de
/// rattrapage après coupure passe, un flux trop dense est refusé.
pub fn batch_density_ok(points: &[Map<String, Value>]) -> bool {
    let timestamps = points
        .iter()
        .filter_map(|p| p.get("timestamp").and_then(Value::as_i64));
    let (min, max) = timestamps.fold((i64::MAX, i64::MIN), |(lo, hi), t| (lo.min(t), hi.max(t)));
    if min > max {
        return true;
    }
    let span_secs = ((max - min) as u64).div_ceil(1000) + 1;
    points.len() as u64 <= u64::from(MAX_POINTS_PER_SEC) * span_secs
}

/// Résumé d'un point pour les journaux.
pub fn fmt_point(point: &Map<String, Value>) -> String {
    let fixed6 = |name: &str| {
        let f = js::to_number(point.get(name));
        if f.is_finite() {
            format!("{f:.6}")
        } else {
            js::num_to_string(f)
        }
    };
    format!(
        "device={} lat={} lon={} source={}",
        js::to_js_string(point.get("device_id")),
        fixed6("latitude"),
        fixed6("longitude"),
        js::to_js_string(point.get("source")),
    )
}

const POINT_COLUMNS: [&str; 9] = [
    "device_id",
    "latitude",
    "longitude",
    "altitude",
    "accuracy",
    "speed",
    "heading",
    "source",
    "timestamp",
];

/// Room Socket.IO des clients web : les positions ne sont pas renvoyées aux
/// devices GPS (économie de données mobiles).
pub const WEB_ROOM: &str = "web";

/// Écrit les points en base. Le device ne doit être acquitté qu'une fois ce
/// futur résolu sans erreur : sinon il garde les points et les renverra.
///
/// `INSERT IGNORE` + clé unique `(device_id, timestamp)` : un point renvoyé
/// faute d'ack (timeout réseau) n'est pas enregistré deux fois.
pub async fn store_points(
    state: &AppState,
    points: &[Map<String, Value>],
) -> Result<(), sqlx::Error> {
    let Some(newest) = points
        .iter()
        .max_by_key(|p| p.get("timestamp").and_then(Value::as_i64))
    else {
        return Ok(());
    };

    let row = format!("({})", vec!["?"; POINT_COLUMNS.len()].join(", "));
    let track_sql = format!(
        "INSERT IGNORE INTO gps_track ({}) VALUES {}",
        POINT_COLUMNS.join(", "),
        vec![row.as_str(); points.len()].join(", ")
    );
    let mut track = sqlx::query(&track_sql);
    for point in points {
        for column in POINT_COLUMNS {
            track = bind_json(track, point.get(column));
        }
    }

    let mut latest = sqlx::query(
        "INSERT INTO gps_latest (device_id, latitude, longitude, altitude, accuracy, speed, heading, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE latitude=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(latitude), latitude), longitude=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(longitude), longitude), altitude=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(altitude), altitude), accuracy=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(accuracy), accuracy), speed=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(speed), speed), heading=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(heading), heading), source=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(source), source), timestamp=GREATEST(COALESCE(timestamp, 0), VALUES(timestamp))",
    );
    // Les écritures de deux messages successifs peuvent se terminer dans le
    // désordre : `timestamp` est mis à jour en dernier pour que les IF
    // ci-dessus comparent à l'ancienne valeur, et un point plus ancien
    // n'écrase jamais la dernière position connue.
    for column in POINT_COLUMNS {
        latest = bind_json(latest, newest.get(column));
    }

    let (track_res, latest_res) =
        tokio::join!(track.execute(&state.pool), latest.execute(&state.pool));
    if let Err(err) = &track_res {
        eprintln!("[GPS] Erreur écriture gps_track: {err}");
    }
    if let Err(err) = &latest_res {
        eprintln!("[GPS] Erreur écriture gps_latest: {err}");
    }
    track_res?;
    latest_res?;
    // Liste des jours de l'historique : une erreur ici ne doit pas faire
    // renvoyer les points (déjà enregistrés), la compaction recalcule ces jours.
    if let Err(err) = crate::track::record_days(state, points).await {
        eprintln!("[GPS] Erreur écriture gps_days: {err}");
    }
    Ok(())
}

/// Diffuse les points enregistrés aux seuls clients web (sans attendre).
pub fn broadcast_points(state: &AppState, points: Vec<Map<String, Value>>) {
    let state = state.clone();
    tokio::spawn(async move {
        for point in points {
            let point = Value::Object(point);
            if let Err(err) = state
                .io()
                .to(WEB_ROOM)
                .emit("location_update", &point)
                .await
            {
                eprintln!("[GPS] Erreur diffusion location_update: {err}");
            }
        }
    });
}

pub async fn get_positions(state: &AppState) -> Result<Map<String, Value>, sqlx::Error> {
    let rows = sqlx::query("SELECT * FROM gps_latest")
        .fetch_all(&state.pool)
        .await?;
    let mut positions = Map::new();
    for row in &rows {
        let row = db::row_to_json(row);
        let key = js::to_js_string(row.get("device_id"));
        positions.insert(key, Value::Object(row));
    }
    Ok(js::js_key_order(positions))
}

pub async fn get_history(
    state: &AppState,
    day_start: i64,
    day_end: i64,
) -> Result<Map<String, Value>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT device_id, latitude, longitude, altitude, accuracy, speed, heading, source, timestamp FROM gps_track WHERE timestamp >= ? AND timestamp < ? ORDER BY device_id, timestamp ASC",
    )
    .bind(day_start)
    .bind(day_end)
    .fetch_all(&state.pool)
    .await?;

    // Lignes groupées par device (ordre de la requête).
    let mut devices: Vec<(String, Vec<Map<String, Value>>)> = Vec::new();
    for row in &rows {
        let row = db::row_to_json(row);
        let key = js::to_js_string(row.get("device_id"));
        match devices.last_mut() {
            Some((id, rows)) if *id == key => rows.push(row),
            _ => devices.push((key, vec![row])),
        }
    }

    // Format compact : la trace ne transporte que [lat, lng, timestamp] par
    // point, seul le dernier point garde toutes ses colonnes (fiche du tracteur).
    // La trace est simplifiée à la précision des mesures (jour en cours, pas
    // encore compacté) : aucun écart visible, beaucoup moins de points.
    let mut positions = Map::new();
    for (key, rows) in devices {
        let track_points: Vec<TrackPoint> = rows
            .iter()
            .map(|row| TrackPoint {
                latitude: js::to_number(row.get("latitude")),
                longitude: js::to_number(row.get("longitude")),
                accuracy: row.get("accuracy").and_then(Value::as_f64),
                timestamp: row.get("timestamp").and_then(Value::as_i64).unwrap_or(0),
                source: row
                    .get("source")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
            .collect();
        let kept = tokio::task::spawn_blocking(move || simplify(&track_points))
            .await
            .unwrap_or_else(|_| (0..rows.len()).collect());
        let track: Vec<Value> = kept
            .iter()
            .map(|&i| {
                let row = &rows[i];
                Value::Array(vec![
                    js::number_value(js::to_number(row.get("latitude"))),
                    js::number_value(js::to_number(row.get("longitude"))),
                    js::number_value(js::to_number(row.get("timestamp"))),
                ])
            })
            .collect();
        let mut device = Map::new();
        device.insert("track".into(), Value::Array(track));
        device.insert(
            "last".into(),
            rows.last()
                .cloned()
                .map(Value::Object)
                .unwrap_or(Value::Null),
        );
        positions.insert(key, Value::Object(device));
    }
    Ok(js::js_key_order(positions))
}

pub async fn get_history_dates(state: &AppState) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT DISTINCT DATE_FORMAT(day, '%Y-%m-%d') AS date FROM gps_days ORDER BY date DESC",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row| db::row_to_json(row).remove("date").unwrap_or(Value::Null))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::middleware::RateLimiter;

    #[test]
    fn device_limit_allows_10_hz_with_margin() {
        let limiter = RateLimiter::new(Duration::from_secs(1), MAX_POINTS_PER_SEC, "");
        for _ in 0..MAX_POINTS_PER_SEC {
            assert!(limiter.hit("7724").into_result().is_ok());
        }
        assert!(limiter.hit("7724").into_result().is_err());
        // Un autre device a son propre quota.
        assert!(limiter.hit("7725").into_result().is_ok());
    }

    fn point(body: Value) -> Result<Map<String, Value>, &'static str> {
        let now = chrono::DateTime::from_timestamp_millis(1_800_000_000_000).unwrap();
        build_location_point_at("7724", Some(&body), now)
    }

    #[test]
    fn validation_rejects_invalid_values() {
        let ts = 1_800_000_000_000_i64;
        assert!(
            point(serde_json::json!({ "latitude": 48.1, "longitude": -1.6, "timestamp": ts }))
                .is_ok()
        );
        // Coordonnées NaN/null/non numériques.
        assert!(
            point(serde_json::json!({ "latitude": "NaN", "longitude": -1.6, "timestamp": ts }))
                .is_err()
        );
        assert!(
            point(serde_json::json!({ "latitude": null, "longitude": -1.6, "timestamp": ts }))
                .is_err()
        );
        assert!(
            point(serde_json::json!({ "latitude": 91, "longitude": -1.6, "timestamp": ts }))
                .is_err()
        );
        // Timestamp non numérique, trop ancien ou dans le futur.
        assert!(
            point(serde_json::json!({ "latitude": 48.1, "longitude": -1.6, "timestamp": "abc" }))
                .is_err()
        );
        assert!(point(serde_json::json!({ "latitude": 48.1, "longitude": -1.6, "timestamp": ts - 8 * 86_400_000 })).is_err());
        assert!(point(serde_json::json!({ "latitude": 48.1, "longitude": -1.6, "timestamp": ts + 120_000 })).is_err());
    }

    #[test]
    fn validation_neutralizes_optional_fields() {
        let p = point(serde_json::json!({
            "latitude": "48.1", "longitude": -1.6, "timestamp": 1_800_000_000_000_i64,
            "speed": "fast", "heading": 90, "source": "x".repeat(50),
        }))
        .unwrap();
        assert_eq!(p["latitude"], serde_json::json!(48.1));
        assert_eq!(p["speed"], Value::Null);
        assert_eq!(p["heading"], serde_json::json!(90));
        assert_eq!(
            p["source"].as_str().unwrap().chars().count(),
            SOURCE_MAX_CHARS
        );
    }

    #[test]
    fn batch_density() {
        let at = |ts: i64| {
            let mut p = Map::new();
            p.insert("timestamp".into(), Value::from(ts));
            p
        };
        // 50 points à 10 Hz (4,9 s) : accepté.
        let catch_up: Vec<_> = (0..50).map(|i| at(i * 100)).collect();
        assert!(batch_density_ok(&catch_up));
        // 50 points sur la même seconde : refusé.
        let burst: Vec<_> = (0..50).map(|i| at(i * 10)).collect();
        assert!(!batch_density_ok(&burst));
    }

    #[test]
    fn position_log_is_throttled() {
        let log = PositionLog::default();
        assert_eq!(log.should_log("7724"), Some(0));
        assert_eq!(log.should_log("7724"), None);
        assert_eq!(log.should_log("7724"), None);
        assert_eq!(log.should_log("7725"), Some(0));
    }
}
