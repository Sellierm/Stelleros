use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::Response;
use serde_json::{Map, Value};
use tower::ServiceExt;
use tower_http::services::ServeDir;

use crate::auth::{self, AuthUser};
use crate::middleware::{client_ip, error_page, fail, json_response, peer_ip, text_response};
use crate::sencrop;
use crate::state::AppState;

pub mod gps;
pub mod phyto;

/// Équivalent de `authMiddleware` : 401 sans session valide.
pub async fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, Response> {
    match auth::get_session_user(state, headers).await {
        Ok(Some(user)) => Ok(user),
        Ok(None) => Err(fail(StatusCode::UNAUTHORIZED, "Unauthorized")),
        Err(err) => {
            eprintln!("[AUTH] Erreur lecture session: {err}");
            Err(fail(StatusCode::UNAUTHORIZED, "Unauthorized"))
        }
    }
}

/// `GET /api/config`
pub async fn get_config(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    let mut body = Map::new();
    if let Some(key) = &state.cfg.google_maps_api_key {
        body.insert("googleMapsApiKey".into(), Value::String(key.clone()));
    }
    json_response(StatusCode::OK, Value::Object(body))
}

/// `GET /api/env` — public : le bandeau s'affiche aussi sur la page de
/// connexion. Le libellé vient de l'environnement et non du build, pour que
/// la même image serve en préprod puis en prod.
pub async fn get_env(State(state): State<AppState>) -> Response {
    let mut body = Map::new();
    if let Some(label) = &state.cfg.env_label {
        body.insert("label".into(), Value::String(label.clone()));
    }
    json_response(StatusCode::OK, Value::Object(body))
}

/// `GET /api/forecast`
pub async fn get_forecast(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(res) = require_user(&state, &headers).await {
        return res;
    }
    json_response(StatusCode::OK, sencrop::fetch_forecast(&state).await)
}

fn is_dotfile_path(path: &str) -> bool {
    path.split('/').any(|segment| segment.starts_with('.'))
}

/// Type MIME façon `send` (module utilisé par express.static) : charset
/// UTF-8 pour le texte, `application/javascript` pour les scripts.
fn with_charset(mut res: Response) -> Response {
    let current = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let updated = match current.as_deref() {
        Some("text/javascript") => Some("application/javascript; charset=UTF-8".to_string()),
        Some(ct)
            if !ct.contains("charset") && (ct.starts_with("text/") || ct == "application/json") =>
        {
            Some(format!("{ct}; charset=UTF-8"))
        }
        _ => None,
    };
    if let Some(value) = updated.and_then(|v| HeaderValue::from_str(&v).ok()) {
        res.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    res
}

/// Fichiers statiques du build React, puis repli SPA sur `index.html`.
/// Dans Express, les requêtes arrivant ici traversaient le routeur phyto (et
/// son limiteur) avant le repli `app.get("*")` et son propre limiteur.
pub async fn fallback(State(state): State<AppState>, req: Request) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let ip = client_ip(&state.cfg, req.headers(), peer_ip(req.extensions()));
    let is_read = method == Method::GET || method == Method::HEAD;
    let dist = state.cfg.client_dist.clone();

    // express.static
    if is_read && dist.is_dir() && !is_dotfile_path(&path) {
        let Ok(res) = ServeDir::new(&dist).oneshot(req).await;
        let status = res.status();
        if status.is_success() || status.is_redirection() {
            return with_charset(res.map(Body::new));
        }
    }

    // routeur phyto : son limiteur s'applique à tout ce qui le traverse
    let phyto = match state.limiters.phyto.hit(&ip).into_result() {
        Ok(outcome) => outcome,
        Err(res) => return res,
    };

    if !is_read {
        return phyto.decorate(error_page(
            StatusCode::NOT_FOUND,
            &format!("Cannot {method} {path}"),
        ));
    }

    // repli SPA
    let spa = match state.limiters.spa.hit(&ip).into_result() {
        Ok(outcome) => outcome,
        Err(res) => return res,
    };
    let index = dist.join("index.html");
    let res = match tokio::fs::read(&index).await {
        Ok(content) => {
            let mut res = Response::new(if method == Method::HEAD {
                Body::empty()
            } else {
                Body::from(content)
            });
            res.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=UTF-8"),
            );
            res
        }
        Err(_) => text_response(
            StatusCode::NOT_FOUND,
            "Build the React client first: cd client && npm run build".into(),
        ),
    };
    spa.decorate(res)
}
