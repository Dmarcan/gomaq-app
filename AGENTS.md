# GOMAQ

Sistema de Gestión y Comunicación Centralizado para una empresa de arriendo de maquinarias (proyecto de título, Ing. Civil en Informática). El README.md tiene el detalle completo del estado del proyecto; este archivo es la versión corta. Las decisiones de arquitectura del front-end y su historia están en `docs/tecnica/PLAN_ARQUITECTURA_FRONTEND.md`.

## Stack
- **Backend** (`backend/`): Node >= 22, Express 4, PostgreSQL (`pg`), JWT + bcryptjs, helmet, multer, pdf-parse. Archivos pesados en Supabase Storage (buckets privados, URLs firmadas de 1 h).
- **Panel** (`panel/`, paquete `gomaq_web`): Flutter multiplataforma, compila a **web** y a **Android** con el mismo código (provider, go_router, fl_chart). Lo usan administrativo, gerente y cliente (portal del cliente en `/portal`). `applicationId` Android: `cl.gomaq.gomaq_panel`.
- **App del mecánico** (`terreno/`, paquete `gomaq_mecanico`): Flutter **solo Android**, offline-first (SQLite local + cola de sincronización). `applicationId`: `cl.gomaq.gomaq_mecanico`. Es un proyecto aparte a propósito: se instala a mano en cada teléfono, conviven versiones antiguas con tareas por sincronizar, y el almacenamiento del navegador no es confiable para trabajar sin conexión.
- **Código compartido** (`comun/`, paquete `gomaq_comun`): Dart puro, sin plugins de Flutter. Tiene `ClienteApi` / `ApiException` (cliente HTTP del backend) y `Formato` (fechas y montos en es_CL). El panel y terreno lo usan; cada app conserva su propio `services/api_client.dart` con lo suyo (dónde guarda el token, timeouts, aviso de sesión vencida).
- **Infra**: Railway, dos servicios más Postgres, todos en el mismo proyecto. `gomaq-app` (Dockerfile en la raíz: compila el panel con Flutter 3.47.2 y lo sirve como estático desde el backend, misma URL para API y panel). `gomaq-worker` (`Dockerfile.worker`, `node scripts/worker.js`): envía las notificaciones pendientes, sin HTTP; la API lleva `NOTIFICACIONES_EN_PROCESO=0` para no correr su propio worker (sin esa variable, en local y CI, corre dentro de la API). La configuración de Railway vive en `.railway/railway.ts` (no hay `railway.json`).

## Estructura
- `backend/server.js`, `src/routes/` (una por recurso), `src/middleware/`, `src/utils/` (reglas de negocio puras), `src/workers/`, `scripts/` (migrar, create-user, cargar_equipos), `test/`
- `db/schema.sql`, `db/migrations/NNN_*.sql`, `db/datos/`
- `comun/lib/` (`cliente_api.dart`, `formato.dart`) y `comun/test/`
- `panel/lib/`: `main.dart`, `router.dart`, `screens/{acceso,cliente,panel}/` (login y registro; portal del cliente; administrativo y gerente), `services/`, `widgets/`, `theme/`, `utils/`. Plataformas: `panel/android/` y `panel/web/`.
- `terreno/lib/`: `screens/`, `services/` (incluye `sync_service.dart`, la cola offline), `widgets/`, `theme/`, `utils/`. Plataforma: solo `terreno/android/` (se borraron las carpetas por defecto de iOS, Linux, macOS, Windows y web; si algún día hiciera falta una, `flutter create --platforms=<x> .`).
- Workspace de Dart: `pubspec.yaml` y `pubspec.lock` en la raíz, con miembros `[comun, panel]`. **`terreno/` no es miembro**: depende de `comun` por `path` y conserva su propio `pubspec.lock`, para que un cambio de dependencias del panel no altere el APK del mecánico.
- `docs/`, toda la documentación en una sola carpeta (no tocar `informe/`, `presentaciones/` ni `referencias/` sin que se pida):
  - `informe/` (informe de seminario y de avance, `PENDIENTES.md`, `figuras/` y `versiones/` con las copias de respaldo)
  - `presentaciones/` (presentaciones de avance y final, guion; `versiones/` con la anterior)
  - `referencias/` (reglamento, formato de informes, rúbricas)
  - `entrevistas/`, `capturas/` y `tecnica/` (plan de arquitectura del front-end y auditoría de seguridad)
- `.github/workflows/`: `tests.yml` (jobs `backend` y `panel`) y `mobile.yml` (app terreno; conserva el nombre antiguo para no alterar los checks).

## Cómo correrlo
```bash
cd backend && npm ci
cp .env.example .env        # completar DATABASE_URL, JWT_SECRET, SUPABASE_*
npm run migrar              # aplica db/schema.sql y migraciones pendientes
npm run dev                 # API en PORT (3000 por defecto)

flutter pub get             # en la raíz: resuelve comun/ y panel/ (lock único)
cd panel && flutter run -d chrome --dart-define=GOMAQ_API_URL=http://localhost:3000
cd terreno && flutter pub get && flutter run --dart-define=GOMAQ_API_URL=http://10.0.2.2:3000
```
APK de producción: `cd panel && flutter build apk --release` o `cd terreno && flutter build apk --release` (ambos apuntan por defecto al servidor de Railway; `--dart-define=GOMAQ_API_URL=...` para otro). Los builds de **depuración** permiten HTTP al backend local (`10.0.2.2` desde el emulador); los de release exigen HTTPS.

## Tests
- Backend: `cd backend && npm test` (node:test, sin dependencias extra). Los niveles de escritura y extremo a extremo necesitan Postgres, `GOMAQ_TEST_ESCRITURA=1` y el backend levantado con `GOMAQ_TEST_URL=http://localhost:3000` (ver `.github/workflows/tests.yml`).
- Compartido: `cd comun && dart analyze && dart test`.
- Flutter: `flutter test` y `flutter analyze` dentro de `panel/` o `terreno/`. El CI usa `flutter analyze --no-fatal-infos` (quedan avisos de nivel info conocidos).

## Despliegue
`git push` a `main` -> GitHub Actions corre los tests (backend, panel y, si cambió, terreno) -> Railway despliega solo si todos los workflows pasan -> al arrancar corre `node scripts/migrar.js` y luego el servidor; se reemplaza la versión anterior solo si `/api/health` responde. Emergencia: `railway up --service gomaq-app`. El worker se redespliega solo si cambia `backend/`, `db/` o `Dockerfile.worker`; para forzarlo: `railway redeploy --service gomaq-worker --from-source`.
Cambios en Railway (servicios, variables de build, healthcheck): editar `.railway/railway.ts` y correr `railway config plan` y luego `apply`. En Windows, desde PowerShell con `$env:_` apuntando al `railway.exe` que está en `node_modules/@railway/cli/bin/` dentro de la carpeta global de npm (`npm root -g`) y el paquete npm `railway` instalado junto al archivo (README, sección Infraestructura).
Si un cambio toca la cola offline: primero backend, después APK. Los APK no se despliegan solos: se instalan a mano.
El Dockerfile usa `flutter pub get --enforce-lockfile` sobre el workspace: el `pubspec.lock` de la raíz debe ir siempre commiteado y al día con los `pubspec.yaml`, o el build falla. La versión de Flutter (3.47.2) está fijada en el Dockerfile y en los workflows; si se cambia, cambiarla en los tres.

## Reglas importantes
- Migraciones: solo agregar el siguiente `db/migrations/NNN_*.sql`. Nunca editar una ya aplicada. Cada una corre en su transacción.
- Nunca commitear `.env`, claves de Supabase ni `JWT_SECRET`. No pedirlas por chat: David las escribe en `.env` o en las variables de Railway. Tampoco commitear `*.jks`, `*.keystore` ni `key.properties` (están en `.gitignore`).
- Archivos siempre a Supabase con URLs firmadas; nunca URLs públicas permanentes ni guardar en `backend/uploads/` en producción.
- Dinero: montos en pesos chilenos enteros; cuidado al parsear montos (hubo errores al leerlos).
- Facturable: la fuente de verdad son las líneas de repuesto; el campo de la OT lo recalcula el backend (`utils/facturableOt.js`). Sin repuestos no se cobra.
- Cola offline: cada tarea lleva `uuid_cliente` para que los reintentos no dupliquen (`utils/idempotencia.js`). No romper esa garantía. Una tarea sin orden de trabajo (lectura de horómetro de un equipo desde Flota) va con `orden_trabajo_id = 0`. La base local del teléfono está en la versión 9 (`terreno/lib/db/local_database.dart`): un cambio de esquema es siempre un `ALTER TABLE` en `onUpgrade` y en `onCreate`, nunca recrear tablas con datos del mecánico.
- Estados de la OT (`utils/estadosOt.js`): pendiente → asignada → aceptada → en_camino → en_terreno ↔ en_reparacion → finalizada. Un cambio ya aplicado o atrasado responde 200 sin retroceder (es lo normal en la cola offline). Una guía puede crearse sin PDF (`sin_documento`) y adjuntarse después; sigue siendo el único evento que asigna o libera un equipo.
- `ClienteApi` (en `comun/`) deja pasar sin envolver `SocketException`, `TimeoutException` y `ClientException`: `terreno/lib/services/sync_service.dart` clasifica por esos tipos (sin red no gasta reintentos). Hay una sola `ApiException`, la de `comun`. Si se toca el cliente, `comun/test/cliente_api_test.dart` debe seguir pasando.
- Las subidas multipart deben declarar el tipo del archivo: el backend filtra por el `mimetype` (PDF o imagen). `ClienteApi` lo deduce de la extensión y los primeros bytes; no crear `MultipartFile` a mano sin `contentType`.
- Los timeouts son de cada app: panel 15 s (30 s en subidas), terreno 12 s. No dejar que terreno herede los del panel.
- El panel debe compilar también a Android: nada de `dart:html` ni de librerías solo-web fuera de los paquetes que ya las encapsulan (para abrir enlaces usar `utils/enlaces.dart`). Las pantallas del panel deben verse bien desde 375 px de ancho (bajo 600 px los bloques se apilan).
- Las reglas de negocio van en `src/utils/` con test en `backend/test/`; las rutas solo orquestan.
- Worker de notificaciones: lote chico y timeout por envío (el plazo de toma debe cubrir el peor caso del lote, ver `plazoTomaSegundos`). Al conectar el proveedor real, pasar `signal` a `fetch` y lanzar un error con `reintentarEnSegundos` ante un 429. Las migraciones que toquen `notificaciones_pendientes` deben agregar sin quitar: el worker puede correr un momento con el esquema anterior.
- Un cambio en el backend debe pasar `npm test` antes de push, porque un CI rojo bloquea el despliegue.
- Textos de UI y comentarios en español, sin emojis.

## Deuda conocida
- `file_picker` está en la serie 10.x a propósito: la 11.x no compila el código Kotlin del plugin con `android.builtInKotlin=false`, y la 12.x o más exige `win32` 6, que obliga a subir `flutter_secure_storage` (guarda la sesión) a 10 o más. Para subir de versión hay que cambiar las dos cosas y probar la sesión y las subidas.
- El APK de terreno se firma hoy con la clave de **depuración**. Pasar a una clave de producción obliga a desinstalar la app en cada teléfono, y desinstalar borra la cola de sincronización pendiente: antes hay que sincronizar hasta dejarla en 0.
- En Windows, renombrar carpetas del proyecto falla si hay demonios de Gradle o Kotlin abiertos (`gradlew --stop`).
