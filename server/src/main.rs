// Les handlers renvoient `Result<_, Response>` : la taille de `Response`
// est sans importance ici.
#![allow(clippy::result_large_err, clippy::large_enum_variant)]

mod auth;
mod config;
mod db;
mod js;
mod location;
mod middleware;
mod routes;
mod sencrop;
mod socket;
mod state;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::routing::{any, get, post, put};
use socketioxide::SocketIo;

use crate::config::Config;
use crate::state::{AppState, Inner};

fn build_router(state: AppState, socket_layer: socketioxide::layer::SocketIoLayer) -> Router {
    let phyto = Router::new()
        .route(
            "/api/phyto/products",
            get(routes::phyto::list_products).post(routes::phyto::create_product),
        )
        .route(
            "/api/phyto/products/{id}",
            put(routes::phyto::update_product).delete(routes::phyto::delete_product),
        )
        .route(
            "/api/phyto/applications",
            get(routes::phyto::list_applications).post(routes::phyto::create_application),
        )
        .route(
            "/api/phyto/applications/{id}",
            put(routes::phyto::update_application).delete(routes::phyto::delete_application),
        )
        .route("/api/phyto/export", get(routes::phyto::export_applications))
        .route(
            "/api/phyto/products/export",
            get(routes::phyto::export_products),
        )
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::phyto_limit,
        ));

    let location = Router::new()
        .route("/api/location", post(routes::gps::post_location))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            middleware::location_limit,
        ));

    Router::new()
        .route("/api/auth/{*rest}", any(auth::handler))
        .route("/api/config", get(routes::get_config))
        .route("/api/forecast", get(routes::get_forecast))
        .route("/api/latest-positions", get(routes::gps::latest_positions))
        .route(
            "/api/positions-history",
            get(routes::gps::positions_history),
        )
        .route("/api/positions-dates", get(routes::gps::positions_dates))
        .merge(location)
        .merge(phyto)
        .fallback(routes::fallback)
        .method_not_allowed_fallback(routes::fallback)
        .with_state(state.clone())
        .layer(socket_layer)
        .layer(axum::middleware::from_fn_with_state(
            state,
            middleware::edge,
        ))
}

#[tokio::main]
async fn main() {
    config::load_dotenv();
    let cfg = match Config::from_env() {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("Server failed to start: {err}");
            std::process::exit(1);
        }
    };

    let pool = db::create_pool(&cfg.db);
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("client HTTP");
    let addr = format!("{}:{}", cfg.host, cfg.port);
    let is_prod = cfg.is_prod;

    let state: AppState = Arc::new(Inner::new(cfg, pool, http));

    let (socket_layer, io) = SocketIo::builder()
        .max_payload(1_000_000)
        .with_state(state.clone())
        .build_layer();
    socket::register(&io);
    state.set_io(io);

    let app = build_router(state, socket_layer);

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("Server failed to start: {err}");
            std::process::exit(1);
        }
    };
    println!(
        "Server running on {addr} ({})",
        if is_prod { "prod" } else { "dev" }
    );

    if let Err(err) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    {
        eprintln!("Server failed to start: {err}");
    }
}
