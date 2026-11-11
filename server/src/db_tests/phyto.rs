use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::MySqlPool;

use super::{TestApp, assert_close};

/// Crée un produit et renvoie son id.
async fn product(app: &TestApp, cookie: &str, name: &str, stock: f64) -> u64 {
    let res = app
        .request(
            Method::POST,
            "/api/phyto/products",
            Some(cookie),
            Some(json!({ "name": name, "category": "Fongicide", "stock": stock, "unit": "L" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.text);
    res.body["id"].as_u64().expect("id")
}

async fn stock(app: &TestApp, id: u64) -> f64 {
    let stock: f32 = sqlx::query_scalar("SELECT stock FROM phyto_products WHERE id = ?")
        .bind(id)
        .fetch_one(app.pool())
        .await
        .unwrap();
    f64::from(stock)
}

async fn count(app: &TestApp, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
        .fetch_one(app.pool())
        .await
        .unwrap()
}

async fn create_application(app: &TestApp, cookie: &str, body: Value) -> super::TestResponse {
    app.request(
        Method::POST,
        "/api/phyto/applications",
        Some(cookie),
        Some(body),
    )
    .await
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn produits_crud(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;

    // Nom obligatoire.
    let res = app
        .request(
            Method::POST,
            "/api/phyto/products",
            Some(&cookie),
            Some(json!({ "stock": 3 })),
        )
        .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);

    // Valeurs par défaut : catégorie « Autre », stock 0, unité « L ».
    let res = app
        .request(
            Method::POST,
            "/api/phyto/products",
            Some(&cookie),
            Some(json!({ "name": "Soufre" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::CREATED);
    let id = res.body["id"].as_u64().unwrap();

    let res = app.get("/api/phyto/products", &cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    let list = res.body.as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["name"], "Soufre");
    assert_eq!(list[0]["category"], "Autre");
    assert_eq!(list[0]["unit"], "L");
    assert_close(list[0]["stock"].as_f64().unwrap(), 0.0);

    let res = app
        .request(
            Method::PUT,
            &format!("/api/phyto/products/{id}"),
            Some(&cookie),
            Some(json!({ "name": "Soufre mouillable", "stock": 12.5, "unit": "kg" })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_close(stock(&app, id).await, 12.5);

    let res = app
        .request(
            Method::DELETE,
            &format!("/api/phyto/products/{id}"),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_eq!(count(&app, "phyto_products").await, 0);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn intervention_decremente_le_stock(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;
    let cuivre = product(&app, &cookie, "Cuivre", 10.0).await;
    let soufre = product(&app, &cookie, "Soufre", 5.0).await;

    let res = create_application(
        &app,
        &cookie,
        json!({
            "date": "2026-05-12",
            "notes": "Vigne",
            "products": [
                { "product_id": cuivre, "quantity_used": 2.5 },
                { "product_id": soufre, "quantity_used": 1 },
            ],
        }),
    )
    .await;
    assert_eq!(res.status, StatusCode::CREATED, "{}", res.text);
    assert_close(stock(&app, cuivre).await, 7.5);
    assert_close(stock(&app, soufre).await, 4.0);

    let res = app.get("/api/phyto/applications", &cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    let apps = res.body.as_array().unwrap();
    assert_eq!(apps.len(), 1);
    assert_eq!(apps[0]["notes"], "Vigne");
    // MariaDB renvoie JSON_ARRAYAGG en texte : le client le parse (PhytoPage).
    let products: Value = match &apps[0]["products"] {
        Value::String(raw) => serde_json::from_str(raw).expect("products JSON"),
        other => other.clone(),
    };
    let products = products.as_array().expect("products");
    assert_eq!(products.len(), 2);
    assert!(products.iter().any(|p| p["product_name"] == "Cuivre"));
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn intervention_refusee_si_stock_insuffisant(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;
    let cuivre = product(&app, &cookie, "Cuivre", 2.0).await;
    let soufre = product(&app, &cookie, "Soufre", 5.0).await;

    // Le second produit dépasse le stock : rien ne doit être enregistré,
    // pas même la consommation du premier.
    let res = create_application(
        &app,
        &cookie,
        json!({
            "date": "2026-05-12",
            "products": [
                { "product_id": soufre, "quantity_used": 1 },
                { "product_id": cuivre, "quantity_used": 3 },
            ],
        }),
    )
    .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(
        res.body["message"]
            .as_str()
            .unwrap()
            .contains("Stock insuffisant pour Cuivre")
    );
    assert_close(stock(&app, cuivre).await, 2.0);
    assert_close(stock(&app, soufre).await, 5.0);
    assert_eq!(count(&app, "phyto_applications").await, 0);
    assert_eq!(count(&app, "phyto_application_products").await, 0);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn intervention_produit_inconnu_ou_champs_manquants(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;

    let res = create_application(
        &app,
        &cookie,
        json!({ "date": "2026-05-12", "products": [{ "product_id": 999, "quantity_used": 1 }] }),
    )
    .await;
    assert_eq!(res.status, StatusCode::BAD_REQUEST);
    assert!(
        res.body["message"]
            .as_str()
            .unwrap()
            .contains("introuvable")
    );

    for body in [
        json!({ "date": "2026-05-12", "products": [] }),
        json!({ "products": [{ "product_id": 1, "quantity_used": 1 }] }),
        json!({ "date": "2026-05-12" }),
    ] {
        let res = create_application(&app, &cookie, body.clone()).await;
        assert_eq!(res.status, StatusCode::BAD_REQUEST, "{body}");
    }
    assert_eq!(count(&app, "phyto_applications").await, 0);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn modification_restitue_puis_reconsomme(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;
    let cuivre = product(&app, &cookie, "Cuivre", 10.0).await;
    let soufre = product(&app, &cookie, "Soufre", 5.0).await;

    let res = create_application(
        &app,
        &cookie,
        json!({ "date": "2026-05-12", "products": [{ "product_id": cuivre, "quantity_used": 4 }] }),
    )
    .await;
    let id = res.body["id"].as_u64().unwrap();
    assert_close(stock(&app, cuivre).await, 6.0);

    // Cuivre 4 → 1, soufre ajouté (2).
    let res = app
        .request(
            Method::PUT,
            &format!("/api/phyto/applications/{id}"),
            Some(&cookie),
            Some(json!({
                "date": "2026-05-13",
                "products": [
                    { "product_id": cuivre, "quantity_used": 1 },
                    { "product_id": soufre, "quantity_used": 2 },
                ],
            })),
        )
        .await;
    assert_eq!(res.status, StatusCode::OK, "{}", res.text);
    assert_close(stock(&app, cuivre).await, 9.0);
    assert_close(stock(&app, soufre).await, 3.0);
    assert_eq!(count(&app, "phyto_application_products").await, 2);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn suppression_avec_ou_sans_restitution(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;
    let cuivre = product(&app, &cookie, "Cuivre", 10.0).await;

    let mut ids = Vec::new();
    for _ in 0..2 {
        let res = create_application(
            &app,
            &cookie,
            json!({ "date": "2026-05-12", "products": [{ "product_id": cuivre, "quantity_used": 3 }] }),
        )
        .await;
        ids.push(res.body["id"].as_u64().unwrap());
    }
    assert_close(stock(&app, cuivre).await, 4.0);

    // Sans restitution : le stock reste consommé.
    let res = app
        .request(
            Method::DELETE,
            &format!("/api/phyto/applications/{}", ids[0]),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_close(stock(&app, cuivre).await, 4.0);

    // Avec restitution.
    let res = app
        .request(
            Method::DELETE,
            &format!("/api/phyto/applications/{}?restoreStock=true", ids[1]),
            Some(&cookie),
            None,
        )
        .await;
    assert_eq!(res.status, StatusCode::OK);
    assert_close(stock(&app, cuivre).await, 7.0);
    assert_eq!(count(&app, "phyto_applications").await, 0);
    // Lignes de produits supprimées en cascade.
    assert_eq!(count(&app, "phyto_application_products").await, 0);
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn exports_csv(pool: MySqlPool) {
    let app = TestApp::new(pool);
    let cookie = app.login().await;
    let cuivre = product(&app, &cookie, "=Cuivre", 10.0).await;
    create_application(
        &app,
        &cookie,
        json!({
            "date": "2026-05-12",
            "notes": "rang 1; rang 2",
            "products": [{ "product_id": cuivre, "quantity_used": 2.5 }],
        }),
    )
    .await;

    let res = app.get("/api/phyto/export", &cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    assert!(
        res.headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/csv")
    );
    let lines: Vec<&str> = res
        .text
        .trim_start_matches('\u{feff}')
        .split("\r\n")
        .collect();
    assert_eq!(lines[0], "Date;Produit;Catégorie;Quantité;Unité;Notes");
    // Date française, décimale à virgule, formule neutralisée, `;` protégé.
    assert_eq!(
        lines[1],
        "12/05/2026;'=Cuivre;Fongicide;2,5;L;\"rang 1; rang 2\""
    );

    let res = app.get("/api/phyto/products/export", &cookie).await;
    assert_eq!(res.status, StatusCode::OK);
    let lines: Vec<&str> = res
        .text
        .trim_start_matches('\u{feff}')
        .split("\r\n")
        .collect();
    assert_eq!(lines[1], "'=Cuivre;Fongicide;7,5;L;");
}

#[sqlx::test]
#[ignore = "nécessite DATABASE_URL"]
async fn ecriture_refusee_sans_origine(pool: MySqlPool) {
    // Contrôle CSRF : une écriture sans en-tête Origin est refusée.
    let app = TestApp::new(pool);
    let cookie = app.login().await;
    let req = axum::http::Request::builder()
        .method(Method::POST)
        .uri("/api/phyto/products")
        .header("host", "localhost")
        .header("cookie", &cookie)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(r#"{"name":"X"}"#))
        .unwrap();
    let res = tower::ServiceExt::oneshot(app.router(), req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(count(&app, "phyto_products").await, 0);
}
