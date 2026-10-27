use std::sync::{Arc, OnceLock};
use std::time::Duration;

use socketioxide::SocketIo;
use sqlx::MySqlPool;

use crate::auth::AuthRateLimiter;
use crate::config::Config;
use crate::middleware::RateLimiter;
use crate::sencrop::SencropToken;

pub struct Limiters {
    pub location: RateLimiter,
    pub phyto: RateLimiter,
    pub spa: RateLimiter,
    pub auth: AuthRateLimiter,
}

pub struct Inner {
    pub cfg: Config,
    pub pool: MySqlPool,
    pub http: reqwest::Client,
    pub sencrop_token: tokio::sync::Mutex<SencropToken>,
    pub limiters: Limiters,
    io: OnceLock<SocketIo>,
}

pub type AppState = Arc<Inner>;

impl Inner {
    pub fn new(cfg: Config, pool: MySqlPool, http: reqwest::Client) -> Self {
        Self {
            cfg,
            pool,
            http,
            sencrop_token: tokio::sync::Mutex::new(SencropToken::default()),
            limiters: Limiters {
                location: RateLimiter::new(
                    Duration::from_secs(60),
                    60,
                    "Too many location updates from this IP, please slow down.",
                ),
                phyto: RateLimiter::new(
                    Duration::from_secs(15 * 60),
                    100,
                    "Too many requests from this IP, please try again later.",
                ),
                spa: RateLimiter::new(
                    Duration::from_secs(15 * 60),
                    100,
                    "Too many requests, please try again later.",
                ),
                auth: AuthRateLimiter::default(),
            },
            io: OnceLock::new(),
        }
    }

    pub fn set_io(&self, io: SocketIo) {
        let _ = self.io.set(io);
    }

    pub fn io(&self) -> &SocketIo {
        self.io.get().expect("Socket.IO non initialisé")
    }
}
