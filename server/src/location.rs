//! Store partagé des positions GPS (persistance MariaDB).
//!
//! Utilisé à la fois par la route HTTP `POST /api/location` (conservée pour
//! compatibilité/tests) et par l'événement Socket.IO `location` (canal de la
//! tablette RTK).

use serde_json::{Map, Value};

use crate::db::{self, bind_json, iso_string};
use crate::js;
use crate::state::AppState;

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
            "INSERT INTO gps_latest (device_id, latitude, longitude, altitude, accuracy, speed, heading, source, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE latitude=VALUES(latitude), longitude=VALUES(longitude), altitude=VALUES(altitude), accuracy=VALUES(accuracy), speed=VALUES(speed), heading=VALUES(heading), source=VALUES(source), timestamp=VALUES(timestamp)",
        );
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
