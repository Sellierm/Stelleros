//! Appels aux API Sencrop (OAuth2 client_credentials + refresh automatique)
//! et OpenWeatherMap.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::StatusCode;
use serde_json::{Value, json};

use crate::js;
use crate::state::AppState;

#[derive(Default)]
pub struct SencropToken {
    access_token: String,
    /// Échéance en ms epoch (`NaN`/0 = inconnue, donc expirée).
    expires_at: f64,
}

fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

/// Récupère un nouveau token Sencrop via client_credentials.
pub async fn refresh_token(state: &AppState) -> bool {
    let sencrop = &state.cfg.sencrop;
    let credentials = BASE64.encode(format!(
        "{}:{}",
        sencrop.application_id, sencrop.application_secret
    ));
    let response = state
        .http
        .post(format!("{}/oauth2/token", sencrop.end_point))
        .header("Authorization", format!("Basic {credentials}"))
        .header("Content-Type", "application/json")
        .body(json!({ "grant_type": "client_credentials", "scope": "user" }).to_string())
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(err) => {
            eprintln!("[Sencrop] Erreur refresh token: {err}");
            return false;
        }
    };
    if !response.status().is_success() {
        eprintln!(
            "[Sencrop] Échec refresh token — HTTP {}",
            response.status().as_u16()
        );
        return false;
    }
    let data: Value = match response.json().await {
        Ok(data) => data,
        Err(err) => {
            eprintln!("[Sencrop] Erreur refresh token: {err}");
            return false;
        }
    };

    let expires_in = match data.get("expires_in") {
        None | Some(Value::Null) => 3600.0,
        other => js::to_number(other),
    };
    {
        let mut token = state.sencrop_token.lock().await;
        token.access_token = match data.get("access_token") {
            Some(Value::String(s)) => s.clone(),
            other => js::to_js_string(other),
        };
        token.expires_at = now_ms() + (expires_in - 60.0) * 1000.0;
    }
    println!(
        "[Sencrop] Token renouvelé — expire dans {} min",
        js::num_to_string((expires_in / 60.0 + 0.5).floor())
    );
    true
}

/// Rafraîchit le token s'il est absent ou expiré.
async fn ensure_token(state: &AppState) -> bool {
    let expired = {
        let token = state.sencrop_token.lock().await;
        token.access_token.is_empty()
            || token.expires_at == 0.0
            || token.expires_at.is_nan()
            || now_ms() >= token.expires_at
    };
    if expired {
        println!("[Sencrop] Token absent ou expiré — tentative de refresh");
        return refresh_token(state).await;
    }
    true
}

async fn bearer(state: &AppState) -> String {
    format!("Bearer {}", state.sencrop_token.lock().await.access_token)
}

fn failure() -> Value {
    json!({ "success": false })
}

/// Appelle l'API Sencrop avec refresh automatique en cas de 401.
/// Renvoie le JSON de la réponse, ou `{ success: false }` en cas d'erreur.
pub async fn fetch_data(state: &AppState, url: &str) -> Value {
    ensure_token(state).await;

    let send = |auth: String| state.http.get(url).header("Authorization", auth).send();

    let mut response = match send(bearer(state).await).await {
        Ok(r) => r,
        Err(err) => {
            eprintln!("[Sencrop] Erreur réseau: {err}");
            return failure();
        }
    };

    if response.status() == StatusCode::UNAUTHORIZED {
        eprintln!("[Sencrop] 401 reçu — refresh token et retry");
        if !refresh_token(state).await {
            return failure();
        }
        response = match send(bearer(state).await).await {
            Ok(r) => r,
            Err(err) => {
                eprintln!("[Sencrop] Erreur réseau: {err}");
                return failure();
            }
        };
    }

    if !response.status().is_success() {
        eprintln!("[Sencrop] Erreur HTTP {}", response.status().as_u16());
        return failure();
    }

    match response.json::<Value>().await {
        Ok(data) => data,
        Err(err) => {
            eprintln!("[Sencrop] Erreur réseau: {err}");
            failure()
        }
    }
}

/// Récupère les prévisions OpenWeatherMap (`{}` en cas d'erreur).
pub async fn fetch_forecast(state: &AppState) -> Value {
    let forecast = &state.cfg.forecast;
    let url = format!(
        "https://api.openweathermap.org/data/3.0/onecall?lat={}&lon={}&exclude=current,minutely,alerts&appid={}&units=metric",
        js::num_to_string(forecast.latitude),
        js::num_to_string(forecast.longitude),
        forecast.key
    );
    let result = async {
        let response = state.http.get(url).send().await?;
        response.json::<Value>().await
    }
    .await;
    result.unwrap_or_else(|err| {
        eprintln!("Error fetching weather data: {err}");
        json!({})
    })
}
