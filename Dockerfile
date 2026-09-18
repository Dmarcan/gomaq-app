# Imagen de produccion de GOMAQ para Railway: backend (API) + panel web en un solo servicio.
#
# El panel (Flutter Web) se sirve como estatico desde el mismo backend (server.js), igual que en
# el servidor local, asi que la API y el panel comparten URL y no hace falta CORS. Antes el
# build del panel se copiaba a mano a backend/public, que esta en .gitignore: un despliegue
# desde el repositorio no tenia panel. Aca se compila en cada despliegue.

# ---------- Etapa 1: compilar el panel web ----------
FROM debian:bookworm-slim AS panel

# misma version de Flutter con que se desarrolla (flutter --version); fijarla evita que un
# despliegue compile con otra version y cambie el comportamiento sin que nadie lo note
ARG FLUTTER_VERSION=3.47.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl unzip xz-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${FLUTTER_VERSION} https://github.com/flutter/flutter.git /opt/flutter
ENV PATH="/opt/flutter/bin:${PATH}"
RUN flutter config --no-analytics --enable-web && flutter precache --web

WORKDIR /app/web
# primero solo las dependencias: si no cambian, Docker reutiliza esta capa
COPY web/pubspec.yaml web/pubspec.lock ./
RUN flutter pub get
COPY web/ ./
# URL vacia = rutas relativas: el panel llama a la API en su mismo origen
RUN flutter build web --release --dart-define=GOMAQ_API_URL=

# ---------- Etapa 2: backend ----------
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY --from=panel /app/web/build/web ./public
# esquema y migraciones: scripts/migrar.js los aplica antes de cada despliegue (railway.json)
COPY db/ /db/

# Railway entrega el puerto en PORT; server.js lo lee
CMD ["node", "server.js"]
