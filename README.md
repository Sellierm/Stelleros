# Stelleros

Stelleros is a farm-management application built with React, Vite, a Rust
API (axum, Socket.IO via socketioxide, sqlx) and MariaDB/MySQL.

The application provides:

- field maps and crop data from Google My Maps/KML;
- OpenWeather and Sencrop weather data;
- GPS position ingestion and machine position history;
- plant-protection product stock and application tracking;
- Better Auth username/password authentication.

## Project structure

```text
client/                 React/Vite frontend
server/                 Rust API and Socket.IO server
server/src/auth.rs      Better Auth compatible authentication endpoints
server/src/routes/      API routes (phyto, GPS, config, forecast, SPA)
server/src/socket.rs    Socket.IO events (web clients and GPS devices)
server/src/track.rs     GPS history: daily compaction and track simplification
server/migrations/      Versioned SQL migrations (applied at startup)
server/schema/auth.sql  Authentication tables
Dockerfile              Production image definition
```

## Requirements

- Rust 1.94 or newer (`rustup`);
- Node.js 20 or newer for the client;
- MariaDB/MySQL;
- Docker for container deployment;
- API credentials for Google Maps, OpenWeather and Sencrop when those features
  are enabled.

## Configuration

Create the server environment file from the template:

```bash
cp server/.env.example server/.env
```

PowerShell:

```powershell
Copy-Item server/.env.example server/.env
```

Set the values in `server/.env`:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Runtime environment, normally `development` or `production` |
| `PORT`, `IP` | API listening port and address |
| `CORS_ORIGINS` | Comma-separated allowed frontend origins |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE` | MariaDB/MySQL connection |
| `BETTER_AUTH_SECRET` | Long random secret signing session cookies (required in production) |
| `BETTER_AUTH_URL` | Public URL of the application |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Optional extra trusted origins, comma-separated |
| `MAP_PLAN_URLS` | Comma-separated farm map URLs, one per year since 2022 |
| `CLIENT_DIST` | Optional path to the React build (default `../client/dist`) |
| `GPS_INGEST_KEY` | Shared key for GPS devices |
| `GPS_ALLOWED_IDS` | Comma-separated authorized GPS device IDs |
| `GPS_RETENTION_DAYS` | Optional: GPS history kept for this many days (unset or `0` = forever) |
| `GOOGLE_MAPS_API_KEY` | Google Maps JavaScript API key |
| `OPENWEATHER_API_KEY` | OpenWeather API key |
| `FORECAST_LATITUDE`, `FORECAST_LONGITUDE`, `FORECAST_CITY` | Forecast location |
| `SENCROP_*` | Sencrop credentials and device configuration |

Generate a Better Auth secret with:

```bash
openssl rand -base64 32
```

Never commit `server/.env` or expose any database password or authentication
secret.

## Development

Install both applications:

```bash
npm run install:all
```

Start the API in one terminal:

```bash
npm run dev:server
```

Start the Vite client in another:

```bash
npm run dev:client
```

The client runs on <http://localhost:5173> and proxies `/api` and `/socket.io`
to the API, which listens on port `4200` by default.

The individual commands are also available:

```bash
cd server && cargo run
cd client && npm install && npm run dev
```

Run the server checks with:

```bash
cd server && cargo test && cargo clippy --all-targets
```

## Authentication and database migration

The Rust API implements the Better Auth endpoints used by the client
(`get-session`, `sign-in/username`, `sign-out`) with the same signed
`better-auth.session_token` cookie, the same session lifetime (2 hours,
refreshed every 5 minutes, 24 hours without "remember me") and the same
database tables. Sessions created by the former Node server remain valid.

Create the authentication tables if they do not exist yet:

```bash
mysql -u <user> -p <database> < server/schema/auth.sql
```

The script creates:

- `auth_user`;
- `auth_session`;
- `auth_account`;
- `auth_verification`.

Verify the result:

```sql
SHOW TABLES LIKE 'auth_%';
```

Public sign-up is disabled. Existing users from the legacy `user` table must
be copied to Better Auth after the schema migration. Back up the database and
inspect the generated columns first:

```sql
DESCRIBE auth_user;
DESCRIBE auth_account;
```

Then, if the columns match the current Better Auth schema:

```sql
INSERT INTO auth_user
  (id, name, email, emailVerified, username, displayUsername, createdAt, updatedAt)
SELECT
  UUID(),
  u.name,
  CONCAT(LOWER(u.name), '@stelleros.local'),
  0,
  LOWER(u.name),
  u.name,
  NOW(),
  NOW()
FROM `user` u
WHERE NOT EXISTS (
  SELECT 1 FROM auth_user a WHERE a.displayUsername = u.name
);

INSERT INTO auth_account
  (id, accountId, providerId, userId, password, createdAt, updatedAt)
SELECT
  UUID(),
  a.id,
  'credential',
  a.id,
  u.password,
  NOW(),
  NOW()
FROM auth_user a
JOIN `user` u ON u.name = a.displayUsername
WHERE NOT EXISTS (
  SELECT 1
  FROM auth_account acc
  WHERE acc.userId = a.id
    AND acc.providerId = 'credential'
);
```

Existing passwords must be bcrypt hashes (`$2...`). Keep the legacy `user`
table until login, logout, session expiration and all protected routes have
been validated.

## Database modules

The API expects the business tables used by the server, including:

- `vehicles`;
- `maintenance`;
- `phyto_products`;
- `phyto_applications`;
- `phyto_application_products`.

The Phyto API uses the following relationships:

- an application stores its `date` and `notes`;
- `phyto_application_products` links applications to products;
- `quantity_used` is used to update product stock.

Create or maintain these tables using the database schema for the deployment
environment. Do not use the obsolete schema in which
`phyto_applications` contains a single `product_id` column.

## Maps and weather configuration

Field map URLs are configured with `MAP_PLAN_URLS`, one comma-separated entry
per supported year starting with 2022. When the variable is empty, the server
reads the `table` array of the untracked `server/modules/mapModule.js` file if
it exists.

The Google Maps API key is supplied through `GOOGLE_MAPS_API_KEY`. OpenWeather
and Sencrop settings are supplied through the corresponding environment
variables.

## Security

- Better Auth provides authentication sessions and authentication rate
  limiting.
- Protected API routes use the Better Auth session middleware.
- Unsafe API methods require a same-origin request.
- Phyto routes have an additional IP-based rate limiter.
- GPS HTTP ingestion uses `GPS_INGEST_KEY` and `GPS_ALLOWED_IDS`.
- Web Socket.IO clients require a Better Auth session.
- GPS Socket.IO clients use their device ID and ingestion key.

## Production Docker image

The image expects `client/dist` to exist before the image is built:

```bash
cd client
npm ci
npm run build
cd ..
docker build -t stelleros .
```

The image compiles the Rust server in a build stage and copies
`server/modules/mapModule.js` when it is present. Run it on port `3000`:

```bash
docker run --rm --name stelleros \
  --env-file server/.env \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -p 3000:3000 \
  stelleros
```

Open <http://localhost:3000>. Rebuild the client and Docker image after
frontend changes.

If deployment uses Docker Compose, run Compose commands from the deployment
environment's Compose file. This repository provides the `Dockerfile`, but
does not require a Compose file for local image builds.

## GPS sender

GPS positions can be sent by the
[gps-sender](https://github.com/Sellierm/gps-sender) project through:

```text
POST /api/location
```

The sender and this API must share the configured GPS ingestion key and
authorized device IDs.

### GPS history

- Database migrations in `server/migrations/` run automatically at startup
  (`sqlx migrate`).
- Every day at 05:00 (Europe/Paris), previous days not yet processed (up to 7
  days back) are compacted: stationary points and points on straight lines are
  removed, but every removed point stays within its own measured accuracy
  (clamped to 2 cm–2 m) of the kept track. Arrival and departure of each stop
  are kept. Results are logged in the `gps_compaction` table.
- Older days can be compacted manually:

  ```bash
  docker exec site-site-app-1 ./farm-server compact-gps 2026-09-07 2026-10-21
  ```

- The history API applies the same simplification on the fly (current day).
