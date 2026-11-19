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

# panel/ y comun/ forman un workspace de Dart: el pubspec.lock es unico y vive en la raiz (el de
# panel/ ya no existe). terreno/ no es miembro y no entra a la imagen.
WORKDIR /app
# primero solo los pubspec: si no cambian, Docker reutiliza la capa de dependencias.
# --enforce-lockfile hace fallar el build si el lock no coincide con los pubspec, en vez de
# resolver versiones nuevas sin que nadie lo note
COPY pubspec.yaml pubspec.lock ./
COPY comun/pubspec.yaml comun/
COPY panel/pubspec.yaml panel/
RUN flutter pub get --enforce-lockfile
COPY comun/ comun/
COPY panel/ panel/
WORKDIR /app/panel
# Configuracion publica de Firebase para el push web (no son secretos: viajan dentro del JS del panel). Railway
# pasa las variables del servicio gomaq-app como argumentos de build; si falta alguna, el push web queda apagado
# y el panel funciona igual (ver panel/lib/services/push_config.dart).
ARG FIREBASE_API_KEY=
ARG FIREBASE_APP_ID=
ARG FIREBASE_MESSAGING_SENDER_ID=
ARG FIREBASE_PROJECT_ID=
ARG FIREBASE_VAPID_KEY=
# URL vacia = rutas relativas: el panel llama a la API en su mismo origen
RUN flutter build web --release --dart-define=GOMAQ_API_URL=     --dart-define=FIREBASE_API_KEY=${FIREBASE_API_KEY}     --dart-define=FIREBASE_APP_ID=${FIREBASE_APP_ID}     --dart-define=FIREBASE_MESSAGING_SENDER_ID=${FIREBASE_MESSAGING_SENDER_ID}     --dart-define=FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID}     --dart-define=FIREBASE_VAPID_KEY=${FIREBASE_VAPID_KEY}

# ---------- Etapa 2: backend ----------
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/ ./
COPY --from=panel /app/panel/build/web ./public
# esquema y migraciones: scripts/migrar.js los aplica al arrancar (ver CMD)
COPY db/ /db/

# no correr como root: nada escribe en disco (las subidas van en memoria a Supabase)
USER node

# Primero las migraciones pendientes y despues el servidor (que lee el puerto de PORT). Se hace
# al arrancar y no con el preDeployCommand de Railway, que en el primer despliegue no se aplico:
# asi la base queda al dia en cualquier plataforma. Si una migracion falla, el servidor no
# arranca, el chequeo de /api/health falla y Railway mantiene la version anterior.
CMD ["sh", "-c", "node scripts/migrar.js && exec node server.js"]
