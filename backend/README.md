# backend

API REST de GOMAQ (Node.js 22, Express 4, PostgreSQL) y worker de avisos. También sirve el build web del
panel desde `public/` (generado en la imagen Docker; no está en git). Arquitectura y reglas de negocio:
[../docs/ARQUITECTURA.md](../docs/ARQUITECTURA.md).

## Ejecutar

Requiere una base PostgreSQL (inicio rápido completo en el [README raíz](../README.md)).

```bash
cp .env.example .env     # completar DATABASE_URL, JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
npm ci
npm run migrar           # esquema y migraciones pendientes
npm start                # node server.js, puerto 3000 por defecto
npm run dev              # igual, con recarga (node --watch)
node scripts/worker.js   # worker de avisos como proceso aparte (ver abajo)
```

Variables de entorno: todas documentadas en [.env.example](.env.example).

Sin `NOTIFICACIONES_EN_PROCESO=0`, la API arranca su propio worker de avisos; así corre en local y en el CI.
En producción corre aparte (`scripts/worker.js`, servicio `gomaq-worker`).

## Pruebas

`npm test` (`node --test --test-concurrency=1 --test-timeout=60000`, sin framework adicional). Niveles:

| Nivel | Qué cubre | Requisitos |
|---|---|---|
| Reglas de negocio y autorización | Funciones puras de `src/utils` y `verifyToken`/`requireRole` | Ninguno |
| Escritura | Rutas montadas en memoria: cola offline sin duplicados, anulación de líneas, transiciones de la OT, facturación | `GOMAQ_TEST_ESCRITURA=1` y una base local con el esquema y la semilla; crean y borran sus propios datos |
| Extremo a extremo | Contrato de la API, control por rol, pertenencia del recurso | `GOMAQ_TEST_URL=http://localhost:3000` con la API en marcha y la semilla cargada; sin ella se omiten |

Las pruebas con base se niegan a correr si `DATABASE_URL` no apunta a localhost (`test/_entornoPruebas.js`;
`GOMAQ_TEST_HOST_PERMITIDO` declara una excepción) y nunca llaman a servicios externos reales. El CI
(`.github/workflows/tests.yml`) corre todo contra un Postgres 17 temporal, prueba las migraciones sobre una
base con filas (`scripts/probar_migraciones_con_datos.js`) y falla si alguna prueba queda omitida. Los
textos de guías y facturas usados como fixture (`test/fixtures`) vienen de documentos reales con los terceros
anonimizados.

## Estructura

```
server.js            Arranque: valida variables, helmet/CORS, monta rutas, sirve public/, /api/health
src/config/          Pool de PostgreSQL (db.js) y cliente de Supabase (supabase.js)
src/middleware/      auth (verifyToken, requireRole), límites de intentos, subidas, errores
src/routes/          Un archivo por recurso, montado en /api/<recurso>
src/services/        Integraciones: Resend, FCM, OpenRouteService, geocodificador, sesiones, códigos de cuenta
src/utils/           Reglas de negocio puras (estados de la OT, mantención, facturable, stock, cobranza, ETA...)
src/workers/         Worker de notificaciones (patrón outbox)
src/assets/correo/   Logo incrustado en el correo de factura
scripts/             Operación: migrar, worker, create-user, cargas, retención, usuarios de demostración
test/                Pruebas node:test; test/fixtures con texto de documentos reales anonimizados
```

## Scripts de operación

Cada uno documenta su uso en el encabezado. En Railway se corren dentro del contenedor con
`railway ssh --service gomaq-app -- node scripts/<script>.js` (ver [../docs/DESPLIEGUE.md](../docs/DESPLIEGUE.md)).

| Script | Para qué |
|---|---|
| `migrar.js` | Aplica `db/schema.sql` y las migraciones pendientes (`--hasta N`, `--marcar-hasta N`) |
| `worker.js` | Proceso del worker de avisos |
| `create-user.js` | Crea un usuario; la contraseña se pide por consola |
| `cargar_clientes.js`, `cargar_equipos.js` | Cargas iniciales de clientes y equipos desde `db/datos/` (`--simular` no guarda) |
| `cargar_demo.js` | Datos de demostración marcados `[DEMO]` (`--borrar` los quita) |
| `usuarios-demo.js` | `crear` o `borrar` las cuentas de demostración |
| `retencion.js` | Borra datos personales vencidos (simulación salvo `--ejecutar`) |
| `probar_migraciones_con_datos.js` | Prueba migraciones sobre una base con filas (CI) |

## Convenciones

- CommonJS, 4 espacios de sangría, comentarios y mensajes en español.
- Autorización por ruta con `requireRole(...)`; los parámetros de ruta se validan con
  `src/utils/validacion.js`. Los handlers async se envuelven con `src/utils/asyncErrores.js`.
- Las reglas de negocio van en `src/utils/` como funciones puras, con su prueba; las rutas orquestan.
- Una operación que modifica varias tablas corre en una sola transacción.
- Las escrituras que la app del mecánico puede reintentar son idempotentes por `uuid_cliente`.
- Nada de secretos en el código: todo por variable de entorno.
