# GOMAQ

[![Tests](https://github.com/Dmarcan/gomaq-app/actions/workflows/tests.yml/badge.svg)](https://github.com/Dmarcan/gomaq-app/actions/workflows/tests.yml)

Sistema de gestión y comunicación centralizado para una empresa de arriendo de maquinaria. Digitaliza la
flota, las guías de despacho, las órdenes de trabajo (OT) de los mecánicos en terreno, el inventario de
repuestos, la facturación y los avisos a los clientes. Proyecto de título de Ingeniería Civil en Informática.

Lo usan cuatro perfiles: **gerente** y **administrativo** (panel de gestión), **mecánico** (app en terreno,
con o sin señal) y **cliente** (portal de seguimiento de sus equipos y órdenes).

## Arquitectura

```mermaid
flowchart LR
    P["Panel (Flutter web y Android)"] --> A
    T["App del mecánico (Flutter, Android, offline-first)"] --> A
    subgraph Railway
        A["gomaq-app: API Express + panel web"] --> DB[("PostgreSQL")]
        W["gomaq-worker: avisos"] --> DB
    end
    A --> S[("Supabase Storage")]
    W --> R["Resend (correo) / Firebase (push)"]
```

La API y el panel web comparten URL: el backend sirve el build de Flutter Web como estático. El worker envía
los avisos pendientes en un proceso aparte. Detalle y reglas de negocio en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).

## Requisitos

- Node.js 22 o superior y npm (`backend/package.json`, `engines`).
- PostgreSQL 17 (la versión del CI) y el cliente `psql`.
- Flutter 3.47.2 (versión fijada en el `Dockerfile` y en los workflows) para el panel y la app del mecánico.
- Para producción: cuentas de Railway y Supabase; opcionales Resend (correo), Firebase (push) y OpenRouteService.

## Inicio rápido local

Backend, con una base PostgreSQL vacía (ejemplo con Docker; cualquier PostgreSQL 17 sirve):

```bash
docker run --name gomaq-pg -e POSTGRES_USER=gomaq -e POSTGRES_PASSWORD=gomaq -e POSTGRES_DB=gomaq \
  -p 5432:5432 -d postgres:17

cd backend
cp .env.example .env      # y poner DATABASE_URL=postgres://gomaq:gomaq@localhost:5432/gomaq
npm ci
npm run migrar            # aplica db/schema.sql y db/migrations/ en orden
psql postgres://gomaq:gomaq@localhost:5432/gomaq -f ../db/scripts/semilla_pruebas.sql   # datos ficticios, solo local
npm start                 # http://localhost:3000, comprobación en /api/health
```

`SUPABASE_URL` y `SUPABASE_SERVICE_KEY` son obligatorias para arrancar; en local sirven valores ficticios si no
se prueba la subida de archivos. Panel y app del mecánico: ver [panel/README.md](panel/README.md) y
[terreno/README.md](terreno/README.md).

### Cuentas de prueba locales

La semilla crea estas cuentas, con la contraseña `PruebaGomaq123` (datos ficticios, solo para entorno local; la
semilla no debe correrse contra producción):

| Correo | Rol |
|---|---|
| `admin@gomaq.test` | gerente |
| `administrativo@gomaq.test` | administrativo |
| `mecanico@gomaq.test`, `mecanico2@gomaq.test` | mecánico |
| `cliente@gomaq.test` | cliente (empresa "Acsa International") |

Más usuarios: `node scripts/create-user.js <nombre> <email> <rol> [cliente_id]` (la contraseña se pide por
consola).

### Cuentas de demostración (deliberadas)

El script `backend/scripts/usuarios-demo.js` crea (o borra) tres usuarios de demostración (administrativo,
mecánico y cliente) y una empresa de prueba. Las contraseñas no están en el repositorio: se entregan por
variables de entorno al crear los usuarios.

```bash
cd backend
GOMAQ_DEMO_CLAVE_ADMINISTRATIVO=... GOMAQ_DEMO_CLAVE_MECANICO=... GOMAQ_DEMO_CLAVE_CLIENTE=...   node scripts/usuarios-demo.js crear     # mínimo 8 caracteres cada una; falla con un mensaje si falta alguna
node scripts/usuarios-demo.js borrar
```

El login del panel y de terreno no tiene botones de inicio rápido. Ver [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md), sección 7.

## Variables de entorno

Todas las que lee el código, con su propósito y si son obligatorias, están en
[backend/.env.example](backend/.env.example); la tabla por servicio, en [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md#2-variables-de-entorno).
Obligatorias de la API: `DATABASE_URL`, `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`. Los valores
reales nunca se versionan (`.env.*` está en `.gitignore`, salvo `.env.example`).

## Pruebas

```bash
# backend (con la API en marcha y la semilla cargada, como en el CI)
cd backend
GOMAQ_TEST_ESCRITURA=1 GOMAQ_TEST_URL=http://localhost:3000 npm test

# paquete compartido y panel (desde la raíz del repositorio)
flutter pub get --enforce-lockfile
(cd comun && dart analyze && dart test)
(cd panel && flutter analyze --no-fatal-infos && flutter test)

# app del mecánico
(cd terreno && flutter pub get --enforce-lockfile && flutter analyze --no-fatal-infos && flutter test)
```

Sin `GOMAQ_TEST_URL` las pruebas de extremo a extremo se omiten, y sin `GOMAQ_TEST_ESCRITURA=1` las de
escritura también; estas últimas crean y borran datos y solo corren contra una base local. El CI exige cero
pruebas omitidas. Estrategia y niveles en [backend/README.md](backend/README.md).

## Estructura del repositorio

```
backend/   API Express, worker de avisos, scripts de operación y pruebas (node:test)
panel/     Flutter: panel de administrativo y gerente, portal del cliente (web y Android)
terreno/   Flutter: app del mecánico, Android, offline-first (SQLite + cola de sincronización)
comun/     Paquete Dart compartido: cliente HTTP, formato es_CL
db/        schema.sql, migraciones numeradas, semilla de pruebas y datos de carga
docs/      MANUAL_USUARIO.md (uso por rol), ARQUITECTURA.md y DESPLIEGUE.md
.github/   Workflows de CI (tests.yml, mobile.yml)
.railway/  Infraestructura de Railway como código (railway.ts)
Dockerfile, Dockerfile.worker   Imágenes de gomaq-app (API + panel) y de gomaq-worker
```

`panel/` y `comun/` forman un workspace de Dart con un único `pubspec.lock` en la raíz; `terreno/` no es
miembro y conserva el suyo.

## Despliegue

Producción corre en Railway: `git push` a `main` dispara el CI y, si pasa, el despliegue; las migraciones se
aplican al arrancar. Detalle, variables y operación en [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md).

## Documentación

- [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md): diseño, roles, flujo de la OT, horómetro, costo por equipo, stock del furgón, cola offline, avisos.
- [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md): Railway, variables, migraciones, worker, APK, operación.
- [backend/README.md](backend/README.md), [panel/README.md](panel/README.md), [terreno/README.md](terreno/README.md), [comun/README.md](comun/README.md), [db/README.md](db/README.md).

## Licencia

Sin definir (proyecto académico).
