//! Serveur Socket.IO (namespace `/`).
//!
//! Authentification double :
//!  - Devices GPS (tablette RTK) : identifiés par `deviceId` + clé statique
//!    fournis dans l'objet `auth` du handshake (pas de session/cookie).
//!  - Clients web (React) : authentifiés par la session cookie.

use std::fmt;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use socketioxide::extract::{AckSender, Data, SocketRef, State, TryData};
use socketioxide::handler::ConnectHandler;
use socketioxide::socket::DisconnectReason;

use crate::auth;
use crate::js;
use crate::location::{build_location_point, fmt_point, ingest_location_point};
use crate::middleware::auth_log;
use crate::routes::gps::is_ingest_key_valid;
use crate::sencrop;
use crate::state::AppState;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// L'API horaire refuse plus de 7 jours par requête (HTTP 400).
const MAX_HOURLY_DAYS: i64 = 7;

const VALID_MEASURES: [&str; 9] = [
    "TEMPERATURE",
    "TEMPERATURE_MIN",
    "TEMPERATURE_MAX",
    "RAIN_FALL",
    "RELATIVE_HUMIDITY",
    "WET_TEMPERATURE",
    "WIND_SPEED",
    "WIND_GUST",
    "WIND_DIRECTION",
];

/// Identité attachée au socket après le middleware de connexion.
#[derive(Clone)]
enum Peer {
    Gps { device_id: String },
    Web { username: String },
}

#[derive(Debug)]
struct ConnectError(&'static str);

impl fmt::Display for ConnectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

/// `socket.handshake.address`
fn socket_ip(s: &SocketRef) -> String {
    crate::middleware::peer_ip(&s.req_parts().extensions).unwrap_or_else(|| "unknown".into())
}

fn reason_label(reason: DisconnectReason) -> &'static str {
    match reason {
        DisconnectReason::TransportClose => "transport close",
        DisconnectReason::MultipleHttpPollingError | DisconnectReason::TransportError => {
            "transport error"
        }
        DisconnectReason::PacketParsingError => "parse error",
        DisconnectReason::HeartbeatTimeout => "ping timeout",
        DisconnectReason::ClientNSDisconnect => "client namespace disconnect",
        DisconnectReason::ServerNSDisconnect => "server namespace disconnect",
        DisconnectReason::ClosingServer => "server shutting down",
    }
}

async fn authenticate(
    s: SocketRef,
    State(state): State<AppState>,
    TryData(auth): TryData<Value>,
) -> Result<(), ConnectError> {
    let auth = match auth {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };

    if auth.contains_key("deviceId") || auth.contains_key("key") {
        let Some(ingest_key) = state.cfg.gps_ingest_key.as_deref() else {
            return Err(ConnectError("GPS ingest not configured"));
        };
        let device_id = js::to_js_string(auth.get("deviceId"));
        if !is_ingest_key_valid(ingest_key, auth.get("key"))
            || !state.cfg.gps_allowed_ids.contains(&device_id)
        {
            auth_log(
                &socket_ip(&s),
                "FAIL",
                &format!(
                    "Connexion device GPS refusée : device={device_id} non autorisé ou clé invalide"
                ),
            );
            return Err(ConnectError("Unauthorized device"));
        }
        s.extensions.insert(Peer::Gps { device_id });
        return Ok(());
    }

    match auth::get_session_user(&state, &s.req_parts().headers).await {
        Ok(Some(user)) => {
            let username = user
                .username
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| "inconnu".into());
            s.extensions.insert(Peer::Web { username });
            Ok(())
        }
        _ => Err(ConnectError("Unauthorized")),
    }
}

async fn on_connect(s: SocketRef) {
    let ip = socket_ip(&s);
    match s.extensions.get::<Peer>() {
        Some(Peer::Gps { device_id }) => setup_gps_socket(s, ip, device_id),
        Some(Peer::Web { username }) => setup_web_socket(s, ip, username),
        None => {
            let _ = s.disconnect();
        }
    }
}

// ── Device GPS : uniquement l'événement "location" ────────────────────────

fn setup_gps_socket(s: SocketRef, ip: String, device_id: String) {
    auth_log(
        &ip,
        "INFO",
        &format!("Device GPS connecté : {device_id} (id: {})", s.id),
    );

    let (event_ip, event_device) = (ip.clone(), device_id.clone());
    s.on(
        "location",
        async move |State(state): State<AppState>,
                    TryData(payload): TryData<Value>,
                    ack: AckSender| {
            // Sans payload, Node reçoit le callback d'ack à la place du
            // payload : la position est rejetée et aucun ack n'est envoyé.
            let payload = payload.ok();
            let ack = payload.is_some().then_some(ack);
            match build_location_point(&event_device, payload.as_ref()) {
                Err(error) => {
                    auth_log(
                        &event_ip,
                        "FAIL",
                        &format!("Position rejetée (socket) : device={event_device} — {error}"),
                    );
                    if let Some(ack) = ack {
                        let _ = ack.send(&json!({ "success": false, "message": error }));
                    }
                }
                Ok(point) => {
                    // Ack immédiat avant l'écriture en base : le device a
                    // seulement besoin de savoir que la position est acceptée.
                    if let Some(ack) = ack {
                        let _ = ack.send(&json!({ "success": true }));
                    }
                    auth_log(
                        &event_ip,
                        "OK",
                        &format!("Position reçue (socket) : {}", fmt_point(&point)),
                    );
                    ingest_location_point(&state, point);
                }
            }
        },
    );

    s.on_disconnect(async move |reason: DisconnectReason| {
        auth_log(
            &ip,
            "INFO",
            &format!(
                "Device GPS déconnecté : {device_id} (raison: {})",
                reason_label(reason)
            ),
        );
    });
}

// ── Client web ────────────────────────────────────────────────────────────

fn sanitize_date(value: Option<&Value>) -> Option<String> {
    let Some(Value::String(s)) = value else {
        return None;
    };
    let b = s.as_bytes();
    let pattern = b"dddd-dd-ddTdd:dd:dd.dddZ";
    let matches = b.len() == pattern.len()
        && b.iter().zip(pattern.iter()).all(|(c, p)| match p {
            b'd' => c.is_ascii_digit(),
            other => c == other,
        });
    matches.then(|| s.clone())
}

fn sanitize_measures(value: Option<&Value>) -> Option<String> {
    let Some(Value::String(s)) = value else {
        return None;
    };
    let parts: Vec<&str> = s.split(',').map(str::trim).collect();
    parts
        .iter()
        .all(|p| VALID_MEASURES.contains(p))
        .then(|| parts.join(","))
}

fn parse_iso_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|dt| dt.with_timezone(&Utc).timestamp_millis())
}

struct Window {
    start: i64,
    end: i64,
}

/// Fenêtre `[début, fin[` calculée côté client en minuits locaux.
fn sanitize_window(value: Option<&Value>) -> Option<Window> {
    let Some(Value::Array(items)) = value else {
        return None;
    };
    if items.len() != 2 {
        return None;
    }
    let start = parse_iso_ms(&sanitize_date(items.first())?)?;
    let end = parse_iso_ms(&sanitize_date(items.get(1))?)?;
    if start >= end || end - start > 8 * DAY_MS {
        return None;
    }
    Some(Window { start, end })
}

fn iso_ms(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(crate::db::iso_string)
        .unwrap_or_default()
}

/// Valeurs horaires d'une mesure sur la fenêtre, en tranches de 7 jours
/// remontant depuis la fin, dédoublonnées par horodatage.
async fn fetch_hourly_values(
    state: &AppState,
    device_id: &str,
    measure: &str,
    window: &Window,
) -> Result<Vec<f64>, String> {
    let sencrop = &state.cfg.sencrop;
    let mut rows_by_time: Map<String, Value> = Map::new();

    let mut chunk_end = window.end;
    while chunk_end > window.start {
        let days = MAX_HOURLY_DAYS.min((chunk_end - window.start + DAY_MS - 1) / DAY_MS);
        let url = format!(
            "{}/users/{}/devices/{}/data/hourly?beforeDate={}&days={}&measures={}&patched=true",
            sencrop.end_point,
            sencrop.user_id,
            device_id,
            iso_ms(chunk_end),
            days,
            measure
        );
        let result = sencrop::fetch_data(state, &url).await;
        let Some(measures) = result.get("measures").filter(|m| js::truthy(Some(m))) else {
            return Err(format!("Sencrop {measure} indisponible"));
        };
        let rows = match measures.get("data") {
            Some(Value::Array(rows)) => rows.as_slice(),
            Some(Value::String(_)) => &[],
            data if js::truthy(data) => return Err("result.measures.data is not iterable".into()),
            _ => &[],
        };
        {
            for row in rows {
                let timestamp = match row.get("key") {
                    Some(key) if !key.is_null() => js::to_number(Some(key)),
                    _ => match row.get("date") {
                        Some(Value::String(d)) => {
                            parse_iso_ms(d).map(|v| v as f64).unwrap_or(f64::NAN)
                        }
                        _ => f64::NAN,
                    },
                };
                if timestamp >= window.start as f64 && timestamp < window.end as f64 {
                    rows_by_time.insert(js::num_to_string(timestamp), row.clone());
                }
            }
        }
        chunk_end -= MAX_HOURLY_DAYS * DAY_MS;
    }

    // Ordre d'insertion conservé (équivalent d'une `Map` JS).
    Ok(rows_by_time
        .values()
        .map(|row| js::to_number(row.get(measure).and_then(|m| m.get("value"))))
        .filter(|v| v.is_finite())
        .collect())
}

fn average(values: &[f64]) -> Value {
    if values.is_empty() {
        Value::Null
    } else {
        js::number_value(values.iter().sum::<f64>() / values.len() as f64)
    }
}

/// Émet un événement à deux arguments (`socket.emit(event, a, b)`).
fn emit2(s: &SocketRef, event: &'static str, a: &Value, b: &str) {
    let _ = s.emit(event, &(a, b));
}

fn setup_web_socket(s: SocketRef, ip: String, username: String) {
    auth_log(
        &ip,
        "INFO",
        &format!("Socket connecté : \"{username}\" (id: {})", s.id),
    );

    s.on_disconnect(async move |reason: DisconnectReason| {
        auth_log(
            &ip,
            "INFO",
            &format!(
                "Socket déconnecté : \"{username}\" (raison: {})",
                reason_label(reason)
            ),
        );
    });

    s.on(
        "askPlan",
        async |s: SocketRef, State(state): State<AppState>, TryData(value): TryData<Value>| {
            let table = &state.cfg.map_plan_urls;
            let year = js::to_number(value.as_ref().ok());
            let idx = (year - 2022.0).min(table.len() as f64 - 1.0).max(0.0);
            let idx = if year.is_nan() { f64::NAN } else { idx };
            let plan = if idx.fract() == 0.0 && (idx as usize) < table.len() {
                Value::String(table[idx as usize].clone())
            } else {
                Value::Null
            };
            let _ = s.emit("getPlan", &plan);
        },
    );

    s.on(
        "askDataR1",
        async |s: SocketRef,
               State(state): State<AppState>,
               Data((date, measures)): Data<(Value, Value)>| {
            let (Some(date), Some(meas)) = (
                sanitize_date(Some(&date)),
                sanitize_measures(Some(&measures)),
            ) else {
                return;
            };
            let c = &state.cfg.sencrop;
            let url = format!(
                "{}/users/{}/devices/{}/data/hourly?beforeDate={date}&days=1&measures={meas}",
                c.end_point, c.user_id, c.raincrop_earl_id
            );
            let result = sencrop::fetch_data(&state, &url).await;
            if let Some(measures) = result.get("measures").filter(|m| js::truthy(Some(m))) {
                emit2(
                    &s,
                    "getDataR1",
                    measures.get("data").unwrap_or(&Value::Null),
                    &meas,
                );
            }
        },
    );

    s.on(
        "askDataR2",
        async |s: SocketRef,
               State(state): State<AppState>,
               Data((date, measures)): Data<(Value, Value)>| {
            let (Some(date), Some(meas)) = (
                sanitize_date(Some(&date)),
                sanitize_measures(Some(&measures)),
            ) else {
                return;
            };
            let c = &state.cfg.sencrop;
            let url = format!(
                "{}/users/{}/devices/{}/data/raw?size=100&beforeDate={date}&days=1&measures={meas}",
                c.end_point, c.user_id, c.raincrop_earl_id
            );
            let result = sencrop::fetch_data(&state, &url).await;
            if js::truthy(Some(&result)) {
                emit2(&s, "getDataR2", &result, &meas);
            }
        },
    );

    s.on(
        "askDataW1",
        async |s: SocketRef, State(state): State<AppState>, Data((date, measures)): Data<(Value, Value)>| {
            let (Some(date), Some(meas)) = (sanitize_date(Some(&date)), sanitize_measures(Some(&measures))) else {
                return;
            };
            let c = &state.cfg.sencrop;
            let url = format!(
                "{}/users/{}/devices/{}/data/hourly?beforeDate={date}&days=1&measures={meas}&patched=true",
                c.end_point, c.user_id, c.windcrop_earl_id
            );
            let result = sencrop::fetch_data(&state, &url).await;
            if let Some(measures) = result.get("measures").filter(|m| js::truthy(Some(m))) {
                emit2(&s, "getDataW1", measures.get("data").unwrap_or(&Value::Null), &meas);
            }
        },
    );

    s.on(
        "askDataW2",
        async |s: SocketRef,
               State(state): State<AppState>,
               Data((date, measures)): Data<(Value, Value)>| {
            let (Some(date), Some(meas)) = (
                sanitize_date(Some(&date)),
                sanitize_measures(Some(&measures)),
            ) else {
                return;
            };
            let c = &state.cfg.sencrop;
            let url = format!(
                "{}/users/{}/devices/{}/data/raw?size=500&beforeDate={date}&days=1&measures={meas}",
                c.end_point, c.user_id, c.windcrop_earl_id
            );
            let result = sencrop::fetch_data(&state, &url).await;
            if js::truthy(Some(&result)) {
                emit2(&s, "getDataW2", &result, &meas);
            }
        },
    );

    s.on(
        "askRain",
        async |s: SocketRef, State(state): State<AppState>, Data((date, duration)): Data<(Value, Value)>| {
            let Some(date) = sanitize_date(Some(&date)) else {
                return;
            };
            let duration = js::to_number(Some(&duration));
            if duration.is_nan() {
                return;
            }
            let days = duration.clamp(1.0, 365.0);
            let c = &state.cfg.sencrop;
            let url = format!(
                "{}/users/{}/devices/{}/data/daily?beforeDate={date}&days={}&measures=RAIN_FALL&patched=true",
                c.end_point,
                c.user_id,
                c.raincrop_earl_id,
                js::num_to_string(days)
            );
            let result = sencrop::fetch_data(&state, &url).await;
            let Some(measures) = result.get("measures").filter(|m| js::truthy(Some(m))) else {
                return;
            };
            let mut sum = json!(0);
            match measures.get("data") {
                Some(Value::Array(rows)) => {
                    for row in rows {
                        sum = js::js_add(sum, row.get("RAIN_FALL"));
                    }
                }
                Some(Value::Object(rows)) => {
                    for row in rows.values() {
                        sum = js::js_add(sum, row.get("RAIN_FALL"));
                    }
                }
                _ => {}
            }
            let _ = s.emit("getRain", &sum);
        },
    );

    s.on(
        "askWeatherSummary",
        async |s: SocketRef, State(state): State<AppState>, TryData(request): TryData<Value>| {
            let request = request.unwrap_or(Value::Null);
            let request_id = request.get("requestId").cloned();
            let (Some(rain), Some(temperature), Some(wind)) = (
                sanitize_window(request.get("rain")),
                sanitize_window(request.get("temperature")),
                sanitize_window(request.get("wind")),
            ) else {
                return;
            };

            let c = &state.cfg.sencrop;
            let result = tokio::try_join!(
                fetch_hourly_values(&state, &c.raincrop_earl_id, "RAIN_FALL", &rain),
                fetch_hourly_values(&state, &c.raincrop_earl_id, "TEMPERATURE", &temperature),
                fetch_hourly_values(&state, &c.windcrop_earl_id, "WIND_SPEED", &wind),
            );

            let mut summary = Map::new();
            if let Some(id) = request_id {
                summary.insert("requestId".into(), id);
            }
            match result {
                Ok((rainfall, temperatures, wind)) => {
                    summary.insert(
                        "rainfallMm".into(),
                        if rainfall.is_empty() {
                            Value::Null
                        } else {
                            js::number_value(rainfall.iter().sum())
                        },
                    );
                    summary.insert("averageTemperature".into(), average(&temperatures));
                    summary.insert("averageWind".into(), average(&wind));
                }
                Err(error) => eprintln!("Erreur résumé météo Sencrop: {error}"),
            }
            let _ = s.emit("getWeatherSummary", &Value::Object(summary));
        },
    );

    s.on("forceDisconnect", async |s: SocketRef| {
        let _ = s.disconnect();
    });
}

pub fn register(io: &socketioxide::SocketIo) {
    io.ns("/", on_connect.with(authenticate));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert!(sanitize_date(Some(&json!("2026-10-27T00:00:00.000Z"))).is_some());
        assert!(sanitize_date(Some(&json!("2026-10-27T00:00:00Z"))).is_none());
        assert!(sanitize_date(Some(&json!(12))).is_none());
    }

    #[test]
    fn measures() {
        assert_eq!(
            sanitize_measures(Some(&json!("TEMPERATURE, RAIN_FALL"))).as_deref(),
            Some("TEMPERATURE,RAIN_FALL")
        );
        assert!(sanitize_measures(Some(&json!("TEMPERATURE,DROP TABLE"))).is_none());
        assert!(sanitize_measures(Some(&json!(""))).is_none());
    }

    #[test]
    fn windows() {
        let ok = json!(["2026-10-20T22:00:00.000Z", "2026-10-27T23:00:00.000Z"]);
        assert!(sanitize_window(Some(&ok)).is_some());
        let too_long = json!(["2026-10-01T00:00:00.000Z", "2026-10-27T00:00:00.000Z"]);
        assert!(sanitize_window(Some(&too_long)).is_none());
        let reversed = json!(["2026-10-27T00:00:00.000Z", "2026-10-20T00:00:00.000Z"]);
        assert!(sanitize_window(Some(&reversed)).is_none());
    }
}
