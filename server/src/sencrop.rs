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

impl SencropToken {
    fn is_expired(&self) -> bool {
        self.access_token.is_empty()
            || self.expires_at == 0.0
            || self.expires_at.is_nan()
            || now_ms() >= self.expires_at
    }
}

fn now_ms() -> f64 {
    chrono::Utc::now().timestamp_millis() as f64
}

/// Récupère un nouveau token Sencrop via client_credentials, dans `token`
/// (verrou de `state.sencrop_token` tenu par l'appelant).
async fn refresh_token(state: &AppState, token: &mut SencropToken) -> bool {
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
    token.access_token = match data.get("access_token") {
        Some(Value::String(s)) => s.clone(),
        other => js::to_js_string(other),
    };
    token.expires_at = now_ms() + (expires_in - 60.0) * 1000.0;
    println!(
        "[Sencrop] Token renouvelé — expire dans {} min",
        js::num_to_string((expires_in / 60.0 + 0.5).floor())
    );
    true
}

/// Token à présenter à Sencrop, renouvelé s'il est absent ou expiré, ou s'il
/// est celui que Sencrop vient de refuser (`refused`, après un 401). Le verrou
/// reste pris pendant le renouvellement : des requêtes simultanées n'en
/// lancent qu'un, les autres attendent puis reprennent le nouveau token.
/// Si le renouvellement échoue, `Err` porte le token courant.
async fn valid_token(state: &AppState, refused: Option<&str>) -> Result<String, String> {
    let mut token = state.sencrop_token.lock().await;
    let stale = match refused {
        Some(refused) => token.access_token == refused,
        None => token.is_expired(),
    };
    if stale {
        if refused.is_none() {
            println!("[Sencrop] Token absent ou expiré — tentative de refresh");
        }
        if !refresh_token(state, &mut token).await {
            return Err(token.access_token.clone());
        }
    }
    Ok(token.access_token.clone())
}

fn failure() -> Value {
    json!({ "success": false })
}

/// Appelle l'API Sencrop avec refresh automatique en cas de 401.
/// Renvoie le JSON de la réponse, ou `{ success: false }` en cas d'erreur.
pub async fn fetch_data(state: &AppState, url: &str) -> Value {
    // Renouvellement raté : on tente quand même le token courant (renouvelé
    // 60 s avant son échéance, il peut encore passer).
    let token = valid_token(state, None)
        .await
        .unwrap_or_else(|current| current);

    let send = |token: &str| {
        state
            .http
            .get(url)
            .header("Authorization", format!("Bearer {token}"))
            .send()
    };

    let mut response = match send(&token).await {
        Ok(r) => r,
        Err(err) => {
            eprintln!("[Sencrop] Erreur réseau: {err}");
            return failure();
        }
    };

    if response.status() == StatusCode::UNAUTHORIZED {
        eprintln!("[Sencrop] 401 reçu — refresh token et retry");
        // Pas de nouveau renouvellement si une requête simultanée l'a déjà fait.
        let Ok(token) = valid_token(state, Some(&token)).await else {
            return failure();
        };
        response = match send(&token).await {
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use axum::Router;
    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::{get, post};

    use super::*;
    use crate::config::Config;
    use crate::state::Inner;

    /// Faux Sencrop : chaque appel à /oauth2/token émet un nouveau token
    /// (`t1`, `t2`…) et /data n'accepte que le dernier émis.
    async fn faux_sencrop() -> (String, Arc<AtomicUsize>) {
        let emis = Arc::new(AtomicUsize::new(0));
        let app = Router::new()
            .route(
                "/oauth2/token",
                post(|State(emis): State<Arc<AtomicUsize>>| async move {
                    // Laisse aux requêtes simultanées le temps de se chevaucher.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    let n = emis.fetch_add(1, Ordering::SeqCst) + 1;
                    axum::Json(json!({ "access_token": format!("t{n}"), "expires_in": 3600 }))
                }),
            )
            .route(
                "/data",
                get(
                    |State(emis): State<Arc<AtomicUsize>>, headers: HeaderMap| async move {
                        let attendu = format!("Bearer t{}", emis.load(Ordering::SeqCst));
                        let recu = headers.get("authorization").and_then(|v| v.to_str().ok());
                        if recu == Some(attendu.as_str()) {
                            (StatusCode::OK, axum::Json(json!({ "ok": true })))
                        } else {
                            (StatusCode::UNAUTHORIZED, axum::Json(json!({})))
                        }
                    },
                ),
            )
            .with_state(emis.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (base, emis)
    }

    fn etat(end_point: &str) -> AppState {
        let mut cfg = Config::from_env().expect("config");
        cfg.sencrop.end_point = end_point.to_string();
        let pool = crate::db::create_pool(&cfg.db);
        Arc::new(Inner::new(cfg, pool, reqwest::Client::new()))
    }

    async fn requetes_simultanees(state: &AppState, url: &str, n: usize) -> Vec<Value> {
        let mut set = tokio::task::JoinSet::new();
        for _ in 0..n {
            let (state, url) = (state.clone(), url.to_string());
            set.spawn(async move { fetch_data(&state, &url).await });
        }
        set.join_all().await
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn token_absent_un_seul_renouvellement() {
        let (base, emis) = faux_sencrop().await;
        let state = etat(&base);
        let resultats = requetes_simultanees(&state, &format!("{base}/data"), 5).await;
        assert!(resultats.iter().all(|r| r["ok"] == true), "{resultats:?}");
        assert_eq!(emis.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn token_refuse_un_seul_renouvellement() {
        let (base, emis) = faux_sencrop().await;
        let state = etat(&base);
        {
            // Encore valide selon son échéance, mais refusé par Sencrop (401).
            let mut token = state.sencrop_token.lock().await;
            token.access_token = "revoque".into();
            token.expires_at = now_ms() + 3_600_000.0;
        }
        let resultats = requetes_simultanees(&state, &format!("{base}/data"), 5).await;
        assert!(resultats.iter().all(|r| r["ok"] == true), "{resultats:?}");
        assert_eq!(emis.load(Ordering::SeqCst), 1);
    }
}
