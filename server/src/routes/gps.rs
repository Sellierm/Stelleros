use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use chrono::{LocalResult, NaiveDate, TimeZone, Utc};
use chrono_tz::Europe::Paris;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

use super::require_user;
use crate::js;
use crate::location::{self, build_location_point, ingest_location_point, log_point};
use crate::middleware::{
    auth_log, client_ip, fail, json_response, peer_ip, query_values, read_body,
};
use crate::state::AppState;

/// Comparaison en temps constant de la clé d'ingestion GPS.
pub fn is_ingest_key_valid(expected: &str, key: Option<&Value>) -> bool {
    let key = match key {
        Some(Value::String(s)) => s.as_bytes(),
        _ => b"",
    };
    let expected = expected.as_bytes();
    key.len() == expected.len() && !key.is_empty() && bool::from(key.ct_eq(expected))
}

/// Minuit (heure de Paris) du jour donné, en ms epoch.
fn paris_midnight_ms(date: NaiveDate) -> i64 {
    let naive = date.and_hms_opt(0, 0, 0).unwrap_or_default();
    match Paris.from_local_datetime(&naive) {
        LocalResult::Single(dt) | LocalResult::Ambiguous(dt, _) => dt.timestamp_millis(),
        LocalResult::None => Utc.from_utc_datetime(&naive).timestamp_millis(),
    }
}

fn is_date_param(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        })
}

/// `POST /api/location` — route HTTP historique, conservée pour
/// compatibilité/tests ; la tablette passe désormais par Socket.IO.
pub async fn post_location(State(state): State<AppState>, req: Request) -> Response {
    let client_ip = client_ip(&state.cfg, req.headers(), peer_ip(req.extensions()));
    let (parts, body) = req.into_parts();
    let body = match read_body(&parts.headers, body).await {
        Ok(body) => body,
        Err(res) => return res,
    };

    let Some(ingest_key) = state.cfg.gps_ingest_key.as_deref() else {
        return fail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "GPS_INGEST_KEY is not configured",
        );
    };

    let id = body.get("id");
    let id_str = js::to_js_string(id);
    if !is_ingest_key_valid(ingest_key, body.get("key"))
        || !state.cfg.gps_allowed_ids.contains(&id_str)
    {
        auth_log(
            &client_ip,
            "FAIL",
            &format!("Position rejetée (HTTP) : device={id_str} non autorisé ou clé invalide"),
        );
        return fail(StatusCode::UNAUTHORIZED, "Unauthorized: invalid payload");
    }

    let device_id = if js::truthy(id) { id_str } else { "0".into() };
    let point = match build_location_point(&device_id, Some(&body)) {
        Ok(point) => point,
        Err(error) => {
            auth_log(
                &client_ip,
                "FAIL",
                &format!("Position rejetée (HTTP) : device={device_id} — {error}"),
            );
            return fail(StatusCode::BAD_REQUEST, error);
        }
    };

    if let Err(res) = state.limiters.device.hit(&device_id).into_result() {
        return res;
    }

    log_point(&state, &client_ip, "HTTP", &point);
    ingest_location_point(&state, point);
    json_response(StatusCode::OK, json!({ "success": true }))
}

/// `GET /api/latest-positions`
pub async fn latest_positions(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    match location::get_positions(&state).await {
        Ok(positions) => json_response(
            StatusCode::OK,
            json!({ "success": true, "positions": positions }),
        ),
        Err(err) => {
            eprintln!("[GPS] Erreur lecture positions: {err}");
            fail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

/// `GET /api/positions-history?date=YYYY-MM-DD` (jour calendaire de Paris).
pub async fn positions_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    let values = query_values(uri.query(), "date");
    let date_param = match values.as_slice() {
        [single] if is_date_param(single) => single.clone(),
        _ => return fail(StatusCode::BAD_REQUEST, "Invalid date"),
    };
    let Ok(date) = NaiveDate::parse_from_str(&date_param, "%Y-%m-%d") else {
        return fail(StatusCode::BAD_REQUEST, "Invalid date");
    };
    let Some(next_date) = date.succ_opt() else {
        return fail(StatusCode::BAD_REQUEST, "Invalid date");
    };
    let day_start = paris_midnight_ms(date);
    let day_end = paris_midnight_ms(next_date);

    match location::get_history(&state, day_start, day_end).await {
        Ok(positions) => json_response(
            StatusCode::OK,
            json!({ "success": true, "positions": positions, "date": date_param }),
        ),
        Err(err) => {
            eprintln!("[GPS] Erreur lecture historique: {err}");
            fail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

/// `GET /api/positions-dates`
pub async fn positions_dates(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    match location::get_history_dates(&state).await {
        Ok(dates) => json_response(StatusCode::OK, json!({ "success": true, "dates": dates })),
        Err(err) => {
            eprintln!("[GPS] Erreur lecture dates historiques: {err}");
            fail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paris_day_bounds() {
        // Heure d'hiver : UTC+1 ; heure d'été : UTC+2.
        let winter = NaiveDate::from_ymd_opt(2026, 1, 15).unwrap();
        assert_eq!(paris_midnight_ms(winter), 1_768_431_600_000);
        let summer = NaiveDate::from_ymd_opt(2026, 7, 15).unwrap();
        assert_eq!(paris_midnight_ms(summer), 1_784_066_400_000);
    }

    #[test]
    fn ingest_key() {
        assert!(is_ingest_key_valid("abc", Some(&json!("abc"))));
        assert!(!is_ingest_key_valid("abc", Some(&json!("abd"))));
        assert!(!is_ingest_key_valid("abc", Some(&json!(123))));
        assert!(!is_ingest_key_valid("abc", None));
    }

    #[test]
    fn date_param() {
        assert!(is_date_param("2026-10-27"));
        assert!(!is_date_param("2026-1-27"));
        assert!(!is_date_param("２０２６-10-27"));
    }
}
