# Stelleros

Stelleros is a farm-management application built with React, Vite, Express,
Socket.IO and MariaDB/MySQL.

The application provides:

- field maps and crop data from Google My Maps/KML;
- OpenWeather and Sencrop weather data;
- GPS position ingestion and machine position history;
- plant-protection product stock and application tracking;
- Better Auth username/password authentication.

## Project structure

```text
client/                 React/Vite frontend
server/                 Express API and Socket.IO server
server/lib/auth.mjs     Better Auth configuration
server/lib/authBridge.js CommonJS bridge for Express
server/modules/         Database, map and Sencrop modules
server/routes/          API route modules
Dockerfile              Production image definition
```

## Requirements

- Node.js 20 or newer;
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
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE` | MariaDB/MySQL connection |
| `BETTER_AUTH_SECRET` | Long random secret used by Better Auth |
| `BETTER_AUTH_URL` | Public URL of the application |
| `GPS_INGEST_KEY` | Shared key for GPS devices |
| `GPS_ALLOWED_IDS` | Comma-separated authorized GPS device IDs |
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

The individual package commands are also available:

```bash
cd server && npm install && npm run dev
cd client && npm install && npm run dev
```

## Authentication and database migration

Authentication is handled by Better Auth. Express does not use
`express-session`; sessions are stored in the database and accessed through
`server/lib/authBridge.js`.

Create Better Auth's tables with the CLI from the `server` directory:

```bash
cd server
npx @better-auth/cli@latest migrate --config lib/auth.mjs
```

The migration creates:

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

Field KML URLs are configured in
[`server/modules/mapModule.js`](server/modules/mapModule.js), one entry per
supported year. Update that file when adding or replacing Google My Maps
layers.

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

Run it on port `3000`:

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
