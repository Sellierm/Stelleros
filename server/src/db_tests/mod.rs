//! Tests d'intégration sur une vraie base MariaDB.
//!
//! Chaque test reçoit une base vide créée par `#[sqlx::test]`, sur laquelle
//! toutes les migrations de `server/migrations` sont d'abord appliquées : les
//! migrations sont donc vérifiées à chaque exécution.
//!
//! Ils sont ignorés par un simple `cargo test` (pas de base disponible). Pour
//! les lancer, avec un MariaDB accessible par un compte autorisé à créer des
//! bases :
//!
//! ```sh
//! DATABASE_URL=mysql://root:test@127.0.0.1:3306/farm cargo test -- --include-ignored
//! ```

mod auth;
mod gps;
mod phyto;

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderValue, Method, Request, StatusCode, header};
use serde_json::Value;
use socketioxide::SocketIo;
use sqlx::MySqlPool;
use tower::ServiceExt;

use crate::config::Config;
use crate::state::{AppState, Inner};

pub const TEST_USERNAME: &str = "testeur";
pub const TEST_PASSWORD: &str = "mot-de-passe-de-test";
pub const GPS_KEY: &str = "cle-gps-de-test";
pub const GPS_DEVICE: &str = "6290";

fn test_config() -> Config {
    let mut cfg = Config::from_env().expect("config de test");
    cfg.is_prod = false;
    cfg.gps_ingest_key = Some(GPS_KEY.into());
    cfg.gps_allowed_ids = vec![GPS_DEVICE.into()];
    cfg.gps_retention_days = None;
    cfg
}

/// Application complète (mêmes routes et middlewares qu'en production)
/// branchée sur la base de test.
pub struct TestApp {
    pub state: AppState,
    router: Router,
}

pub struct TestResponse {
    pub status: StatusCode,
    pub headers: axum::http::HeaderMap,
    pub body: Value,
    pub text: String,
}

impl TestApp {
    pub fn new(pool: MySqlPool) -> Self {
        let http = reqwest::Client::new();
        let state: AppState = Arc::new(Inner::new(test_config(), pool.clone(), http.clone()));
        // Socket.IO reçoit son propre état : en production `state` et `io` se
        // référencent mutuellement (sans importance, ils vivent jusqu'à
        // l'arrêt). Ici ce cycle empêcherait de libérer le pool en fin de
        // test, et ses connexions ouvertes bloqueraient la suppression de la
        // base de test.
        let io_state: AppState = Arc::new(Inner::new(test_config(), pool, http));
        let (socket_layer, io) = SocketIo::builder().with_state(io_state).build_layer();
        crate::socket::register(&io);
        state.set_io(io);
        let router = crate::build_router(state.clone(), socket_layer);
        Self { state, router }
    }

    pub fn router(&self) -> Router {
        self.router.clone()
    }

    pub fn pool(&self) -> &MySqlPool {
        &self.state.pool
    }

    /// Requête same-origin (passe le contrôle CSRF), JSON si `body` est fourni.
    pub async fn request(
        &self,
        method: Method,
        uri: &str,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> TestResponse {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "localhost")
            .header(header::ORIGIN, "http://localhost:5173");
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let req = match body {
            Some(body) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string())),
            None => builder.body(Body::empty()),
        }
        .expect("requête");

        let res = self.router.clone().oneshot(req).await.expect("réponse");
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .expect("corps");
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        TestResponse {
            status,
            headers,
            body,
            text,
        }
    }

    pub async fn get(&self, uri: &str, cookie: &str) -> TestResponse {
        self.request(Method::GET, uri, Some(cookie), None).await
    }

    /// Crée l'utilisateur de test (mot de passe bcrypt, coût minimal).
    pub async fn create_user(&self) {
        let hash = bcrypt::hash(TEST_PASSWORD, 4).expect("bcrypt");
        sqlx::query(
            "INSERT INTO auth_user (id, name, email, emailVerified, username, displayUsername) VALUES ('u1', 'Testeur', 'testeur@example.test', 1, ?, ?)",
        )
        .bind(TEST_USERNAME)
        .bind(TEST_USERNAME)
        .execute(self.pool())
        .await
        .expect("auth_user");
        sqlx::query(
            "INSERT INTO auth_account (id, accountId, providerId, userId, password, updatedAt) VALUES ('a1', 'u1', 'credential', 'u1', ?, NOW(3))",
        )
        .bind(hash)
        .execute(self.pool())
        .await
        .expect("auth_account");
    }

    /// Connexion par l'endpoint réel ; renvoie l'en-tête `Cookie` à rejouer.
    pub async fn login(&self) -> String {
        self.create_user().await;
        let res = self
            .request(
                Method::POST,
                "/api/auth/sign-in/username",
                None,
                Some(serde_json::json!({
                    "username": TEST_USERNAME,
                    "password": TEST_PASSWORD,
                })),
            )
            .await;
        assert_eq!(res.status, StatusCode::OK, "connexion : {}", res.text);
        cookie_header(&res)
    }
}

/// En-tête `Cookie` reconstruit à partir des `Set-Cookie` d'une réponse.
pub fn cookie_header(res: &TestResponse) -> String {
    res.headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v: &HeaderValue| v.to_str().ok())
        .filter_map(|v| v.split(';').next())
        .filter(|pair| !pair.ends_with('='))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Compare deux flottants stockés en `float` (simple précision).
pub fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-3,
        "attendu {expected}, obtenu {actual}"
    );
}
