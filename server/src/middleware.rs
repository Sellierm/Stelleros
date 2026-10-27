//! Équivalents des middlewares Express : helmet, cors, cache-control, CSRF,
//! express-rate-limit, express.json/urlencoded, et le journal d'auth.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};

use crate::config::{Config, url_hostname};
use crate::state::AppState;

// ── Journal d'authentification ────────────────────────────────────────────

pub fn auth_log(ip: &str, level: &str, message: &str) {
    let ts = crate::db::iso_string(chrono::Utc::now());
    let tag = match level {
        "OK" => "\x1b[32m[OK]\x1b[0m",
        "FAIL" => "\x1b[31m[FAIL]\x1b[0m",
        _ => "\x1b[33m[INFO]\x1b[0m",
    };
    println!("{ts} {tag} [{ip}] {message}");
}

// ── Réponses ──────────────────────────────────────────────────────────────

pub fn json_response(status: StatusCode, body: Value) -> Response {
    let mut res = (status, body.to_string()).into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    res
}

pub fn fail(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({ "success": false, "message": message }))
}

pub fn text_response(status: StatusCode, body: String) -> Response {
    let mut res = (status, body).into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    res
}

/// Page d'erreur de `finalhandler` (404 « Cannot GET … », 400, 413…).
pub fn error_page(status: StatusCode, message: &str) -> Response {
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let body = format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Error</title>\n</head>\n<body>\n<pre>{escaped}</pre>\n</body>\n</html>\n"
    );
    let mut res = text_response(status, body);
    res.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'"),
    );
    res.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    res
}

// ── Adresse client ────────────────────────────────────────────────────────

pub fn peer_ip(req_extensions: &http::Extensions) -> Option<String> {
    req_extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(addr)| addr.ip().to_string())
}

/// `req.ip` d'Express (`trust proxy = 1` en production : dernier saut de
/// X-Forwarded-For).
pub fn client_ip(cfg: &Config, headers: &HeaderMap, peer: Option<String>) -> String {
    if cfg.is_prod
        && let Some(last) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').map(str::trim).next_back())
            .filter(|v| !v.is_empty())
    {
        return last.to_string();
    }
    peer.unwrap_or_else(|| "unknown".into())
}

pub fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// `req.get("x-forwarded-host") || req.get("host") || ""`.
pub fn request_host(headers: &HeaderMap) -> String {
    header_str(headers, "x-forwarded-host")
        .filter(|v| !v.is_empty())
        .or_else(|| header_str(headers, "host").filter(|v| !v.is_empty()))
        .unwrap_or("")
        .to_string()
}

// ── Rate limiting (express-rate-limit, fenêtre fixe en mémoire) ───────────

pub struct RateLimiter {
    window: Duration,
    max: u32,
    message: &'static str,
    hits: Mutex<HashMap<String, (u32, Instant)>>,
}

pub struct RateOutcome {
    allowed: bool,
    limit: u32,
    remaining: u32,
    reset_secs: u64,
    window_secs: u64,
    message: &'static str,
}

impl RateLimiter {
    pub fn new(window: Duration, max: u32, message: &'static str) -> Self {
        Self {
            window,
            max,
            message,
            hits: Mutex::new(HashMap::new()),
        }
    }

    pub fn hit(&self, key: &str) -> RateOutcome {
        let now = Instant::now();
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        if hits.len() > 10_000 {
            hits.retain(|_, (_, reset)| *reset > now);
        }
        let entry = hits
            .entry(key.to_string())
            .or_insert((0, now + self.window));
        if entry.1 <= now {
            *entry = (0, now + self.window);
        }
        entry.0 = entry.0.saturating_add(1);
        let reset_ms = entry.1.saturating_duration_since(now).as_millis() as u64;
        RateOutcome {
            allowed: entry.0 <= self.max,
            limit: self.max,
            remaining: self.max.saturating_sub(entry.0),
            reset_secs: reset_ms.div_ceil(1000),
            window_secs: self.window.as_secs(),
            message: self.message,
        }
    }
}

impl RateOutcome {
    fn apply_headers(&self, headers: &mut HeaderMap) {
        let set = |headers: &mut HeaderMap, name: &'static str, value: String| {
            if let Ok(v) = HeaderValue::from_str(&value) {
                headers.insert(HeaderName::from_static(name), v);
            }
        };
        set(
            headers,
            "ratelimit-policy",
            format!("{};w={}", self.limit, self.window_secs),
        );
        set(headers, "ratelimit-limit", self.limit.to_string());
        set(headers, "ratelimit-remaining", self.remaining.to_string());
        set(headers, "ratelimit-reset", self.reset_secs.to_string());
    }

    /// `Err` contient la réponse 429 à renvoyer telle quelle.
    pub fn into_result(self) -> Result<RateOutcome, Response> {
        if self.allowed {
            return Ok(self);
        }
        let mut res = text_response(StatusCode::TOO_MANY_REQUESTS, self.message.to_string());
        self.apply_headers(res.headers_mut());
        if let Ok(v) = HeaderValue::from_str(&self.reset_secs.to_string()) {
            res.headers_mut().insert(header::RETRY_AFTER, v);
        }
        Err(res)
    }

    pub fn decorate(&self, mut res: Response) -> Response {
        self.apply_headers(res.headers_mut());
        res
    }
}

/// Applique un limiteur à une route (équivalent de `router.use(limiter)`).
pub async fn limit_with(
    limiter: &RateLimiter,
    state: &AppState,
    req: Request,
    next: Next,
) -> Response {
    let ip = client_ip(&state.cfg, req.headers(), peer_ip(req.extensions()));
    match limiter.hit(&ip).into_result() {
        Ok(outcome) => outcome.decorate(next.run(req).await),
        Err(res) => res,
    }
}

pub async fn location_limit(State(state): State<AppState>, req: Request, next: Next) -> Response {
    limit_with(&state.limiters.location, &state, req, next).await
}

pub async fn phyto_limit(State(state): State<AppState>, req: Request, next: Next) -> Response {
    limit_with(&state.limiters.phyto, &state, req, next).await
}

// ── Corps de requête (express.json + express.urlencoded) ──────────────────

const BODY_LIMIT: usize = 100 * 1024;

fn media_type(headers: &HeaderMap) -> String {
    header_str(headers, "content-type")
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// Reproduit `req.body` d'Express : `{}` quand aucun parseur ne s'applique,
/// 400 pour un JSON invalide, 413 au-delà de 100 ko.
pub fn parse_body(headers: &HeaderMap, bytes: &[u8]) -> Result<Value, Response> {
    let media = media_type(headers);
    let is_json = media == "application/json";
    let is_form = media == "application/x-www-form-urlencoded";
    if !is_json && !is_form {
        return Ok(Value::Object(Map::new()));
    }
    if bytes.len() > BODY_LIMIT {
        return Err(error_page(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PayloadTooLargeError: request entity too large",
        ));
    }
    if is_json {
        let text = String::from_utf8_lossy(bytes);
        let trimmed = text.trim_start_matches([' ', '\t', '\n', '\r']);
        if trimmed.is_empty() {
            return Ok(Value::Object(Map::new()));
        }
        if !trimmed.starts_with('{') && !trimmed.starts_with('[') {
            return Err(error_page(StatusCode::BAD_REQUEST, "Bad Request"));
        }
        return serde_json::from_str(trimmed)
            .map_err(|_| error_page(StatusCode::BAD_REQUEST, "Bad Request"));
    }
    let mut map = Map::new();
    for (key, value) in form_urlencoded::parse(bytes) {
        let value = Value::String(value.into_owned());
        match map.get_mut(key.as_ref()) {
            Some(Value::Array(items)) => items.push(value),
            Some(existing) => {
                let first = existing.take();
                *existing = Value::Array(vec![first, value]);
            }
            None => {
                map.insert(key.into_owned(), value);
            }
        }
    }
    Ok(Value::Object(map))
}

/// Lit puis analyse le corps d'une requête (`req.body` d'Express).
pub async fn read_body(headers: &HeaderMap, body: Body) -> Result<Value, Response> {
    let bytes = axum::body::to_bytes(body, BODY_LIMIT).await.map_err(|_| {
        error_page(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PayloadTooLargeError: request entity too large",
        )
    })?;
    parse_body(headers, &bytes)
}

/// `express.json()`/`express.urlencoded()` sont montés globalement : un corps
/// invalide est rejeté avant le contrôle CSRF, l'auth et les routes. Le corps
/// est remis en place pour être relu par le handler.
async fn precheck_body(req: Request) -> Result<Request, Response> {
    let media = media_type(req.headers());
    if media != "application/json" && media != "application/x-www-form-urlencoded" {
        return Ok(req);
    }
    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, BODY_LIMIT).await.map_err(|_| {
        error_page(
            StatusCode::PAYLOAD_TOO_LARGE,
            "PayloadTooLargeError: request entity too large",
        )
    })?;
    parse_body(&parts.headers, &bytes)?;
    Ok(Request::from_parts(parts, Body::from(bytes)))
}

/// Valeurs d'un paramètre de query string (plusieurs occurrences possibles).
pub fn query_values(query: Option<&str>, name: &str) -> Vec<String> {
    form_urlencoded::parse(query.unwrap_or("").as_bytes())
        .filter(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
        .collect()
}

// ── En-têtes helmet + CORS + cache + CSRF ─────────────────────────────────

const CSP: &str = "default-src 'self';script-src 'self' maps.googleapis.com maps.gstatic.com;style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://use.fontawesome.com https://www.google.com/maps/d https://api.sencrop.com/v1;img-src 'self' data: blob: *.googleapis.com *.gstatic.com *.google.com https://openweathermap.org;connect-src 'self' *.googleapis.com wss: ws: https://www.google.com https://api.sencrop.com;font-src 'self' fonts.gstatic.com https://use.fontawesome.com;frame-src 'none';object-src 'none';worker-src blob:;base-uri 'self';form-action 'self';frame-ancestors 'self';script-src-attr 'none';upgrade-insecure-requests";

const HELMET_HEADERS: [(&str, &str); 12] = [
    ("content-security-policy", CSP),
    ("cross-origin-opener-policy", "same-origin"),
    ("cross-origin-resource-policy", "cross-origin"),
    ("origin-agent-cluster", "?1"),
    ("referrer-policy", "no-referrer"),
    (
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
    ),
    ("x-content-type-options", "nosniff"),
    ("x-dns-prefetch-control", "off"),
    ("x-download-options", "noopen"),
    ("x-frame-options", "SAMEORIGIN"),
    ("x-permitted-cross-domain-policies", "none"),
    ("x-xss-protection", "0"),
];

/// helmet pose ses en-têtes avant les routes : une valeur posée ensuite par
/// un handler (ex. CSP de la page d'erreur) reste prioritaire.
fn apply_helmet(headers: &mut HeaderMap) {
    for (name, value) in HELMET_HEADERS {
        let name = HeaderName::from_static(name);
        if !headers.contains_key(&name) {
            headers.insert(name, HeaderValue::from_static(value));
        }
    }
}

fn append_vary(headers: &mut HeaderMap, value: &'static str) {
    headers.append(header::VARY, HeaderValue::from_static(value));
}

/// En-têtes ajoutés par le paquet `cors` pour une origine autorisée.
fn apply_cors(headers: &mut HeaderMap, origin: Option<&HeaderValue>) {
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
    }
    append_vary(headers, "Origin");
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
}

fn preflight_response(req_headers: &HeaderMap, methods: &'static str, helmet: bool) -> Response {
    let mut res = Response::new(Body::empty());
    *res.status_mut() = StatusCode::NO_CONTENT;
    let headers = res.headers_mut();
    if helmet {
        apply_helmet(headers);
    }
    apply_cors(headers, req_headers.get(header::ORIGIN));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static(methods),
    );
    if let Some(requested) = req_headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
        headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, requested.clone());
        append_vary(headers, "Access-Control-Request-Headers");
    }
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from_static("0"));
    res
}

/// Vérification same-origin (Origin vs Host).
fn is_same_origin_request(headers: &HeaderMap) -> bool {
    let Some(origin) = header_str(headers, "origin").filter(|v| !v.is_empty()) else {
        return false;
    };
    let host = request_host(headers);
    if host.is_empty() {
        return false;
    }
    match url::Url::parse(origin) {
        Ok(url) => url_hostname(&url) == host.split(':').next().unwrap_or(""),
        Err(_) => false,
    }
}

/// Couche « bord » : CORS de Socket.IO pour `/socket.io`, et pour le reste la
/// pile Express (helmet → cors → cache-control → CSRF).
pub async fn edge(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let origin = header_str(req.headers(), "origin").map(String::from);

    if path.starts_with("/socket.io") {
        let allowed = state.cfg.is_origin_allowed(origin.as_deref(), "");
        if !allowed {
            return next.run(req).await;
        }
        if method == Method::OPTIONS {
            return preflight_response(req.headers(), "GET,POST", false);
        }
        let origin_header = req.headers().get(header::ORIGIN).cloned();
        let mut res = next.run(req).await;
        apply_cors(res.headers_mut(), origin_header.as_ref());
        return res;
    }

    let host = request_host(req.headers());
    let cors_allowed = state.cfg.is_origin_allowed(origin.as_deref(), &host);
    let origin_header = req.headers().get(header::ORIGIN).cloned();

    if cors_allowed && method == Method::OPTIONS {
        return preflight_response(req.headers(), "GET,HEAD,PUT,PATCH,POST,DELETE", true);
    }

    let unsafe_method = matches!(
        method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    let is_auth = path.starts_with("/api/auth/");
    let csrf_exempt = path == "/api/location" || is_auth;
    let checked = if is_auth {
        Ok(req)
    } else {
        precheck_body(req).await
    };
    let mut res = match checked {
        Err(res) => res,
        Ok(req) if unsafe_method && !csrf_exempt && !is_same_origin_request(req.headers()) => {
            json_response(
                StatusCode::FORBIDDEN,
                json!({ "success": false, "message": "Invalid origin", "code": "CSRF_INVALID" }),
            )
        }
        Ok(req) => next.run(req).await,
    };

    let headers = res.headers_mut();
    apply_helmet(headers);
    if cors_allowed {
        apply_cors(headers, origin_header.as_ref());
    }
    if !headers.contains_key(header::CACHE_CONTROL) {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache, private, no-store, must-revalidate"),
        );
    }
    res
}
