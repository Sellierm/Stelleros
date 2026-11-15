use axum::http::{Method, StatusCode, header};
use serde_json::{Value, json};
use sqlx::MySqlPool;

use super::{TestApp, TestResponse};

fn day(date: &str) -> Value {
    json!({
        "date": date,
        "morning_start": "09:00",
        "morning_end": "12:00",
        "morning_tasks": "labour",
        "afternoon_start": "",
        "afternoon_end": "",
        "afternoon_tasks": "",
    })
}

async fn create(app: &TestApp, cookie: &str, body: Value) -> TestResponse {
    app.request(
        Method::POST,
        "/api/timesheet/entries",
        Some(cookie),
        Some(body),
    )
    .await
}

/// Second utilisateur avec une journée saisie ; renvoie l'id de la journée.
async fn other_user_entry(app: &TestApp) -> u64 {
    sqlx::query(
        "INSERT INTO auth_user (id, name, email, emailVerified, username, displayUsername) VALUES ('u2', 'Ouvrier', 'ouvrier@example.test', 1, 'ouvrier', 'Thib')",
    )
    .execute(app.pool())
    .await
    .expect("auth_user u2");
    sqlx::query(
        "INSERT INTO timesheet_entries (user_id, date, afternoon_start, afternoon_end, afternoon_tasks) VALUES ('u2', '2026-07-10', '11:00', '23:00', 'moisson')",
    )
    .execute(app.pool())
    .await
    .expect("journée u2")
    .last_insert_id()
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn pointage_crud(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;

    let res = app.get("/api/timesheet/users", &cookie).await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(res.body["me"], "u1");
    assert_eq!(
        res.body["users"],
        json!([{ "id": "u1", "name": "testeur" }])
    );

    let res = create(&app, &cookie, day("2026-04-13")).await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.text);
    let id = res.body["id"].as_u64().expect("id");

    let res = app.get("/api/timesheet/entries", &cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(
        res.body,
        json!([{
            "id": id,
            "user_id": "u1",
            "date": "2026-04-13",
            "morning_start": "09:00",
            "morning_end": "12:00",
            "morning_tasks": "labour",
            "afternoon_start": null,
            "afternoon_end": null,
            "afternoon_tasks": null,
        }])
    );

    // Une seule journée par date.
    let res = create(&app, &cookie, day("2026-04-13")).await;
    assert_eq!(res.status, StatusCode::CONFLICT);

    // Validation côté serveur, message renvoyé au client.
    let res = create(
        &app,
        &cookie,
        json!({ "date": "2026-04-14", "morning_start": "12:00", "morning_end": "09:00" }),
    )
    .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(res.body["message"].as_str().unwrap().starts_with("Matin"));

    let mut updated = day("2026-04-13");
    updated["afternoon_start"] = json!("14:00");
    updated["afternoon_end"] = json!("18:30");
    updated["afternoon_tasks"] = json!("terrier");
    let res = app
        .request(
            Method::PUT,
            &format!("/api/timesheet/entries/{id}"),
            Some(&cookie),
            Some(updated.clone()),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    // Même contenu renvoyé deux fois : toujours un succès.
    let res = app
        .request(
            Method::PUT,
            &format!("/api/timesheet/entries/{id}"),
            Some(&cookie),
            Some(updated),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    let res = app.get("/api/timesheet/entries", &cookie).await;
    assert_eq!(res.body[0]["afternoon_end"], "18:30");

    // Changer la date vers une date déjà prise : conflit.
    let res = create(&app, &cookie, day("2026-04-20")).await;
    assert_eq!(res.status, StatusCode::CREATED);
    let res = app
        .request(
            Method::PUT,
            &format!("/api/timesheet/entries/{id}"),
            Some(&cookie),
            Some(day("2026-04-20")),
        )
        .await;
    assert_eq!(res.status, StatusCode::CONFLICT);

    let res = app
        .request(
            Method::DELETE,
            &format!("/api/timesheet/entries/{id}"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let res = app
        .request(
            Method::DELETE,
            &format!("/api/timesheet/entries/{id}"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
    let res = app.get("/api/timesheet/entries", &cookie).await;
    assert_eq!(res.body.as_array().unwrap().len(), 1);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn pointage_periode(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;
    for date in ["2026-03-31", "2026-04-01", "2026-04-30", "2026-05-01"] {
        let res = create(&app, &cookie, day(date)).await;
        assert_eq!(res.status, StatusCode::CREATED, "{}", res.text);
    }

    let dates = |res: &TestResponse| -> Vec<String> {
        res.body
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["date"].as_str().unwrap().to_string())
            .collect()
    };
    let res = app
        .get(
            "/api/timesheet/entries?from=2026-04-01&to=2026-04-30",
            &cookie,
        )
        .await;
    assert_eq!(dates(&res), ["2026-04-01", "2026-04-30"]);
    let res = app
        .get("/api/timesheet/entries?from=2026-04-30", &cookie)
        .await;
    assert_eq!(dates(&res), ["2026-04-30", "2026-05-01"]);

    let res = app
        .get("/api/timesheet/entries?from=30/04/2026", &cookie)
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn pointage_autres_utilisateurs(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;
    let other = other_user_entry(&app).await;

    // Consultable…
    let res = app.get("/api/timesheet/entries?user=u2", &cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body[0]["afternoon_tasks"], "moisson");
    let res = app.get("/api/timesheet/users", &cookie).await;
    assert_eq!(res.body["users"].as_array().unwrap().len(), 2);

    // …mais pas modifiable.
    let res = app
        .request(
            Method::PUT,
            &format!("/api/timesheet/entries/{other}"),
            Some(&cookie),
            Some(day("2026-07-10")),
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let res = app
        .request(
            Method::DELETE,
            &format!("/api/timesheet/entries/{other}"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM timesheet_entries")
        .fetch_one(app.pool())
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn pointage_export_excel(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;
    other_user_entry(&app).await;

    let res = app
        .get(
            "/api/timesheet/export?user=u2&from=2026-07-01&to=2026-07-31",
            &cookie,
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_eq!(
        res.headers[header::CONTENT_TYPE],
        crate::routes::timesheet::XLSX_CONTENT_TYPE
    );
    assert_eq!(
        res.headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"heures_thib_2026-07-01_2026-07-31.xlsx\""
    );
    assert!(res.text.starts_with("PK"), "fichier xlsx (zip)");

    // Feuille vide : toujours un classeur valide.
    let res = app.get("/api/timesheet/export", &cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(res.text.starts_with("PK"));

    let res = app.get("/api/timesheet/export?user=inconnu", &cookie).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn pointage_sans_session(pool: MySqlPool) {
    let app = TestApp::new(pool);
    for uri in [
        "/api/timesheet/users",
        "/api/timesheet/entries",
        "/api/timesheet/export",
    ] {
        let res = app.request(Method::GET, uri, None, None).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{uri}");
    }
    let res = app
        .request(
            Method::POST,
            "/api/timesheet/entries",
            None,
            Some(day("2026-04-13")),
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}
