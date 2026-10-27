//! Réimplémentation des endpoints better-auth utilisés par le client React
//! (`better-auth/react` + plugin username) :
//!
//! * `POST /api/auth/sign-in/username`
//! * `GET  /api/auth/get-session`
//! * `POST /api/auth/sign-out`
//! * `GET  /api/auth/ok`
//!
//! Le format est identique à better-auth 1.7 : mêmes tables (`auth_user`,
//! `auth_session`, `auth_account`), même cookie signé HMAC-SHA256
//! (`better-auth.session_token`, préfixé `__Secure-` en production), mêmes
//! durées (session 2 h glissante, rafraîchie toutes les 5 min), même
//! rate-limit et même contrôle d'origine. Les sessions ouvertes par le serveur
//! Node restent donc valides après la bascule, et inversement.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use chrono::{NaiveDateTime, Utc};
use hmac::{Hmac, Mac};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use rand::Rng;
use rand::distributions::Alphanumeric;
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::Row;
use sqlx::mysql::MySqlRow;

use crate::db::{iso_string, local_naive_from_utc, local_naive_to_utc};
use crate::middleware::header_str;
use crate::state::AppState;

type HmacSha256 = Hmac<Sha256>;

const SESSION_EXPIRES_IN: i64 = 2 * 60 * 60;
const SESSION_UPDATE_AGE: i64 = 5 * 60;
const DONT_REMEMBER_EXPIRES_IN: i64 = 24 * 60 * 60;
const MIN_USERNAME_LENGTH: usize = 3;
const MAX_USERNAME_LENGTH: usize = 10;
const MAX_PASSWORD_LENGTH: usize = 128;
const BCRYPT_COST: u32 = 12;

// ── Modèles ───────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct AuthUser {
    pub id: String,
    pub name: String,
    pub email: String,
    pub email_verified: bool,
    pub image: Option<String>,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
    pub username: Option<String>,
    pub display_username: Option<String>,
}

#[derive(Clone)]
struct AuthSession {
    id: String,
    expires_at: NaiveDateTime,
    token: String,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
    ip_address: Option<String>,
    user_agent: Option<String>,
    user_id: String,
}

fn iso(naive: NaiveDateTime) -> String {
    iso_string(local_naive_to_utc(naive))
}

fn millis(naive: NaiveDateTime) -> i64 {
    local_naive_to_utc(naive).timestamp_millis()
}

impl AuthUser {
    fn from_row(row: &MySqlRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            email: row.try_get("email")?,
            email_verified: row.try_get_unchecked::<i64, _>("emailVerified")? != 0,
            image: row.try_get("image")?,
            created_at: row.try_get_unchecked("createdAt")?,
            updated_at: row.try_get_unchecked("updatedAt")?,
            username: row.try_get("username")?,
            display_username: row.try_get("displayUsername")?,
        })
    }

    /// Même ordre de clés que better-auth (`id` en dernier).
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "email": self.email,
            "emailVerified": self.email_verified,
            "image": self.image,
            "createdAt": iso(self.created_at),
            "updatedAt": iso(self.updated_at),
            "username": self.username,
            "displayUsername": self.display_username,
            "id": self.id,
        })
    }
}

impl AuthSession {
    fn from_row(row: &MySqlRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            expires_at: row.try_get_unchecked("expiresAt")?,
            token: row.try_get("token")?,
            created_at: row.try_get_unchecked("createdAt")?,
            updated_at: row.try_get_unchecked("updatedAt")?,
            ip_address: row.try_get("ipAddress")?,
            user_agent: row.try_get("userAgent")?,
            user_id: row.try_get("userId")?,
        })
    }

    fn to_json(&self) -> Value {
        json!({
            "expiresAt": iso(self.expires_at),
            "token": self.token,
            "createdAt": iso(self.created_at),
            "updatedAt": iso(self.updated_at),
            "ipAddress": self.ip_address,
            "userAgent": self.user_agent,
            "userId": self.user_id,
            "id": self.id,
        })
    }
}

// ── Cookies ───────────────────────────────────────────────────────────────

/// Caractères laissés intacts par `encodeURIComponent`.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

struct CookieNames {
    session_token: String,
    session_data: String,
    dont_remember: String,
}

fn cookie_names(state: &AppState) -> CookieNames {
    let prefix = if state.cfg.is_prod { "__Secure-" } else { "" };
    CookieNames {
        session_token: format!("{prefix}better-auth.session_token"),
        session_data: format!("{prefix}better-auth.session_data"),
        dont_remember: format!("{prefix}better-auth.dont_remember"),
    }
}

/// Sérialise un cookie avec les attributs de better-auth
/// (`Path=/; HttpOnly; [Secure;] SameSite=Strict|Lax`).
fn serialize_cookie(state: &AppState, name: &str, value: &str, max_age: Option<i64>) -> String {
    let mut cookie = format!("{name}={value}");
    if let Some(max_age) = max_age {
        cookie.push_str(&format!("; Max-Age={max_age}"));
    }
    cookie.push_str("; Path=/; HttpOnly");
    if state.cfg.is_prod {
        cookie.push_str("; Secure; SameSite=Strict");
    } else {
        cookie.push_str("; SameSite=Lax");
    }
    cookie
}

fn sign(secret: &str, value: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepte toute clé");
    mac.update(value.as_bytes());
    BASE64.encode(mac.finalize().into_bytes())
}

fn signed_cookie(state: &AppState, name: &str, value: &str, max_age: Option<i64>) -> String {
    let signed = format!("{value}.{}", sign(&state.cfg.auth_secret, value));
    let encoded = utf8_percent_encode(&signed, URI_COMPONENT).to_string();
    serialize_cookie(state, name, &encoded, max_age)
}

fn expired_cookie(state: &AppState, name: &str) -> String {
    serialize_cookie(state, name, "", Some(0))
}

/// Analyse l'en-tête `Cookie` comme better-call (première occurrence gagnante,
/// valeurs décodées).
fn parse_cookies(headers: &HeaderMap) -> HashMap<String, String> {
    let mut cookies = HashMap::new();
    for raw in headers.get_all(header::COOKIE) {
        let Ok(raw) = raw.to_str() else { continue };
        for pair in raw.split(';') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            let key = key.trim();
            if key.is_empty() || cookies.contains_key(key) {
                continue;
            }
            let mut value = value.trim();
            if value.starts_with('"') && value.len() >= 2 && value.ends_with('"') {
                value = &value[1..value.len() - 1];
            }
            let decoded = if value.contains('%') {
                percent_decode_str(value)
                    .decode_utf8()
                    .map(|v| v.into_owned())
                    .unwrap_or_else(|_| value.to_string())
            } else {
                value.to_string()
            };
            cookies.insert(key.to_string(), decoded);
        }
    }
    cookies
}

/// `ctx.getSignedCookie` : renvoie la valeur si la signature est valide.
fn get_signed_cookie(
    state: &AppState,
    cookies: &HashMap<String, String>,
    name: &str,
) -> Option<String> {
    let value = cookies.get(name)?;
    let pos = value.rfind('.')?;
    if pos < 1 {
        return None;
    }
    let (signed_value, signature) = (&value[..pos], &value[pos + 1..]);
    if signature.len() != 44 || !signature.ends_with('=') {
        return None;
    }
    let signature = BASE64.decode(signature).ok()?;
    let mut mac = HmacSha256::new_from_slice(state.cfg.auth_secret.as_bytes()).ok()?;
    mac.update(signed_value.as_bytes());
    mac.verify_slice(&signature).ok()?;
    Some(signed_value.to_string())
}

/// Cookies `session_data` (et ses fragments `.0`, `.1`…) présents dans la requête.
fn session_data_cookie_names(cookies: &HashMap<String, String>, base: &str) -> Vec<String> {
    let chunk_prefix = format!("{base}.");
    let mut names: Vec<String> = cookies
        .keys()
        .filter(|k| {
            k.as_str() == base
                || k.strip_prefix(&chunk_prefix).is_some_and(|rest| {
                    !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())
                })
        })
        .cloned()
        .collect();
    names.sort();
    names
}

/// `deleteSessionCookie` : expire session_token, session_data et dont_remember.
fn delete_session_cookies(state: &AppState, cookies: &HashMap<String, String>) -> Vec<String> {
    let names = cookie_names(state);
    let mut set = vec![
        expired_cookie(state, &names.session_token),
        expired_cookie(state, &names.session_data),
    ];
    for chunk in session_data_cookie_names(cookies, &names.session_data) {
        if chunk != names.session_data {
            set.push(expired_cookie(state, &chunk));
        }
    }
    set.push(expired_cookie(state, &names.dont_remember));
    set
}

// ── Utilitaires ───────────────────────────────────────────────────────────

fn generate_id() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

/// Réponse JSON telle qu'émise par better-auth (`application/json` sans charset).
fn json_response(status: StatusCode, body: Value) -> Response {
    let mut res = (status, body.to_string()).into_response();
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    res
}

fn api_error(status: StatusCode, code: &str, message: &str) -> Response {
    json_response(status, json!({ "message": message, "code": code }))
}

fn with_cookies(mut res: Response, cookies: Vec<String>) -> Response {
    for cookie in cookies {
        if let Ok(value) = HeaderValue::from_str(&cookie) {
            res.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    res
}

fn is_valid_ip(ip: &str) -> bool {
    ip.parse::<std::net::IpAddr>().is_ok()
}

fn normalize_ip(ip: &str) -> String {
    match ip.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => v6
                .segments()
                .iter()
                .map(|s| format!("{s:04x}"))
                .collect::<Vec<_>>()
                .join(":"),
        },
        _ => ip.to_string(),
    }
}

/// `getIP` de better-auth : X-Forwarded-For à une seule entrée, sinon
/// 127.0.0.1 en développement, sinon aucune.
fn auth_ip(state: &AppState, headers: &HeaderMap) -> Option<String> {
    if let Some(value) = header_str(headers, "x-forwarded-for") {
        let ips: Vec<&str> = value
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .collect();
        if ips.len() == 1 && is_valid_ip(ips[0]) {
            return Some(normalize_ip(ips[0]));
        }
    }
    (!state.cfg.is_prod).then(|| "127.0.0.1".to_string())
}

fn origin_of(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    let origin = url.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

fn is_trusted_origin(state: &AppState, url: &str, allow_relative: bool) -> bool {
    if url.starts_with('/') {
        return allow_relative
            && !url.starts_with("//")
            && !url.contains('\\')
            && !url.chars().any(|c| c.is_control());
    }
    match origin_of(url) {
        Some(origin) => state.cfg.trusted_origins.contains(&origin),
        None => false,
    }
}

/// `validateOrigin` : avec des cookies, l'Origin (ou le Referer) doit faire
/// partie des origines de confiance.
fn validate_origin(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    if !headers.contains_key(header::COOKIE) {
        return Ok(());
    }
    let origin = header_str(headers, "origin")
        .filter(|v| !v.is_empty())
        .or_else(|| header_str(headers, "referer").filter(|v| !v.is_empty()))
        .unwrap_or("");
    if origin.is_empty() || origin == "null" {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "MISSING_OR_NULL_ORIGIN",
            "Missing or null Origin",
        ));
    }
    if !is_trusted_origin(state, origin, false) {
        eprintln!("[AUTH] Invalid origin: {origin}");
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "INVALID_ORIGIN",
            "Invalid origin",
        ));
    }
    Ok(())
}

/// Corps de requête au sens de better-call (JSON ou formulaire).
fn parse_auth_body(headers: &HeaderMap, bytes: &[u8]) -> Result<Option<Value>, Response> {
    let content_type = header_str(headers, "content-type")
        .unwrap_or("")
        .to_ascii_lowercase();
    let media = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let is_json = media
        .strip_prefix("application/")
        .is_some_and(|sub| sub == "json" || sub.ends_with("+json"));
    if is_json {
        if bytes.is_empty() {
            return Ok(None);
        }
        return serde_json::from_slice(bytes).map(Some).map_err(|_| {
            api_error(
                StatusCode::BAD_REQUEST,
                "BAD_REQUEST",
                "Invalid JSON in request body",
            )
        });
    }
    if content_type.contains("application/x-www-form-urlencoded") {
        let map = form_urlencoded::parse(bytes)
            .map(|(k, v)| (k.into_owned(), Value::String(v.into_owned())))
            .collect();
        return Ok(Some(Value::Object(map)));
    }
    Ok(None)
}

// ── Rate limiting (stratégie better-auth) ─────────────────────────────────

#[derive(Default)]
pub struct AuthRateLimiter {
    entries: Mutex<HashMap<String, (u32, Instant)>>,
}

impl AuthRateLimiter {
    /// `Some(retry_after)` quand la requête doit être refusée.
    fn consume(&self, key: &str, window: Duration, max: u32) -> Option<u64> {
        let now = Instant::now();
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() > 100_000 {
            entries.retain(|_, (_, last)| now.duration_since(*last) < Duration::from_secs(600));
        }
        match entries.get_mut(key) {
            None => {
                entries.insert(key.to_string(), (1, now));
                None
            }
            Some((count, last)) => {
                if now.duration_since(*last) >= window {
                    *count = 1;
                    *last = now;
                    None
                } else if *count >= max {
                    let remaining = window.saturating_sub(now.duration_since(*last));
                    Some(remaining.as_millis().div_ceil(1000) as u64)
                } else {
                    *count += 1;
                    *last = now;
                    None
                }
            }
        }
    }
}

fn rate_limit(state: &AppState, headers: &HeaderMap, path: &str) -> Result<(), Response> {
    let (window, max) = if path == "/sign-in/username" {
        (600, 10)
    } else {
        (600, 60)
    };
    let ip = auth_ip(state, headers).unwrap_or_else(|| "no-trusted-ip".into());
    let key = format!("{ip}|{path}");
    match state
        .limiters
        .auth
        .consume(&key, Duration::from_secs(window), max)
    {
        None => Ok(()),
        Some(retry_after) => {
            let mut res = json_response(
                StatusCode::TOO_MANY_REQUESTS,
                json!({ "message": "Too many requests. Please try again later." }),
            );
            if let Ok(v) = HeaderValue::from_str(&retry_after.to_string()) {
                res.headers_mut().insert("x-retry-after", v);
            }
            Err(res)
        }
    }
}

// ── Accès base ────────────────────────────────────────────────────────────

async fn find_session(
    state: &AppState,
    token: &str,
) -> Result<Option<(AuthSession, AuthUser)>, sqlx::Error> {
    let Some(row) = sqlx::query("SELECT * FROM auth_session WHERE token = ? LIMIT 1")
        .bind(token)
        .fetch_optional(&state.pool)
        .await?
    else {
        return Ok(None);
    };
    let session = AuthSession::from_row(&row)?;
    let Some(user_row) = sqlx::query("SELECT * FROM auth_user WHERE id = ? LIMIT 1")
        .bind(&session.user_id)
        .fetch_optional(&state.pool)
        .await?
    else {
        return Ok(None);
    };
    Ok(Some((session, AuthUser::from_row(&user_row)?)))
}

async fn delete_session(state: &AppState, token: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM auth_session WHERE token = ?")
        .bind(token)
        .execute(&state.pool)
        .await
        .map(|_| ())
}

// ── Résolution de session (auth.api.getSession) ───────────────────────────

enum Lookup {
    /// Pas de cookie de session valide.
    None,
    /// Session absente ou expirée : les cookies doivent être effacés.
    Gone,
    /// Rafraîchissement impossible (session supprimée entre-temps).
    RefreshFailed,
    Valid {
        session: AuthSession,
        user: AuthUser,
        refreshed: bool,
    },
}

async fn lookup_session(
    state: &AppState,
    cookies: &HashMap<String, String>,
) -> Result<Lookup, sqlx::Error> {
    let names = cookie_names(state);
    let Some(token) = get_signed_cookie(state, cookies, &names.session_token) else {
        return Ok(Lookup::None);
    };
    let dont_remember =
        get_signed_cookie(state, cookies, &names.dont_remember).is_some_and(|v| !v.is_empty());

    let now = Utc::now();
    let Some((mut session, user)) = find_session(state, &token).await? else {
        return Ok(Lookup::Gone);
    };
    if millis(session.expires_at) < now.timestamp_millis() {
        delete_session(state, &session.token).await?;
        return Ok(Lookup::Gone);
    }
    if dont_remember {
        return Ok(Lookup::Valid {
            session,
            user,
            refreshed: false,
        });
    }

    let should_update = millis(session.expires_at) - SESSION_EXPIRES_IN * 1000
        + SESSION_UPDATE_AGE * 1000
        <= now.timestamp_millis();
    if !should_update {
        return Ok(Lookup::Valid {
            session,
            user,
            refreshed: false,
        });
    }

    let expires_at = local_naive_from_utc(now + chrono::Duration::seconds(SESSION_EXPIRES_IN));
    let updated_at = local_naive_from_utc(now);
    let result =
        sqlx::query("UPDATE auth_session SET expiresAt = ?, updatedAt = ? WHERE token = ?")
            .bind(expires_at)
            .bind(updated_at)
            .bind(&session.token)
            .execute(&state.pool)
            .await?;
    if result.rows_affected() == 0 {
        return Ok(Lookup::RefreshFailed);
    }
    session.expires_at = expires_at;
    session.updated_at = updated_at;
    Ok(Lookup::Valid {
        session,
        user,
        refreshed: true,
    })
}

/// Session courante pour les routes protégées et Socket.IO.
pub async fn get_session_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<AuthUser>, sqlx::Error> {
    let cookies = parse_cookies(headers);
    Ok(match lookup_session(state, &cookies).await? {
        Lookup::Valid { user, .. } => Some(user),
        _ => None,
    })
}

// ── Endpoints ─────────────────────────────────────────────────────────────

async fn get_session_endpoint(state: &AppState, headers: &HeaderMap) -> Response {
    let cookies = parse_cookies(headers);
    let names = cookie_names(state);
    let mut set_cookies: Vec<String> = session_data_cookie_names(&cookies, &names.session_data)
        .iter()
        .map(|name| expired_cookie(state, name))
        .collect();

    let res = match lookup_session(state, &cookies).await {
        Ok(Lookup::None) => json_response(StatusCode::OK, Value::Null),
        Ok(Lookup::Gone) => {
            set_cookies = delete_session_cookies(state, &cookies);
            json_response(StatusCode::OK, Value::Null)
        }
        Ok(Lookup::RefreshFailed) => {
            set_cookies = delete_session_cookies(state, &cookies);
            api_error(
                StatusCode::UNAUTHORIZED,
                "FAILED_TO_GET_SESSION",
                "Failed to get session",
            )
        }
        Ok(Lookup::Valid {
            session,
            user,
            refreshed,
        }) => {
            if refreshed {
                set_cookies.push(signed_cookie(
                    state,
                    &names.session_token,
                    &session.token,
                    Some(SESSION_EXPIRES_IN),
                ));
            }
            json_response(
                StatusCode::OK,
                json!({ "session": session.to_json(), "user": user.to_json() }),
            )
        }
        Err(err) => {
            eprintln!("[AUTH] INTERNAL_SERVER_ERROR get-session: {err}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "FAILED_TO_GET_SESSION",
                "Failed to get session",
            )
        }
    };
    let mut res = with_cookies(res, set_cookies);
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res.headers_mut()
        .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    res
}

async fn hash_password(password: String) {
    let _ = tokio::task::spawn_blocking(move || bcrypt::hash(password, BCRYPT_COST)).await;
}

async fn verify_password(password: String, hash: String) -> bool {
    if !hash.starts_with("$2") {
        return false;
    }
    tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash).unwrap_or(false))
        .await
        .unwrap_or(false)
}

fn invalid_credentials() -> Response {
    api_error(
        StatusCode::UNAUTHORIZED,
        "INVALID_USERNAME_OR_PASSWORD",
        "Invalid username or password",
    )
}

async fn sign_in_username(state: &AppState, headers: &HeaderMap, body: &[u8]) -> Response {
    if let Err(res) = validate_origin(state, headers) {
        return res;
    }

    let body = match parse_auth_body(headers, body) {
        Ok(body) => body,
        Err(res) => return res,
    };
    let Some(Value::Object(body)) = body else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "VALIDATION_ERROR",
            "Invalid body parameters",
        );
    };
    let (Some(Value::String(username)), Some(Value::String(password))) =
        (body.get("username"), body.get("password"))
    else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "VALIDATION_ERROR",
            "Invalid body parameters",
        );
    };
    let remember_me = match body.get("rememberMe") {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "VALIDATION_ERROR",
                "Invalid body parameters",
            );
        }
    };
    let callback_url = match body.get("callbackURL") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "VALIDATION_ERROR",
                "Invalid body parameters",
            );
        }
    };
    if let Some(callback) = callback_url.as_deref().filter(|c| !c.is_empty())
        && !is_trusted_origin(state, callback, true)
    {
        eprintln!("[AUTH] Invalid callbackURL: {callback}");
        return api_error(
            StatusCode::FORBIDDEN,
            "INVALID_CALLBACK_URL",
            "Invalid callbackURL",
        );
    }

    if username.is_empty() || password.is_empty() {
        return invalid_credentials();
    }
    let username_len = username.encode_utf16().count();
    if username_len < MIN_USERNAME_LENGTH {
        return api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "USERNAME_TOO_SHORT",
            "Username is too short",
        );
    }
    if username_len > MAX_USERNAME_LENGTH {
        return api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "USERNAME_TOO_LONG",
            "Username is too long",
        );
    }
    if !username
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')
    {
        return api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "INVALID_USERNAME",
            "Username is invalid",
        );
    }
    if password.encode_utf16().count() > MAX_PASSWORD_LENGTH {
        return api_error(
            StatusCode::BAD_REQUEST,
            "PASSWORD_TOO_LONG",
            "Password too long",
        );
    }

    let user_row = match sqlx::query("SELECT * FROM auth_user WHERE username = ? LIMIT 1")
        .bind(username.to_lowercase())
        .fetch_optional(&state.pool)
        .await
    {
        Ok(row) => row,
        Err(err) => return internal_error(err),
    };
    let Some(user_row) = user_row else {
        // Hachage factice pour ne pas révéler l'existence du compte par le timing.
        hash_password(password.clone()).await;
        eprintln!("[AUTH] User not found");
        return invalid_credentials();
    };
    let user = match AuthUser::from_row(&user_row) {
        Ok(user) => user,
        Err(err) => return internal_error(err),
    };

    let accounts =
        match sqlx::query("SELECT providerId, password FROM auth_account WHERE userId = ?")
            .bind(&user.id)
            .fetch_all(&state.pool)
            .await
        {
            Ok(rows) => rows,
            Err(err) => return internal_error(err),
        };
    let Some(account) = accounts.iter().find(|row| {
        row.try_get::<String, _>("providerId")
            .is_ok_and(|p| p == "credential")
    }) else {
        return invalid_credentials();
    };
    let Some(hash) = account
        .try_get::<Option<String>, _>("password")
        .ok()
        .flatten()
        .filter(|h| !h.is_empty())
    else {
        eprintln!("[AUTH] Password not found");
        return invalid_credentials();
    };
    if !verify_password(password.clone(), hash).await {
        eprintln!("[AUTH] Invalid password");
        return invalid_credentials();
    }

    // Création de la session (internalAdapter.createSession).
    let dont_remember = remember_me == Some(false);
    let now = Utc::now();
    let lifetime = if dont_remember {
        DONT_REMEMBER_EXPIRES_IN
    } else {
        SESSION_EXPIRES_IN
    };
    let session = AuthSession {
        id: generate_id(),
        expires_at: local_naive_from_utc(now + chrono::Duration::seconds(lifetime)),
        token: generate_id(),
        created_at: local_naive_from_utc(now),
        updated_at: local_naive_from_utc(now),
        ip_address: Some(auth_ip(state, headers).unwrap_or_default()),
        user_agent: Some(header_str(headers, "user-agent").unwrap_or("").to_string()),
        user_id: user.id.clone(),
    };
    if let Err(err) = sqlx::query(
        "INSERT INTO auth_session (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&session.id)
    .bind(session.expires_at)
    .bind(&session.token)
    .bind(session.created_at)
    .bind(session.updated_at)
    .bind(&session.ip_address)
    .bind(&session.user_agent)
    .bind(&session.user_id)
    .execute(&state.pool)
    .await
    {
        eprintln!("[AUTH] Échec création session: {err}");
        return api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "FAILED_TO_CREATE_SESSION",
            "Failed to create session",
        );
    }

    let names = cookie_names(state);
    let mut cookies = vec![signed_cookie(
        state,
        &names.session_token,
        &session.token,
        (!dont_remember).then_some(SESSION_EXPIRES_IN),
    )];
    if dont_remember {
        cookies.push(signed_cookie(state, &names.dont_remember, "true", None));
    }

    let mut payload = serde_json::Map::new();
    payload.insert(
        "redirect".into(),
        Value::Bool(callback_url.as_deref().is_some_and(|c| !c.is_empty())),
    );
    payload.insert("token".into(), Value::String(session.token.clone()));
    if let Some(callback) = &callback_url {
        payload.insert("url".into(), Value::String(callback.clone()));
    }
    payload.insert("user".into(), user.to_json());

    let mut res = with_cookies(
        json_response(StatusCode::OK, Value::Object(payload)),
        cookies,
    );
    if let Some(callback) = callback_url.as_deref().filter(|c| !c.is_empty())
        && let Ok(v) = HeaderValue::from_str(callback)
    {
        res.headers_mut().insert(header::LOCATION, v);
    }
    res
}

async fn sign_out(state: &AppState, headers: &HeaderMap) -> Response {
    if let Err(res) = validate_origin(state, headers) {
        return res;
    }
    let cookies = parse_cookies(headers);
    let names = cookie_names(state);
    if let Some(token) = get_signed_cookie(state, &cookies, &names.session_token)
        && let Err(err) = delete_session(state, &token).await
    {
        eprintln!("[AUTH] Failed to delete session from database: {err}");
    }
    with_cookies(
        json_response(StatusCode::OK, json!({ "success": true })),
        delete_session_cookies(state, &cookies),
    )
}

fn internal_error(err: sqlx::Error) -> Response {
    eprintln!("[AUTH] Erreur base de données: {err}");
    api_error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "INTERNAL_SERVER_ERROR",
        "Internal Server Error",
    )
}

/// Point d'entrée `/api/auth/*`.
pub async fn handler(State(state): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let path = parts
        .uri
        .path()
        .strip_prefix("/api/auth")
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();

    if let Err(res) = rate_limit(&state, &parts.headers, &path) {
        return res;
    }

    let body = match axum::body::to_bytes(body, 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => Bytes::new(),
    };

    match (parts.method.clone(), path.as_str()) {
        (Method::GET, "/get-session") => get_session_endpoint(&state, &parts.headers).await,
        (Method::POST, "/get-session") => api_error(
            StatusCode::METHOD_NOT_ALLOWED,
            "METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED",
            "POST method requires deferSessionRefresh to be enabled in session config",
        ),
        (Method::POST, "/sign-in/username") => {
            sign_in_username(&state, &parts.headers, &body).await
        }
        (Method::POST, "/sign-out") => sign_out(&state, &parts.headers).await,
        (Method::GET, "/ok") => json_response(StatusCode::OK, json!({ "ok": true })),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_matches_better_call() {
        // Valeurs de référence calculées avec Node (HMAC-SHA256 base64 +
        // encodeURIComponent), soit l'algorithme de better-call.
        assert_eq!(
            sign("secret", "token"),
            "6UERDj0r/oJiHw4+FDRzDXMF0QbF9oyHFl0LJ6RhGko="
        );
        let signed = format!("abc.{}", sign("secret", "abc"));
        assert_eq!(
            utf8_percent_encode(&signed, URI_COMPONENT).to_string(),
            "abc.mUba1OAOkT%2FIvo5dP34RCkqegy%2BD%2BwnDRShdeGONig4%3D"
        );
    }

    #[test]
    fn uri_component_encoding() {
        let encoded = utf8_percent_encode("a+b/c=.d", URI_COMPONENT).to_string();
        assert_eq!(encoded, "a%2Bb%2Fc%3D.d");
    }

    #[test]
    fn ids_are_alphanumeric() {
        let id = generate_id();
        assert_eq!(id.len(), 32);
        assert!(id.bytes().all(|b| b.is_ascii_alphanumeric()));
    }
}
