# Despliegue y operación

Cómo corre GOMAQ en producción (Railway), qué variables necesita cada servicio, cómo se aplican las
migraciones y cómo se genera y se mantiene el APK. El diseño está en [ARQUITECTURA.md](ARQUITECTURA.md).

## 1. Infraestructura en Railway

Proyecto `gomaq` con tres recursos más el volumen de la base. La configuración está en código en
[`.railway/railway.ts`](../.railway/railway.ts) (ver [`.railway/README.md`](../.railway/README.md)).

| Recurso | Qué es | Imagen y arranque |
|---|---|---|
| `gomaq-app` | API Express y panel web estático, misma URL | `Dockerfile` de la raíz; `node scripts/migrar.js && exec node server.js` |
| `gomaq-worker` | Envío de avisos pendientes; sin HTTP, sin dominio, sin healthcheck | `Dockerfile.worker` (solo Node); `node scripts/worker.js`, reinicio siempre |
| `Postgres` | Base de datos | Servicio de Railway; `DATABASE_URL` se inyecta como referencia, sin copiar credenciales |

- **URL pública** (API y panel): <https://gomaq-app-production.up.railway.app>. `/api/*` es la API y `/` el panel.
- **`gomaq-app`:** el `Dockerfile` compila el panel con Flutter 3.47.2 (misma versión que el CI) en una etapa y
  arma el backend con Node 22 en otra; corre como usuario `node`. Railway comprueba `GET /api/health` (plazo de
  120 s) antes de dar por bueno un despliegue y reinicia ante fallos hasta 5 veces.
- **`gomaq-worker`:** no migra la base (lo hace la API). Se redespliega solo si cambian `backend/`, `db/` o
  `Dockerfile.worker`. Arranca con `node` directo, sin `npm`, para recibir SIGTERM y cerrar el lote en curso.
- **Reposo (`sleepApplication`):** activo en `gomaq-app` y en `Postgres`. El worker consulta la base cada 15 s,
  así que la mantiene despierta; conviene revisar el costo en el panel de uso de Railway.
- **Archivos:** Supabase Storage, en buckets privados con URLs firmadas (ver ARQUITECTURA.md, sección 2).

### Configuración como código

```bash
railway config plan     # muestra qué cambiaría en Railway (no modifica nada)
railway config apply    # aplica, pidiendo confirmación
```

Los secretos no están en el archivo: se declaran con `preserve()`, que conserva el valor ya cargado en
Railway. Declarar en `railway.ts` toda variable que exista en el servicio, o un `apply` la borraría. Necesita
el paquete npm `railway` instalado junto al archivo. En Windows, correr desde PowerShell con `$env:_`
apuntando al `railway.exe` de `node_modules/@railway/cli/bin/` de la carpeta global de npm
(`npm root -g`), porque el SDK ejecuta `railway --version` y no puede lanzar el `.cmd`.

### Logs y métricas

```bash
railway logs --service gomaq-app            # o gomaq-worker; --build para el build
railway metrics --service gomaq-app
railway variable list --service gomaq-app   # nombres y valores de las variables (no compartir la salida)
railway open
```

## 2. Variables de entorno

Referencia completa con comentarios: [`backend/.env.example`](../backend/.env.example). En local se leen de
`backend/.env`; en Railway, de las variables de cada servicio.

Dónde va cada una (columnas según `.railway/railway.ts` y el código; "—" = no aplica):

| Variable | Obligatoria | `gomaq-app` | `gomaq-worker` | Para qué |
|---|---|---|---|---|
| `DATABASE_URL` | sí (API y worker) | sí | sí | Conexión a PostgreSQL |
| `JWT_SECRET` | sí (API) | sí | — | Secreto de sesión; en producción mínimo 32 caracteres |
| `SUPABASE_URL` | sí (API) | sí | sí | Proyecto de Supabase Storage |
| `SUPABASE_SERVICE_KEY` | sí (API) | sí | sí | Clave de servicio de Supabase (secreto) |
| `TRUST_PROXY` | recomendada en Railway | `1` | — | Saltos de proxy para el límite de login |
| `NOTIFICACIONES_EN_PROCESO` | no | `0` | — | Evita que la API arranque su propio worker |
| `RESEND_API_KEY` | para correos | sí | sí | Envío de correo (Resend) |
| `CORREO_REMITENTE` | para correos | sí | sí | Remitente del correo |
| `CORREO_CONTACTO` | no | sí | sí | `reply_to` del correo de factura |
| `PUSH_HABILITADO` | no | `1` para activar push | — | Portón que permite encolar push |
| `FCM_CUENTA_SERVICIO` | para push | — | sí | Cuenta de servicio de Firebase (JSON en base64; secreto) |
| `ORS_API_KEY` | no | sí | — | Hora estimada de llegada y buscador de direcciones |
| `FIREBASE_API_KEY`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_PROJECT_ID`, `FIREBASE_VAPID_KEY` | no | sí (argumentos de build del panel web) | — | Configuración pública de Firebase; no las lee el backend |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | no | — | sí | Gracia al detener el worker (plataforma) |

Opcionales que no están declaradas en Railway y tienen valor por defecto: `PORT`, `NODE_ENV` (los Dockerfile
lo fijan en `production`), `FORZAR_HTTPS`, `CORS_ORIGENES`, `PANEL_URL`, `DATABASE_URL_MIGRACION`,
`DB_CONNECT_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_TX_TIMEOUT_MS`, `SESIONES_EN_BASE`,
`SUPABASE_BUCKET`, `SUPABASE_BUCKET_DOCUMENTOS`, `SUPABASE_BUCKET_EQUIPOS`, `SUPABASE_TIMEOUT_MS`,
`NOTIF_LOTE`, `NOTIF_TIMEOUT_MS`, `NOTIF_TIMEOUT_FOTOS_MS`, `RETENCION_ACTIVA`, `ORS_BASE_URL`,
`PELIAS_BASE_URL`. Si se usa alguna en Railway, declararla también en `railway.ts`.

`RAILWAY_ENVIRONMENT_NAME` y `RAILWAY_PUBLIC_DOMAIN` las define la plataforma.

Reglas:

- Los valores reales (contraseña de la base, `JWT_SECRET`, claves de Supabase, Resend y Firebase) viven solo en
  las variables de Railway o en el `.env` local, que está en `.gitignore`. No van al repositorio ni a ningún
  chat o ticket.
- La API y el worker comparten código, pero solo la API exige `JWT_SECRET`; el worker solo exige `DATABASE_URL`
  (`backend/scripts/worker.js`).
- El correo de invitación y de recuperar contraseña sale desde la API, no desde el worker; por eso la API
  también lleva `RESEND_API_KEY`, `CORREO_REMITENTE` y `CORREO_CONTACTO`.

## 3. Migraciones de la base de datos

`db/schema.sql` y `db/migrations/NNN_*.sql` los aplica `backend/scripts/migrar.js` (`npm run migrar`), en
orden y una sola vez cada uno, y registra lo aplicado en la tabla `schema_migraciones`.

- **Producción:** corre sola al arrancar el contenedor de `gomaq-app`, antes del servidor. Para agregar una
  migración basta con crear el archivo siguiente en `db/migrations/`.
- Un candado (`pg_advisory_lock`) evita que dos instancias migren a la vez.
- Cada migración corre en su propia transacción: si falla, no queda aplicada a medias y el despliegue se
  detiene sin reemplazar la versión anterior (el chequeo de `/api/health` falla y Railway conserva la anterior).
- Una base creada a mano, sin registro, no se toca: el script no puede saber qué migraciones tiene. Se marca
  primero con `node scripts/migrar.js --marcar-hasta 016`.
- `node scripts/migrar.js --hasta 042` aplica solo hasta esa versión (lo usa
  `scripts/probar_migraciones_con_datos.js`, que en el CI comprueba que una migración nueva también aplica
  sobre una base con filas).
- Los scripts de operación usan `DATABASE_URL_MIGRACION` (rol dueño del esquema) si existe, y si no
  `DATABASE_URL`. La migración 041 crea el rol limitado `gomaq_app` sin login: para usarlo hay que darle clave
  y cambiar `DATABASE_URL` de `gomaq-app` y `gomaq-worker`, dejando el dueño en `DATABASE_URL_MIGRACION`.

## 4. Cómo desplegar un cambio

Backend y panel web van juntos en `gomaq-app`: basta con `git push` a `main`.

1. GitHub Actions (`.github/workflows/tests.yml`) corre las pruebas del backend sobre un Postgres 17 temporal
   (reglas de negocio, escritura y extremo a extremo contra el servidor levantado en el mismo job), aplica las
   migraciones con el mismo script que Railway, y analiza y prueba `comun/` y `panel/`. Una migración que no
   aplica sobre una base vacía falla aquí. La app del mecánico tiene su propio workflow (`mobile.yml`), que
   corre cuando cambian `terreno/` o `comun/`.
2. Railway está conectado al repositorio con "Wait for CI": despliega el commit solo si pasa.
3. Al arrancar se aplican las migraciones pendientes y la versión anterior se reemplaza solo si
   `/api/health` responde.

El worker se redespliega solo si cambian `backend/`, `db/` o `Dockerfile.worker`, también tras el CI.

Despliegue de emergencia, sin pasar por GitHub: `railway up --service gomaq-app` desde la raíz del repositorio.

### Cambios que tocan la cola offline

Desplegar primero el backend y después el APK (ver ARQUITECTURA.md, sección 7).

## 5. Avisos push: activación y vuelta atrás

1. Desplegar el worker con el canal push.
2. Cargar `FCM_CUENTA_SERVICIO` en `gomaq-worker` (JSON de la cuenta de servicio en base64).
3. Recién entonces poner `PUSH_HABILITADO=1` en `gomaq-app`. Un worker antiguo marcaría los push como error
   permanente.

Apagar `PUSH_HABILITADO` es la vuelta atrás: la API deja de encolar. Sin `FCM_CUENTA_SERVICIO` los avisos
quedan esperando 1 h sin gastar intentos. Las apps necesitan además la configuración de Firebase en el build
(sección 6).

## 6. Compilar los clientes

### APK de la app del mecánico

Apunta por defecto al servidor de Railway (`urlServidorProduccion` en `comun/lib/cliente_api.dart`). Con push:

```bash
cd terreno
flutter build apk --release \
  --dart-define=FIREBASE_API_KEY=... --dart-define=FIREBASE_APP_ID=... \
  --dart-define=FIREBASE_MESSAGING_SENDER_ID=... --dart-define=FIREBASE_PROJECT_ID=...
```

Si falta cualquiera de las cuatro variables, no hay push: no se inicializa Firebase y la app funciona igual.
Son datos públicos (la clave se protege restringiéndola al paquete `cl.gomaq.gomaq_mecanico` en Google Cloud).
Para desarrollar contra un backend local: `flutter run --dart-define=GOMAQ_API_URL=http://10.0.2.2:3000`
(10.0.2.2 es el equipo anfitrión visto desde el emulador de Android).

Instalación en un teléfono: por USB o depuración inalámbrica (`adb pair` y `adb connect`) con `flutter install`
o `adb install`. En teléfonos con MIUI, si falla con `INSTALL_FAILED_USER_RESTRICTED`, activar "Instalar vía
USB" en Opciones de desarrollador. Antes de actualizar un APK, el teléfono debe sincronizar hasta ver "Todo
enviado": desinstalar borra la cola pendiente.

**Firma:** el release se firma hoy con la clave de depuración (`terreno/android/app/build.gradle.kts`). Sirve
para instalar a mano; para distribuir hay que generar un keystore propio. Los `*.jks`, `*.keystore` y
`key.properties` están en `.gitignore`.

### Panel

- **Web:** lo compila el `Dockerfile` en cada despliegue (`flutter build web --release`, con
  `GOMAQ_API_URL` vacío para llamar a la API en el mismo origen). Las cinco variables `FIREBASE_*` llegan como
  argumentos de build desde las variables de `gomaq-app`; si falta alguna, el push web queda apagado y el
  panel funciona igual.
- **Android** (`cl.gomaq.gomaq_panel`): `cd panel && flutter build apk --release` (mismas claves de Firebase
  por `--dart-define`, con el `FIREBASE_APP_ID` de la app de Android; la web y el APK son apps distintas en
  Firebase). Misma nota de firma que terreno.

## 7. Operación con la base de producción

La base de Railway no tiene acceso público: los scripts se corren dentro del contenedor.

```bash
railway ssh --service gomaq-app -- node scripts/cargar_clientes.js --simular   # y sin --simular para cargar
railway ssh --service gomaq-app -- node scripts/cargar_equipos.js --simular
railway ssh --service gomaq-app -- node scripts/cargar_demo.js --simular
railway ssh --service gomaq-app -- node scripts/retencion.js                   # simulación; --ejecutar borra
```

Todos aceptan `--simular` (cargas) y son idempotentes. Detalle de cada uno en el encabezado del script.

### Cuentas de demostración

Existen cuentas de demostración deliberadas, con botones de inicio rápido en el login del panel y de terreno
(ver [ARQUITECTURA.md](ARQUITECTURA.md), sección 12). Antes de usar datos reales:

```bash
railway ssh --service gomaq-worker "node scripts/usuarios-demo.js borrar"
```

### Datos de prueba

`db/scripts/limpiar_datos_prueba.sql` borra datos de prueba por identificadores fijos (por ejemplo folios de
factura concretos). No correrlo contra una base con datos reales sin leerlo antes.

## 8. Reglas de operación

- **Observar el worker:** el atajo "Avisos con problemas" del dashboard cuenta avisos con error y pendientes
  vencidos hace más de 10 minutos. Al agregar un proveedor, sumar sus claves a `VARIABLES_REQUERIDAS` de
  `backend/scripts/worker.js` y a las variables de `gomaq-worker`.
- **Retención de datos personales:** activar `RETENCION_ACTIVA=1` en el worker cuando corresponda
  (ARQUITECTURA.md, sección 11).
- **Dominio de correo:** el remitente debe pertenecer a un dominio verificado en Resend (registros DNS
  cargados); mientras tanto el correo solo sale en modo de pruebas.
- **Dominio propio:** se agrega con `railway domain`, sin cambios de código.
