use axum::http::{Method, StatusCode};
use serde_json::json;
use sqlx::MySqlPool;

use super::{TEST_USERNAME, TestApp};

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn migrations_creent_toutes_les_tables(pool: MySqlPool) {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    for expected in [
        "auth_account",
        "auth_session",
        "auth_user",
        "auth_verification",
        "gps_compaction",
        "gps_days",
        "gps_latest",
        "gps_track",
        "phyto_application_products",
        "phyto_applications",
        "phyto_products",
    ] {
        assert!(
            tables.iter().any(|t| t == expected),
            "table {expected} absente : {tables:?}"
        );
    }
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn migrations_rejouables(pool: MySqlPool) {
    // Les migrations ont déjà été appliquées : les rejouer telles quelles
    // (cas d'une base créée avant leur introduction) ne doit rien casser.
    let mut files: Vec<_> = std::fs::read_dir("migrations")
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    for file in files {
        let sql = std::fs::read_to_string(&file).unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
            .execute(&pool)
            .await
            .unwrap_or_else(|err| panic!("{} : {err}", file.display()));
    }
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn routes_protegees_sans_session(pool: MySqlPool) {
    let app = TestApp::new(pool);
    for uri in [
        "/api/config",
        "/api/phyto/products",
        "/api/phyto/applications",
        "/api/phyto/export",
        "/api/latest-positions",
        "/api/positions-dates",
        "/api/positions-history?date=2026-11-01",
    ] {
        let res = app.request(Method::GET, uri, None, None).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{uri}");
    }
    // Cookie forgé (signature invalide) : refusé aussi.
    let res = app
        .get(
            "/api/phyto/products",
            "better-auth.session_token=faux.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%3D",
        )
        .await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn connexion_session_deconnexion(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;

    let res = app.get("/api/auth/get-session", &cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(res.body["user"]["username"], TEST_USERNAME);

    let res = app.get("/api/phyto/products", &cookie).await;
    assert_eq!(res.status, StatusCode::OK);

    let res = app
        .request(Method::POST, "/api/auth/sign-out", Some(&cookie), None)
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auth_session")
        .fetch_one(app.pool())
        .await
        .unwrap();
    assert_eq!(sessions, 0);

    // L'ancien cookie ne donne plus accès.
    let res = app.get("/api/phyto/products", &cookie).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn connexion_mauvais_mot_de_passe(pool: MySqlPool) {
    let app = TestApp::new(pool);
    app.create_user().await;
    for (username, password) in [(TEST_USERNAME, "faux"), ("inconnu", "faux")] {
        let res = app
            .request(
                Method::POST,
                "/api/auth/sign-in/username",
                None,
                Some(json!({ "username": username, "password": password })),
            )
            .await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{username}");
        assert!(res.headers.get("set-cookie").is_none());
    }
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auth_session")
        .fetch_one(app.pool())
        .await
        .unwrap();
    assert_eq!(sessions, 0);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn session_expiree_refusee(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;
    sqlx::query("UPDATE auth_session SET expiresAt = '2000-01-01 00:00:00'")
        .execute(app.pool())
        .await
        .unwrap();
    let res = app.get("/api/phyto/products", &cookie).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    // La session expirée est supprimée.
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM auth_session")
        .fetch_one(app.pool())
        .await
        .unwrap();
    assert_eq!(sessions, 0);
}
