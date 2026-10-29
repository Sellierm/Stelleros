use std::env;
use std::path::{Path, PathBuf};

use crate::js;

const DEFAULT_AUTH_SECRET: &str = "better-auth-secret-12345678901234567890";

pub struct SencropConfig {
    pub user_id: String,
    pub application_id: String,
    pub application_secret: String,
    pub windcrop_earl_id: String,
    pub raincrop_earl_id: String,
    pub end_point: String,
}

pub struct ForecastConfig {
    pub key: String,
    pub latitude: f64,
    pub longitude: f64,
}

pub struct DbConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: Option<String>,
}

pub struct Config {
    pub is_prod: bool,
    pub port: u16,
    pub host: String,
    pub allowed_origins: Vec<String>,
    pub cors_allowed_suffix: String,
    pub gps_ingest_key: Option<String>,
    pub gps_allowed_ids: Vec<String>,
    /// Durée de conservation de l'historique GPS en jours (`None` = illimitée).
    pub gps_retention_days: Option<u32>,
    pub db: DbConfig,
    pub google_maps_api_key: Option<String>,
    /// Libellé affiché en bandeau par le client (« PRÉPROD »), absent en prod.
    pub env_label: Option<String>,
    pub map_plan_urls: Vec<String>,
    pub forecast: ForecastConfig,
    pub sencrop: SencropConfig,
    pub auth_secret: String,
    pub trusted_origins: Vec<String>,
    pub client_dist: PathBuf,
}

/// Charge `.env` depuis le dossier courant, ou `server/.env` quand le binaire
/// est lancé depuis la racine du dépôt.
pub fn load_dotenv() {
    for candidate in [".env", "server/.env"] {
        if Path::new(candidate).is_file() {
            if let Err(err) = dotenvy::from_path(candidate) {
                eprintln!("[CONFIG] Lecture de {candidate} impossible: {err}");
            }
            return;
        }
    }
}

/// Valeur non vide d'une variable d'environnement (`process.env.X || ...`).
fn non_empty(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.is_empty())
}

/// Valeur brute, ou `"undefined"` quand la variable est absente — c'est ce que
/// produisaient les gabarits de chaîne JS (`${process.env.X}`).
fn js_env(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| "undefined".into())
}

/// Équivalent de `Number(process.env.X)`.
fn js_env_number(name: &str) -> f64 {
    match env::var(name) {
        Ok(v) => js::string_to_number(&v),
        Err(_) => f64::NAN,
    }
}

fn split_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(String::from)
        .collect()
}

/// Plans de la ferme : `MAP_PLAN_URLS`, sinon le tableau `table` de l'ancien
/// `modules/mapModule.js` (non versionné) s'il est présent.
fn map_plan_urls() -> Vec<String> {
    let from_env = split_list(&env::var("MAP_PLAN_URLS").unwrap_or_default());
    if !from_env.is_empty() {
        return from_env;
    }
    ["modules/mapModule.js", "server/modules/mapModule.js"]
        .iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
        .map(|source| parse_map_module(&source))
        .unwrap_or_default()
}

/// Extrait les chaînes littérales du tableau `table: [ ... ]`.
fn parse_map_module(source: &str) -> Vec<String> {
    let Some(start) = source.find("table") else {
        return Vec::new();
    };
    let rest = &source[start..];
    let (Some(open), Some(close)) = (rest.find('['), rest.find(']')) else {
        return Vec::new();
    };
    if close < open {
        return Vec::new();
    }
    let mut urls = Vec::new();
    let mut chars = rest[open + 1..close].chars();
    while let Some(c) = chars.next() {
        if c == '"' || c == '\'' || c == '`' {
            let value: String = chars.by_ref().take_while(|&d| d != c).collect();
            urls.push(value);
        }
    }
    urls
}

fn origin_of(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    let origin = url.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

fn resolve_client_dist() -> PathBuf {
    if let Some(dir) = non_empty("CLIENT_DIST") {
        return PathBuf::from(dir);
    }
    ["../client/dist", "client/dist"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_dir())
        .unwrap_or_else(|| PathBuf::from("../client/dist"))
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let is_prod = env::var("NODE_ENV").is_ok_and(|v| v == "production");

        let port_raw = non_empty("PORT").unwrap_or_else(|| "4200".into());
        let port = port_raw
            .trim()
            .parse::<u16>()
            .map_err(|_| format!("PORT invalide: {port_raw}"))?;
        let host = non_empty("IP")
            .or_else(|| non_empty("HOST"))
            .unwrap_or_else(|| "0.0.0.0".into());

        let allowed_origins = split_list(
            &non_empty("CORS_ORIGINS")
                .unwrap_or_else(|| "http://localhost:5173,http://localhost:4200".into()),
        );
        let cors_allowed_suffix = non_empty("CORS_ALLOWED_SUFFIX")
            .unwrap_or_else(|| ".alwaysdata.net".into())
            .trim()
            .to_string();

        let gps_allowed_ids =
            split_list(&non_empty("GPS_ALLOWED_IDS").unwrap_or_else(|| "6290,7724".into()));

        let gps_retention_days = match non_empty("GPS_RETENTION_DAYS") {
            Some(v) => Some(
                v.trim()
                    .parse::<u32>()
                    .map_err(|_| format!("GPS_RETENTION_DAYS invalide: {v}"))?,
            )
            .filter(|days| *days > 0),
            None => None,
        };

        let db = DbConfig {
            host: non_empty("DB_HOST").unwrap_or_else(|| "localhost".into()),
            port: match non_empty("DB_PORT") {
                Some(p) => p
                    .trim()
                    .parse()
                    .map_err(|_| format!("DB_PORT invalide: {p}"))?,
                None => 3306,
            },
            user: env::var("DB_USER").unwrap_or_default(),
            password: env::var("DB_PASSWORD").unwrap_or_default(),
            database: non_empty("DB_DATABASE"),
        };

        let auth_secret = non_empty("BETTER_AUTH_SECRET")
            .or_else(|| non_empty("AUTH_SECRET"))
            .unwrap_or_else(|| DEFAULT_AUTH_SECRET.into());
        if auth_secret == DEFAULT_AUTH_SECRET {
            if is_prod {
                return Err("BETTER_AUTH_SECRET doit être défini quand NODE_ENV=production (génère-le avec : openssl rand -base64 32)".into());
            }
            eprintln!(
                "[AUTH] BETTER_AUTH_SECRET absent — secret par défaut utilisé (dev uniquement)"
            );
        }

        // Origines de confiance de l'auth : CORS_ORIGINS + origine de
        // BETTER_AUTH_URL + BETTER_AUTH_TRUSTED_ORIGINS (comme better-auth).
        let mut trusted_origins = allowed_origins.clone();
        if let Some(origin) = non_empty("BETTER_AUTH_URL").and_then(|u| origin_of(&u)) {
            trusted_origins.push(origin);
        }
        if let Some(extra) = non_empty("BETTER_AUTH_TRUSTED_ORIGINS") {
            trusted_origins.extend(split_list(&extra));
        }

        Ok(Config {
            is_prod,
            port,
            host,
            allowed_origins,
            cors_allowed_suffix,
            gps_ingest_key: non_empty("GPS_INGEST_KEY"),
            gps_allowed_ids,
            gps_retention_days,
            db,
            google_maps_api_key: env::var("GOOGLE_MAPS_API_KEY").ok(),
            env_label: non_empty("ENV_LABEL"),
            map_plan_urls: map_plan_urls(),
            forecast: ForecastConfig {
                key: js_env("OPENWEATHER_API_KEY"),
                latitude: js_env_number("FORECAST_LATITUDE"),
                longitude: js_env_number("FORECAST_LONGITUDE"),
            },
            sencrop: SencropConfig {
                user_id: js_env("SENCROP_USER_ID"),
                application_id: js_env("SENCROP_APPLICATION_ID"),
                application_secret: js_env("SENCROP_APPLICATION_SECRET"),
                windcrop_earl_id: js_env("SENCROP_WINDCROP_EARL_ID"),
                raincrop_earl_id: js_env("SENCROP_RAINCROP_EARL_ID"),
                end_point: non_empty("SENCROP_ENDPOINT")
                    .unwrap_or_else(|| "https://api.sencrop.com/v1".into()),
            },
            auth_secret,
            trusted_origins,
            client_dist: resolve_client_dist(),
        })
    }

    /// Vérification de l'origine CORS (identique à `isOriginAllowed` côté Node).
    pub fn is_origin_allowed(&self, origin: Option<&str>, request_host: &str) -> bool {
        let Some(origin) = origin else {
            return true;
        };
        if self.allowed_origins.iter().any(|o| o == origin) {
            return true;
        }
        let Ok(url) = url::Url::parse(origin) else {
            return false;
        };
        let hostname = url_hostname(&url);
        if !request_host.is_empty() {
            let normalized_host = request_host.split(':').next().unwrap_or("");
            if hostname == normalized_host {
                return true;
            }
        }
        !self.cors_allowed_suffix.is_empty() && hostname.ends_with(&self.cors_allowed_suffix)
    }
}

/// `URL.hostname` (les adresses IPv6 gardent leurs crochets).
pub fn url_hostname(url: &url::Url) -> String {
    match url.host() {
        Some(url::Host::Ipv6(addr)) => format!("[{addr}]"),
        Some(host) => host.to_string(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_map_module;

    #[test]
    fn map_module_table() {
        let src = "\u{feff}module.exports = {\n  key: process.env.K,\n  table: [\n    \"https://a/1\",\n    'https://a/2',\n  ],\n};\n";
        assert_eq!(parse_map_module(src), vec!["https://a/1", "https://a/2"]);
    }
}
