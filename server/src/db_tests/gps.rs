use axum::http::{Method, StatusCode};
use chrono::NaiveDate;
use serde_json::{Map, Value, json};
use sqlx::MySqlPool;

use super::{GPS_DEVICE, GPS_KEY, TestApp, assert_close};
use crate::location::store_points;
use crate::track::{compact_days, paris_midnight_ms};

/// Jour passé fixe (heure d'été : minuit Paris = 22 h UTC la veille).
fn day() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 6, 15).unwrap()
}

/// Point tel que l'écrit le serveur (sans la validation d'âge, pour
/// pouvoir remplir un jour passé).
fn point(device: &str, lat: f64, lon: f64, timestamp: i64) -> Map<String, Value> {
    let Value::Object(map) = json!({
        "device_id": device,
        "latitude": lat,
        "longitude": lon,
        "altitude": 50.0,
        "accuracy": 0.02,
        "speed": 1.5,
        "heading": 90.0,
        "source": "RTK RTK Fix",
        "timestamp": timestamp,
    }) else {
        unreachable!()
    };
    map
}

async fn count(app: &TestApp, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(app.pool()).await.unwrap()
}

async fn post_location(app: &TestApp, body: Value) -> super::TestResponse {
    app.request(Method::POST, "/api/location", None, Some(body))
        .await
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn post_location_enregistre_le_point(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let now = chrono::Utc::now().timestamp_millis();
    let body = json!({
        "id": GPS_DEVICE, "key": GPS_KEY,
        "latitude": 48.1, "longitude": -1.6, "timestamp": now, "source": "gps",
    });

    let res = post_location(&app, body.clone()).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(count(&app, "SELECT COUNT(*) FROM gps_track").await, 1);
    assert_eq!(count(&app, "SELECT COUNT(*) FROM gps_latest").await, 1);
    assert_eq!(count(&app, "SELECT COUNT(*) FROM gps_days").await, 1);

    // Renvoi du même point (ack perdu) : pas de doublon.
    let res = post_location(&app, body).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(count(&app, "SELECT COUNT(*) FROM gps_track").await, 1);

    let cookie = app.login().await;
    let res = app.get("/api/latest-positions", &cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    let latest = &res.body["positions"][GPS_DEVICE];
    assert_close(latest["latitude"].as_f64().unwrap(), 48.1);
    assert_eq!(latest["timestamp"], now);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn post_location_refuse_les_points_invalides(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let now = chrono::Utc::now().timestamp_millis();
    let cases = [
        // Mauvaise clé, device non autorisé, clé absente.
        (
            json!({ "id": GPS_DEVICE, "key": "faux", "latitude": 48.0, "longitude": -1.0, "timestamp": now }),
            StatusCode::UNAUTHORIZED,
        ),
        (
            json!({ "id": "9999", "key": GPS_KEY, "latitude": 48.0, "longitude": -1.0, "timestamp": now }),
            StatusCode::UNAUTHORIZED,
        ),
        (
            json!({ "id": GPS_DEVICE, "latitude": 48.0, "longitude": -1.0, "timestamp": now }),
            StatusCode::UNAUTHORIZED,
        ),
        // Champs manquants, coordonnées hors bornes, timestamp absurde.
        (
            json!({ "id": GPS_DEVICE, "key": GPS_KEY, "latitude": 48.0, "timestamp": now }),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({ "id": GPS_DEVICE, "key": GPS_KEY, "latitude": 91.0, "longitude": -1.0, "timestamp": now }),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({ "id": GPS_DEVICE, "key": GPS_KEY, "latitude": 48.0, "longitude": -1.0, "timestamp": 1000 }),
            StatusCode::BAD_REQUEST,
        ),
    ];
    for (body, expected) in cases {
        let res = post_location(&app, body.clone()).await;
        assert_eq!(res.status, expected, "{body}");
    }
    assert_eq!(count(&app, "SELECT COUNT(*) FROM gps_track").await, 0);
    assert_eq!(count(&app, "SELECT COUNT(*) FROM gps_latest").await, 0);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn derniere_position_jamais_remplacee_par_un_point_plus_ancien(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let t = paris_midnight_ms(day()) + 3_600_000;
    store_points(&app.state, &[point("a", 48.2, -1.0, t + 1000)])
        .await
        .unwrap();
    // Point plus ancien arrivé en retard (lot rejoué).
    store_points(&app.state, &[point("a", 48.1, -1.0, t)])
        .await
        .unwrap();
    let (lat, ts): (f64, i64) =
        sqlx::query_as("SELECT latitude, timestamp FROM gps_latest WHERE device_id = 'a'")
            .fetch_one(app.pool())
            .await
            .unwrap();
    assert_close(lat, 48.2);
    assert_eq!(ts, t + 1000);
    assert_eq!(count(&app, "SELECT COUNT(*) FROM gps_track").await, 2);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn historique_d_une_journee(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;
    let start = paris_midnight_ms(day());
    let next_day = paris_midnight_ms(day().succ_opt().unwrap());

    let mut points = vec![
        point("a", 48.0, -1.0, start),
        point("a", 48.001, -1.0, start + 60_000),
        point("b", 47.5, -1.2, start + 120_000),
        // Hors de la journée (veille et lendemain à minuit pile).
        point("a", 49.0, -1.0, start - 1),
        point("a", 49.0, -1.0, next_day),
    ];
    store_points(&app.state, &points).await.unwrap();
    points.clear();

    let res = app
        .get("/api/positions-history?date=2026-06-15", &cookie)
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["date"], "2026-06-15");
    let positions = res.body["positions"].as_object().unwrap();
    assert_eq!(positions.len(), 2);

    let a = &positions["a"];
    let track = a["track"].as_array().unwrap();
    assert_eq!(track.len(), 2);
    // [lat, lng, timestamp, précision, source]
    assert_eq!(track[0].as_array().unwrap().len(), 5);
    assert_eq!(track[0][2], start);
    assert_eq!(track[0][4], "RTK RTK Fix");
    assert_eq!(a["last"]["timestamp"], start + 60_000);

    // Jours connus : veille, jour et lendemain (heure de Paris).
    let res = app.get("/api/positions-dates", &cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(
        res.body["dates"],
        json!(["2026-06-16", "2026-06-15", "2026-06-14"])
    );

    for bad in ["2026-6-15", "15/06/2026", "2026-02-30", ""] {
        let res = app
            .get(&format!("/api/positions-history?date={bad}"), &cookie)
            .await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{bad}");
    }
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn compaction_d_un_jour_passe(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let start = paris_midnight_ms(day()) + 8 * 3_600_000;

    // Ligne droite à 1 m/s pendant 100 s, RTK (2 cm) : très compressible.
    let points: Vec<_> = (0..100)
        .map(|i| {
            point(
                "a",
                48.0 + f64::from(i) * 0.000_009,
                -1.0,
                start + i64::from(i) * 1000,
            )
        })
        .collect();
    store_points(&app.state, &points).await.unwrap();

    compact_days(&app.state, day(), day()).await.unwrap();
    let after = count(&app, "SELECT COUNT(*) FROM gps_track").await;
    assert!((2..100).contains(&after), "{after} points après compaction");

    let (before, kept): (i32, i32) = sqlx::query_as(
        "SELECT points_before, points_after FROM gps_compaction WHERE day = '2026-06-15' AND device_id = 'a'",
    )
    .fetch_one(app.pool())
    .await
    .unwrap();
    assert_eq!(before, 100);
    assert_eq!(i64::from(kept), after);

    // Les extrémités sont conservées.
    let (lo, hi): (i64, i64) =
        sqlx::query_as("SELECT MIN(timestamp), MAX(timestamp) FROM gps_track")
            .fetch_one(app.pool())
            .await
            .unwrap();
    assert_eq!((lo, hi), (start, start + 99_000));

    // Un jour déjà compacté n'est jamais repris.
    let late: Vec<_> = (0..10)
        .map(|i| {
            point(
                "a",
                48.1,
                -1.0 + f64::from(i) * 0.000_01,
                start + 200_000 + i64::from(i) * 1000,
            )
        })
        .collect();
    store_points(&app.state, &late).await.unwrap();
    compact_days(&app.state, day(), day()).await.unwrap();
    assert_eq!(
        count(&app, "SELECT COUNT(*) FROM gps_track").await,
        after + 10
    );
}
