//! Mise à jour automatique de l'appli Android GPS Sender.
//!
//! `deploy/publie-gps-sender.sh` dépose dans `GPS_SENDER_DIR` l'APK signé et
//! `gps-sender.json` (version, taille, empreinte SHA-256). Les tablettes
//! interrogent `/api/gps-sender/version` puis téléchargent `/api/gps-sender/apk`,
//! en s'identifiant comme pour l'envoi des positions : `X-Device-Id` (parmi
//! `GPS_ALLOWED_IDS`) et `Authorization: Bearer <GPS_INGEST_KEY>` (en-tête que
//! Caddy masque dans ses journaux, contrairement à un paramètre d'URL).
//!
//! Le fichier est relu à chaque requête : une publication prend effet sans
//! redémarrer le serveur.

use std::path::Path;

use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use super::gps::is_ingest_key_valid;
use crate::middleware::{auth_log, client_ip, fail, header_str, json_response, peer_ip};
use crate::socket::app_version;
use crate::state::AppState;

/// Description de la version publiée, écrite par `publie-gps-sender.sh`.
pub const RELEASE_FILE: &str = "gps-sender.json";

/// Exclu de la compression HTTP : un APK est déjà une archive zip.
pub const APK_CONTENT_TYPE: &str = "application/vnd.android.package-archive";

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version_code: u32,
    pub version_name: String,
    /// Nom de l'APK dans `GPS_SENDER_DIR` (sans chemin).
    pub file: String,
    pub sha256: String,
    pub size: u64,
}

impl Release {
    fn parse(raw: &str) -> Result<Release, String> {
        let release: Release =
            serde_json::from_str(raw).map_err(|err| format!("JSON invalide : {err}"))?;
        if release.version_code == 0 {
            return Err("versionCode doit être positif".into());
        }
        if app_version(Some(&Value::String(release.version_name.clone()))).as_deref()
            != Some(release.version_name.as_str())
        {
            return Err(format!("versionName invalide : {:?}", release.version_name));
        }
        if !is_safe_file_name(&release.file) {
            return Err(format!("nom d'APK invalide : {:?}", release.file));
        }
        if release.sha256.len() != 64
            || !release
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("sha256 invalide (64 caractères hexadécimaux minuscules)".into());
        }
        if release.size == 0 {
            return Err("taille nulle".into());
        }
        Ok(release)
    }
}

/// Nom de fichier simple, sans chemin ni fichier caché : le JSON ne doit pas
/// pouvoir faire servir autre chose qu'un APK du dossier.
fn is_safe_file_name(name: &str) -> bool {
    name.len() <= 128
        && !name.starts_with('.')
        && name.ends_with(".apk")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `Ok(None)` : rien n'a encore été publié.
async fn read_release(dir: &Path) -> Result<Option<Release>, String> {
    match tokio::fs::read_to_string(dir.join(RELEASE_FILE)).await {
        Ok(raw) => Release::parse(&raw).map(Some),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("lecture impossible : {err}")),
    }
}

fn bearer_token(headers: &HeaderMap) -> &str {
    header_str(headers, "authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("")
}

/// Identifie la tablette ; `Err` contient la réponse 401/500 à renvoyer.
fn authenticate(state: &AppState, headers: &HeaderMap, ip: &str) -> Result<String, Response> {
    let Some(ingest_key) = state.cfg.gps_ingest_key.as_deref() else {
        return Err(fail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "GPS_INGEST_KEY is not configured",
        ));
    };
    let device_id = header_str(headers, "x-device-id")
        .unwrap_or("")
        .trim()
        .to_string();
    let key = Value::String(bearer_token(headers).to_string());
    if !is_ingest_key_valid(ingest_key, Some(&key))
        || !state.cfg.gps_allowed_ids.contains(&device_id)
    {
        auth_log(
            ip,
            "FAIL",
            &format!(
                "Mise à jour GPS Sender refusée : device={device_id} non autorisé ou clé invalide"
            ),
        );
        return Err(fail(StatusCode::UNAUTHORIZED, "Unauthorized"));
    }
    Ok(device_id)
}

/// Version publiée, ou la réponse 404/500 à renvoyer.
async fn published_release(state: &AppState) -> Result<Release, Response> {
    match read_release(&state.cfg.gps_sender_dir).await {
        Ok(Some(release)) => Ok(release),
        Ok(None) => Err(fail(StatusCode::NOT_FOUND, "Aucune version publiée")),
        Err(err) => {
            eprintln!("[GPS-SENDER] {RELEASE_FILE} : {err}");
            Err(fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Version publiée illisible",
            ))
        }
    }
}

/// `GET /api/gps-sender/version` — dernière version publiée.
pub async fn version(State(state): State<AppState>, req: Request) -> Response {
    let ip = client_ip(&state.cfg, req.headers(), peer_ip(req.extensions()));
    if let Err(res) = authenticate(&state, req.headers(), &ip) {
        return res;
    }
    match published_release(&state).await {
        Ok(release) => json_response(
            StatusCode::OK,
            json!({
                "success": true,
                "versionCode": release.version_code,
                "versionName": release.version_name,
                "sha256": release.sha256,
                "size": release.size,
            }),
        ),
        Err(res) => res,
    }
}

/// `GET /api/gps-sender/apk` — l'APK publié, tel quel. La tablette vérifie
/// taille, empreinte et signature avant de l'installer.
pub async fn apk(State(state): State<AppState>, req: Request) -> Response {
    let ip = client_ip(&state.cfg, req.headers(), peer_ip(req.extensions()));
    let device_id = match authenticate(&state, req.headers(), &ip) {
        Ok(device_id) => device_id,
        Err(res) => return res,
    };
    let release = match published_release(&state).await {
        Ok(release) => release,
        Err(res) => return res,
    };
    let path = state.cfg.gps_sender_dir.join(&release.file);
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) if bytes.len() as u64 == release.size => bytes,
        Ok(bytes) => {
            eprintln!(
                "[GPS-SENDER] {} : {} octets au lieu des {} annoncés",
                path.display(),
                bytes.len(),
                release.size
            );
            return fail(StatusCode::INTERNAL_SERVER_ERROR, "APK publié incohérent");
        }
        Err(err) => {
            eprintln!("[GPS-SENDER] {} : {err}", path.display());
            return fail(StatusCode::INTERNAL_SERVER_ERROR, "APK publié introuvable");
        }
    };

    let current = app_version(
        header_str(req.headers(), "x-app-version")
            .map(|v| Value::String(v.into()))
            .as_ref(),
    )
    .unwrap_or_else(|| "version inconnue".into());
    auth_log(
        &ip,
        "OK",
        &format!(
            "Mise à jour GPS Sender : {device_id} ({current}) télécharge la version {} (versionCode {})",
            release.version_name, release.version_code
        ),
    );

    let mut res = (StatusCode::OK, bytes).into_response();
    let headers = res.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(APK_CONTENT_TYPE),
    );
    if let Ok(value) = HeaderValue::from_str(&format!(
        "attachment; filename=\"gps-sender-{}.apk\"",
        release.version_name
    )) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn raw(version_name: &str, file: &str, sha256: &str) -> String {
        json!({
            "versionCode": 7,
            "versionName": version_name,
            "file": file,
            "sha256": sha256,
            "size": 1234,
            "publishedAt": "2026-11-06T10:00:00Z",
            "signer": "ab:cd",
        })
        .to_string()
    }

    #[test]
    fn version_publiee_valide() {
        let release = Release::parse(&raw("2.3.0", "gps-sender-7.apk", SHA)).unwrap();
        assert_eq!(
            release,
            Release {
                version_code: 7,
                version_name: "2.3.0".into(),
                file: "gps-sender-7.apk".into(),
                sha256: SHA.into(),
                size: 1234,
            }
        );
    }

    #[test]
    fn nom_d_apk_hors_du_dossier_refuse() {
        for file in [
            "../server/.env",
            "sous/dossier.apk",
            "..apk",
            ".cache.apk",
            "gps-sender.json",
            "a b.apk",
            "",
        ] {
            assert!(
                Release::parse(&raw("2.3.0", file, SHA)).is_err(),
                "{file:?} accepté"
            );
        }
    }

    #[test]
    fn version_publiee_incomplete_ou_douteuse() {
        assert!(Release::parse(&raw("2.3.0", "a.apk", &SHA[1..])).is_err());
        assert!(Release::parse(&raw("2.3.0", "a.apk", &SHA.to_uppercase())).is_err());
        assert!(Release::parse(&raw("2.3\n[OK] faux", "a.apk", SHA)).is_err());
        assert!(Release::parse(&raw("", "a.apk", SHA)).is_err());
        assert!(Release::parse(r#"{"versionCode":7}"#).is_err());
        assert!(Release::parse("pas du json").is_err());
        let zero = raw("2.3.0", "a.apk", SHA).replace("\"versionCode\":7", "\"versionCode\":0");
        assert!(Release::parse(&zero).is_err());
        let vide = raw("2.3.0", "a.apk", SHA).replace("\"size\":1234", "\"size\":0");
        assert!(Release::parse(&vide).is_err());
    }

    #[test]
    fn jeton_bearer() {
        let mut headers = HeaderMap::new();
        assert_eq!(bearer_token(&headers), "");
        headers.insert("authorization", HeaderValue::from_static("Bearer abc "));
        assert_eq!(bearer_token(&headers), "abc");
        headers.insert("authorization", HeaderValue::from_static("Basic abc"));
        assert_eq!(bearer_token(&headers), "");
    }

    #[tokio::test]
    async fn lecture_du_dossier_de_publication() {
        let dir = std::env::temp_dir().join(format!("gps-sender-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_release(&dir).await, Ok(None));
        std::fs::write(
            dir.join(RELEASE_FILE),
            raw("2.3.0", "gps-sender-7.apk", SHA),
        )
        .unwrap();
        assert_eq!(read_release(&dir).await.unwrap().unwrap().version_code, 7);
        std::fs::write(dir.join(RELEASE_FILE), "{").unwrap();
        assert!(read_release(&dir).await.is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
