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

/// Construit et valide un point de position à partir d'un payload brut.
pub fn build_location_point(
    device_id: &str,
    body: Option<&Value>,
) -> Result<Map<String, Value>, &'static str> {
    let field = |name: &str| match body {
        Some(Value::Object(map)) => map.get(name),
        _ => None,
    };
    let latitude = field("latitude");
    let longitude = field("longitude");
    let timestamp = field("timestamp");

    if latitude.is_none() || longitude.is_none() || !js::truthy(timestamp) {
        return Err("Missing required fields");
    }
    let lat = js::to_number(latitude);
    let lon = js::to_number(longitude);
    // Comparaisons explicites : une coordonnée NaN est acceptée, comme en JS.
    #[allow(clippy::manual_range_contains)]
    let out_of_range = lat < -90.0 || lat > 90.0 || lon < -180.0 || lon > 180.0;
    if out_of_range {
        return Err("Invalid coordinates");
    }

    let optional = |name: &str| field(name).cloned().unwrap_or(Value::Null);
    let source = field("source")
        .filter(|v| js::truthy(Some(v)))
        .cloned()
        .unwrap_or_else(|| Value::String("unknown".into()));

    let mut point = Map::new();
    point.insert("latitude".into(), latitude.cloned().unwrap_or(Value::Null));
    point.insert(
        "longitude".into(),
        longitude.cloned().unwrap_or(Value::Null),
    );
    point.insert(
        "timestamp".into(),
        timestamp.cloned().unwrap_or(Value::Null),
    );
    point.insert("device_id".into(), Value::String(device_id.to_string()));
    point.insert(
        "updated_at".into(),
        Value::String(iso_string(chrono::Utc::now())),
    );
    point.insert("source".into(), source);
    point.insert("altitude".into(), optional("altitude"));
    point.insert("accuracy".into(), optional("accuracy"));
    point.insert("speed".into(), optional("speed"));
    point.insert("heading".into(), optional("heading"));
    Ok(point)
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

/// Diffuse le point aux clients web puis l'écrit en base (sans attendre).
pub fn ingest_location_point(state: &AppState, point: Map<String, Value>) {
    let point = Value::Object(point);
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(err) = state.io().emit("location_update", &point).await {
            eprintln!("[GPS] Erreur diffusion location_update: {err}");
        }

        let mut latest = sqlx::query(
            "INSERT INTO gps_latest (device_id, latitude, longitude, altitude, accuracy, speed, heading, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE latitude=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(latitude), latitude), longitude=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(longitude), longitude), altitude=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(altitude), altitude), accuracy=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(accuracy), accuracy), speed=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(speed), speed), heading=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(heading), heading), source=IF(VALUES(timestamp) >= COALESCE(timestamp, 0), VALUES(source), source), timestamp=GREATEST(COALESCE(timestamp, 0), VALUES(timestamp))",
        );
        // À 10 Hz, les écritures (une tâche par point) peuvent se terminer
        // dans le désordre : `timestamp` est mis à jour en dernier pour que
        // les IF ci-dessus comparent à l'ancienne valeur, et un point plus
        // ancien n'écrase jamais la dernière position connue.
        for column in POINT_COLUMNS {
            latest = bind_json(latest, point.get(column));
        }
        let mut track = sqlx::query(
            "INSERT INTO gps_track (device_id, latitude, longitude, altitude, accuracy, speed, heading, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for column in POINT_COLUMNS {
            track = bind_json(track, point.get(column));
        }

        let (latest_res, track_res) =
            tokio::join!(latest.execute(&state.pool), track.execute(&state.pool));
        if let Err(err) = latest_res {
            eprintln!("[GPS] Erreur écriture gps_latest: {err}");
        }
        if let Err(err) = track_res {
            eprintln!("[GPS] Erreur écriture gps_track: {err}");
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

    // Format compact : la trace ne transporte que [lat, lng, timestamp] par
    // point, seul le dernier point garde toutes ses colonnes (fiche du tracteur).
    let mut positions = Map::new();
    for row in &rows {
        let row = db::row_to_json(row);
        let key = js::to_js_string(row.get("device_id"));
        let entry = positions.entry(key).or_insert_with(|| {
            let mut device = Map::new();
            device.insert("track".into(), Value::Array(Vec::new()));
            device.insert("last".into(), Value::Null);
            Value::Object(device)
        });
        let Value::Object(device) = entry else {
            continue;
        };
        let sample = Value::Array(vec![
            js::number_value(js::to_number(row.get("latitude"))),
            js::number_value(js::to_number(row.get("longitude"))),
            js::number_value(js::to_number(row.get("timestamp"))),
        ]);
        if let Some(Value::Array(track)) = device.get_mut("track") {
            track.push(sample);
        }
        device.insert("last".into(), Value::Object(row));
    }
    Ok(js::js_key_order(positions))
}

pub async fn get_history_dates(state: &AppState) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT DISTINCT DATE_FORMAT(FROM_UNIXTIME(timestamp / 1000), '%Y-%m-%d') AS date FROM gps_track ORDER BY date DESC",
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

    #[test]
    fn position_log_is_throttled() {
        let log = PositionLog::default();
        assert_eq!(log.should_log("7724"), Some(0));
        assert_eq!(log.should_log("7724"), None);
        assert_eq!(log.should_log("7724"), None);
        assert_eq!(log.should_log("7725"), Some(0));
    }
}
