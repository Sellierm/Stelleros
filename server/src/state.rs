use std::sync::{Arc, OnceLock};
use std::time::Duration;

use socketioxide::SocketIo;
use sqlx::MySqlPool;

use crate::auth::AuthRateLimiter;
use crate::config::Config;
use crate::location::{MAX_POINTS_PER_SEC, PositionLog};
use crate::middleware::RateLimiter;
use crate::sencrop::SencropToken;

pub struct Limiters {
    pub location: RateLimiter,
    /// Positions GPS par device (socket + HTTP) : 10 Hz max (+ marge).
    pub device: RateLimiter,
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
    pub position_log: PositionLog,
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
                // Garde-fou par IP, large : plusieurs devices à 10 Hz peuvent
                // partager la même IP. La vraie limite est `device`.
                location: RateLimiter::new(
                    Duration::from_secs(60),
                    3_000,
                    "Too many location updates from this IP, please slow down.",
                ),
                device: RateLimiter::new(
                    Duration::from_secs(1),
                    MAX_POINTS_PER_SEC,
                    "Too many location updates for this device, please slow down.",
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
            position_log: PositionLog::default(),
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
