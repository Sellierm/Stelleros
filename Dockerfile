# Image complète (serveur + client) construite par deploy/deploie.sh à partir
# du contenu versionné (plus server/modules/, non versionné) : la même image
# passe de la préprod à la prod.

FROM node:22-bookworm-slim AS client

WORKDIR /usr/src/client

COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

FROM rust:1.94-slim-bookworm AS build

WORKDIR /usr/src/app

COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
COPY server/migrations ./migrations
RUN cargo build --release --locked

# Plans de la ferme : modules/mapModule.js (non versionné) s'il existe,
# sinon la variable MAP_PLAN_URLS.
COPY server/ /tmp/server/
RUN mkdir -p modules && cp -r /tmp/server/modules/. modules/ 2>/dev/null || true

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY --from=build /usr/src/app/target/release/farm-server ./farm-server
COPY --from=build /usr/src/app/modules ./modules
COPY --from=client /usr/src/client/dist ../client/dist

EXPOSE 3000
CMD ["./farm-server"]
