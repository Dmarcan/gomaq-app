# GOMAQ

[![Tests](https://github.com/Dmarcan/gomaq/actions/workflows/tests.yml/badge.svg)](https://github.com/Dmarcan/gomaq/actions/workflows/tests.yml)

Sistema de Gestión y Comunicación Centralizado para una empresa de arriendo de maquinarias (contexto: seminario/proyecto de título, Ingeniería Civil en Informática). Este README describe el estado real del proyecto para que cualquier conversación nueva (con Claude o cualquier otra persona) pueda retomarlo sin contexto previo.

## Qué es esto

Un sistema con 3 aplicaciones que comparten un mismo backend:

- **Backend** (`backend/`) — API REST en Node.js + Express + PostgreSQL
- **App del Mecánico** (`terreno/`) — Flutter, Android, **offline-first** (SQLite local + cola de sincronización)
- **Panel** (`panel/`) — Flutter, web y Android, con vistas distintas por rol: Administrativo/Gerente (panel de gestión) y Cliente (portal de seguimiento)

## Infraestructura actual: Railway

Desde septiembre de 2026 el sistema corre en [Railway](https://railway.com), proyecto `gomaq`. Antes corría en un Dell OptiPlex GX520 en la oficina, detrás de un Quick Tunnel de Cloudflare cuya URL cambiaba en cada reinicio.

- **URL pública (API y panel web):** https://gomaq-app-production.up.railway.app, con HTTPS. La misma URL sirve la API (`/api/*`) y el panel (`/`), porque el build de Flutter Web se sirve como estático desde el backend Node.
- **Servicio `gomaq-app`:** se construye con el `Dockerfile` de la raíz, que compila el panel con Flutter 3.47.2 y arma el backend con Node 22. Al arrancar, el contenedor corre `node scripts/migrar.js` y después el servidor; Railway revisa `/api/health` antes de dar el despliegue por bueno.
- **Servicio `gomaq-worker`:** envía las notificaciones pendientes (patrón Outbox sobre `notificaciones_pendientes`). Misma base de código, pero se construye con `Dockerfile.worker` (solo Node, sin Flutter) y arranca `node scripts/worker.js`: sin HTTP, sin dominio, sin healthcheck, reinicio siempre. No migra la base (eso lo hace la API). Se separó para que un despliegue del panel o de la API no corte envíos a medias, y para que un proveedor lento o con límite de uso no comparta proceso con las peticiones de los usuarios. La API lleva `NOTIFICACIONES_EN_PROCESO=0` para no arrancar su propio worker; sin esa variable (desarrollo local y CI) el worker corre dentro de la API. Si por error corrieran los dos, `FOR UPDATE SKIP LOCKED` evita que un aviso salga dos veces. Ajustes por variable: `NOTIF_LOTE` (5) y `NOTIF_TIMEOUT_MS` (15000). Un límite del proveedor (429) se reprograma con su `Retry-After` sin gastar intentos (error con `reintentarEnSegundos`, ver `src/utils/reintentosNotificacion.js`).
- **Avisos push (FCM, solo backend por ahora):** el canal `push` de `notificaciones_pendientes` lleva una fila por dispositivo (`dispositivos_push`, migración 048; la app los registra en `POST /api/dispositivos` y los da de baja en `DELETE /api/dispositivos`; el logout desactiva los de la sesión). Tipos y destinatarios (`DESTINOS_PUSH` en `src/utils/push.js`; cada uno va a un dispositivo activo de una app y de un rol, y el worker lo revalida antes de enviar, así un teléfono de terreno nunca recibe avisos de gerencia ni del cliente, ni el panel los del mecánico): **mecánico** (app terreno): `ot_asignada`, `ot_reasignada` y `ot_disponible` (OT nueva sin técnico, a los mecánicos activos que no tengan una OT aceptada, en camino, en terreno o en reparación); **gerente** (app panel): `factura_anulada` y `ajuste_inventario` (por pérdida o merma), sin avisar a quien ejecuta la acción; **gerente y administrativo** (app panel): `ot_por_valorizar`, `asistencia_nueva` (un cliente pidió asistencia; solo "OT #id, equipo código", sin el texto ni la gravedad) y `mantencion_proxima` (solo a quienes tienen encendido el aviso de mantención); **cliente** (app panel): `mecanico_asignado` y `ot_finalizada`, solo a los usuarios con cuenta de cliente de la empresa de la orden (nunca de otra) y solo con "Tu equipo tiene técnico asignado" / "Tu orden de trabajo finalizó" y "OT #id, equipo código": el nombre, RUT y vehículo del mecánico, la observación final, coordenadas y hora de llegada no salen por push. El correo y el WhatsApp de estos avisos ya no se encolan (no tienen proveedor). El envío lo hace el worker con `src/services/fcm.js` (API HTTP v1, sin `firebase-admin`) y el mensaje sale de una lista blanca (`src/utils/push.js`: título, "OT #id, equipo código" y el id de la orden). Variables: `FCM_CUENTA_SERVICIO` (JSON de la cuenta de servicio de Firebase en base64, **solo en `gomaq-worker`**; sin ella el aviso queda esperando 1 h sin gastar intentos) y `PUSH_HABILITADO=1` (**en `gomaq-app`**, es el portón que deja encolar avisos push). Sin ellas no hay push: con `PUSH_HABILITADO` apagado la API no encola nada. Orden de activación: desplegar el worker con el canal push, poner `FCM_CUENTA_SERVICIO`, y recién entonces `PUSH_HABILITADO=1` en la API (un worker antiguo marcaría `push` como error permanente); apagar el flag es la vuelta atrás. Ninguna de las dos va en el repo ni en el chat. La app del mecánico y el panel aún no registran dispositivos (fases siguientes). La pantalla Notificaciones del panel muestra, para un push, el nombre y rol del usuario destinatario (no el id del dispositivo ni su token) y filtra por canal (`GET /api/notificaciones?canal=push|email|whatsapp`).
- **Configuración de Railway en código:** `.railway/railway.ts` define los servicios `gomaq-app`, `gomaq-worker` y `Postgres` (reemplaza a `railway.json`, que Railway da por obsoleto). Los secretos no están en el archivo (`preserve()`). Para revisar y aplicar cambios: `railway config plan` y `railway config apply`; necesita el paquete npm oficial `railway` instalado junto al archivo. En Windows hay que correrlo desde PowerShell con `$env:_` apuntando al `railway.exe` que está en `node_modules/@railway/cli/bin/` dentro de la carpeta global de npm (`npm root -g`), porque el SDK ejecuta `railway --version` y no puede lanzar el `.cmd`.
- **Reposo (`sleepApplication`):** está activo en `gomaq-app` y en `Postgres`. El worker consulta la base cada 15 s, así que la mantiene despierta; revisar el costo en el panel de uso de Railway.
- **Base de datos:** el servicio `Postgres` del mismo proyecto. `DATABASE_URL` del backend es una referencia (`${{Postgres.DATABASE_URL}}`), así que las credenciales no se copian a mano.
- **Variables del servicio:** `DATABASE_URL`, `JWT_SECRET` (generado al azar al crear el proyecto), `TRUST_PROXY=1`, `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`. Se ven con `railway variable list --service gomaq-app`.
- **Todos los archivos pesados van a Supabase Storage**, en buckets privados con URLs firmadas temporales (1 h), nunca URLs públicas permanentes:
  - `evidencias-ot`: fotos de evidencia subidas por el mecánico desde terreno
  - `documentos-gomaq`: PDFs de guías y facturas subidos por el administrativo desde el panel web
- **Logs y métricas:** `railway logs --service gomaq-app` (o `gomaq-worker`) y `railway metrics --service gomaq-app`, o el panel de Railway (`railway open`).

## Migraciones de la base de datos

`db/schema.sql` y `db/migrations/NNN_*.sql` los aplica `backend/scripts/migrar.js` (`npm run migrar`), en orden y una sola vez cada uno. Lleva el registro en la tabla `schema_migraciones`. En Railway corre sola al arrancar el contenedor; para agregar una migración basta con crear el archivo siguiente en `db/migrations/`. Un candado de la base (`pg_advisory_lock`) evita que dos instancias migren a la vez.

Cada migración corre en su propia transacción: si falla, no queda aplicada a medias y el despliegue se detiene sin reemplazar la versión anterior.

Una base creada a mano, sin registro, no se toca: el script no puede saber qué migraciones ya tiene. Se marca primero con `node scripts/migrar.js --marcar-hasta 016`.

## Cómo desplegar un cambio

**Backend y panel web**, que van juntos en el mismo servicio: **basta con `git push` a `main`.** El worker (`gomaq-worker`) se redespliega solo si cambia `backend/`, `db/` o `Dockerfile.worker`, también tras pasar el CI.

1. GitHub Actions (`.github/workflows/tests.yml`) corre los tres niveles de tests sobre un Postgres temporal: reglas de negocio, escritura y extremo a extremo contra el backend levantado en el mismo job. Aplica las migraciones con el mismo script que Railway, así que una migración que no aplica sobre una base vacía también falla aquí.
2. Railway está conectado al repositorio con "Wait for CI": despliega el commit solo si ese workflow pasa.
3. Al arrancar se aplican las migraciones pendientes, y la versión anterior se reemplaza solo si `/api/health` responde.

Para seguir un despliegue: `railway logs --service gomaq-app --build`. Para desplegar sin pasar por GitHub (una emergencia): `railway up --service gomaq-app` desde la raíz del repositorio.

**App del Mecánico:** apunta por defecto a la URL de Railway, así que funciona con datos móviles en terreno. Para generar el APK de producción:
```bash
cd mobile && flutter build apk --release
```
Para instalarlo en un celular, conectarlo por USB o por depuración inalámbrica (`adb pair`/`adb connect`) y usar `flutter install` o `adb install`. El celular usado en pruebas es Android con MIUI: si la instalación falla con `INSTALL_FAILED_USER_RESTRICTED`, activar "Instalar vía USB" en Opciones de Desarrollador. Para desarrollar contra un backend local: `flutter run --dart-define=GOMAQ_API_URL=http://10.0.2.2:3000`.

**Avisos push en la app del mecánico (FCM):** la app registra su token en `POST /api/dispositivos` (en línea, no por la cola offline) y muestra avisos de órdenes asignadas o disponibles. La configuración de Firebase llega por `--dart-define` al compilar, sin `google-services.json` ni plugin Gradle:
```bash
cd terreno && flutter build apk --release   --dart-define=FIREBASE_API_KEY=... --dart-define=FIREBASE_APP_ID=...   --dart-define=FIREBASE_MESSAGING_SENDER_ID=... --dart-define=FIREBASE_PROJECT_ID=...
```
Si falta cualquiera de las cuatro variables, **no hay push**: no se inicializa Firebase y la app funciona igual (es el caso de todo APK compilado sin ellas). Son datos públicos (la clave se protege restringiéndola al paquete `cl.gomaq.gomaq_mecanico` en Google Cloud); van por `--dart-define` y no en el repositorio solo porque todavía no existe el proyecto de Firebase. Si el servidor aún no tiene la ruta de dispositivos, la app ignora el 404. El permiso de notificaciones se explica y se pide una sola vez después de iniciar sesión; si se niega, la app sigue igual. Canal de Android: "Avisos de órdenes" (distinto de "Viaje en curso", el del servicio de posición). Con la app cerrada o en segundo plano muestra la notificación el sistema; con la app abierta, un aviso en pantalla y una sincronización. Al cerrar sesión se borra el dispositivo en el servidor y el token de Firebase.

**Orden en un cambio que toca la cola offline:** desplegar primero el backend y después el APK. La app manda un `uuid_cliente` por tarea para que los reintentos no dupliquen; contra un backend anterior sigue funcionando, pero sin esa protección.

## Estructura del repo

```
gomaq/
├── backend/
│   ├── server.js              # entrypoint, monta todas las rutas + sirve backend/public/
│   ├── src/routes/            # un archivo por recurso (auth, maquinarias, ordenes, guias, facturas,
│   │                          #   evidencias, notificaciones, usuarios, clientes, solicitudes,
│   │                          #   dashboard, horometro)
│   ├── src/utils/parsearDocumento.js  # heuristicas sobre el texto de los PDF (fecha, tipo, folio, RUT, horometro)
│   ├── src/utils/mantencion.js        # regla de la preventiva por horas de uso
│   ├── src/utils/facturableOt.js      # facturable de la OT derivado de sus lineas
│   ├── src/utils/rentabilidad.js      # gasto vs ingreso por equipo
│   ├── src/utils/stock.js             # inventario por ubicacion (bodega / furgon)
│   ├── src/workers/notificaciones.js  # patron Outbox: reintentos con backoff exponencial
│   ├── src/middleware/auth.js # verifyToken + requireRole(...roles)
│   ├── src/middleware/upload.js  # limites de tamano/tipo de las subidas (multer)
│   ├── test/                  # node:test, sin dependencias. `npm test`. Fixtures: texto real
│   │                          #   de guias y facturas de GOMAQ, con los terceros anonimizados
│   ├── scripts/create-user.js # bootstrap de usuarios (no hay registro publico)
│   └── uploads/, public/      # generados, no estan en git (.gitignore)
├── db/
│   ├── schema.sql             # esquema base
│   └── migrations/            # 001..00N, se aplican a mano en orden (no hay migration runner)
├── comun/                     # paquete Dart compartido: cliente HTTP (ClienteApi) y Formato
├── panel/                     # Flutter (web y Android), panel Admin/Gerente + portal Cliente
└── terreno/                   # Flutter, app del mecanico (offline-first), solo Android
```

## Roles y permisos (Tabla 6.1 del informe, implementada en `requireRole`)

| Rol | Puede |
|---|---|
| `gerente` | Lectura general, aprobar valorizaciones de reparaciones facturables |
| `administrativo` | Gestión de flota, guías, facturación, asignación de mecánicos, clientes, solicitudes |
| `mecanico` | Ver solo sus OT asignadas, diagnosticar, subir evidencia, finalizar |
| `cliente` | Ver solo su propia flota (vinculada por `usuarios.cliente_id`), generar solicitudes, ver seguimiento e historial |

## Cuentas de prueba (backend de desarrollo, contraseña `PruebaGomaq123` para todas)

| Email | Rol |
|---|---|
| `admin@gomaq.test` | gerente |
| `administrativo@gomaq.test` | administrativo |
| `mecanico@gomaq.test` / `mecanico2@gomaq.test` | mecanico |
| `cliente@gomaq.test` | cliente (vinculado a la empresa "Acsa International") |

Crear más usuarios: `node scripts/create-user.js <nombre> <email> <rol> [cliente_id]` (el `cliente_id` solo aplica a rol `cliente`). La contraseña **no** va como argumento: el script la pide por consola, para que no quede en el historial del shell ni visible en `ps`.

## Diseño visual

Paleta extraída de los mockups originales del informe (no inventada), definida una sola vez en `theme/gomaq_theme.dart` (duplicado en `mobile/` y `web/`, sin paquete compartido — es deliberadamente simple): naranja primario `#EA5B1F`, sidebar oscuro `#1B1210`, verde/ámbar/rojo para estados operativa/mantención/fuera de servicio.

## Horómetro y mantención preventiva

Módulo agregado a partir de la entrevista con el jefe de taller y la administrativa del 20-21 de julio de 2026 (ver `docs/entrevistas/`), donde el horómetro se lleva a mano en Excel por equipo, cliente y mes para calcular la preventiva de las 350 h.

- **La lectura entra por tres vías**, y cada una queda registrada con su `origen`: la app del mecánico al cerrar una OT (`movil`), el panel del administrativo (`panel`), y la detección automática del PDF de la guía de entrega, que trae impreso `HOROMETRO: 1156` (`guia`). La guía de retiro y la factura no lo traen.
- **El intervalo es por equipo**, con 350 h por defecto para toda la flota (`maquinarias.intervalo_mantencion_horas`). Lo que se cuenta son las horas desde la última mantención, no el horómetro absoluto.
- **Mantención próxima (50 h restantes)**: se ve en Pendientes del panel. Todavía no se envía por ningún medio (no hay proveedor): `alerta_mantencion_enviada` solo se marca cuando un aviso llega a encolarse, así que avisará en cuanto exista un proveedor.
- **El contador se reinicia** de dos formas: el mecánico confirma "se hizo la mantención preventiva" al cerrar la OT, o el administrativo la marca desde el panel (sirve para corregir y para cargar mantenciones anteriores al sistema).
- **La agenda mensual** (pantalla Horómetro, pestaña "Por medir") lista los equipos arrendados sin lectura en el mes en curso; al registrarla desaparecen. *Pendiente de confirmar con GOMAQ si también quieren medir los equipos que están en taller o en patio.*

Como el aviso se evalúa al registrar una lectura, un equipo del que nadie toma el horómetro no alerta: para ese caso está la agenda mensual.

## La Orden de Trabajo en papel

El talonario físico de GOMAQ (ejemplo: OT N° 00904) está trasladado a la app del mecánico. Equivalencia campo por campo:

| Formulario en papel | Dónde vive ahora |
|---|---|
| N° preimpreso del talonario | `ordenes_trabajo.folio_papel` (opcional; la app usa su propio correlativo) |
| Cliente / RUT / Planta | Ya existían: `clientes` y `maquinarias.ubicacion` |
| N° Serie / Modelo / N° Activo | Ficha técnica del equipo (migración 007) |
| Horómetro | `lecturas_horometro` (migración 012) |
| Tipo de servicio (6 casillas) | `ordenes_trabajo.tipo_servicio`, lo marca el mecánico |
| Checklist de 31 ítems en 5 grupos | `servicios_checklist` + `ot_servicios`. Marca **dónde se intervino**, no es pauta de revisión |
| Inicio / Término del trabajo | `tramos_trabajo`, varios por OT (el trabajo se puede retomar en otra visita) |
| Cant. / Código / Descripción / Precio | `movimientos_insumo`, con `insumo_id` nullable para el repuesto escrito a mano |
| Facturable SÍ / NO / ? por línea | `movimientos_insumo.facturable`. `ordenes_trabajo.facturable` pasó a ser **derivado** |
| Observaciones iniciales | `ordenes_trabajo.diagnostico` (mismo concepto, ya existía) |
| Observaciones finales | `ordenes_trabajo.observacion_final` |
| Firma del cliente | `firmas_recepcion` (migración 011) |
| Firma del técnico | Se identifica por el usuario autenticado que cierra la OT; no se dibuja |

**El facturable dejó de vivir en la OT.** En el papel es una columna con tres casillas en cada línea de repuesto, así que la fuente de verdad es la línea y el campo de la orden lo recalcula el backend (`src/utils/facturableOt.js`) dentro de la misma transacción. `facturacion.js` y `dashboard.js` siguen leyéndolo sin cambios. Regla acordada: **sin repuestos no se cobra**. El "?" del papel es `pendiente`, y esas líneas se le muestran a gerencia para que las resuelva desde el panel — es el caso que describió el jefe de taller de decidir después si se le cobra a un cliente antiguo.

**Pendiente de preguntar a GOMAQ**, deliberadamente fuera del alcance: qué significa el campo **LLAMADO**, qué significa el checkbox **TRABAJO REALIZADO** de la cabecera, y de dónde salen las columnas **NORMALES / EXTRAS** de horas (¿se calculan desde los tramos o se escriben a mano?).

## Costo real por equipo

Responde el punto 1 de la entrevista con el jefe de taller, textual: *"no sabemos si en los tres meses que estuvo la máquina se gastó más plata de la que dejaba el arriendo"*.

- **Gasto** = repuestos (`cantidad × precio_unitario` de las líneas de la OT). Cuenta **todas** las líneas, se hayan cobrado o no: es el costo real para GOMAQ, no lo facturado al cliente. Las líneas sin precio se informan aparte, para que un total bajo no se confunda con un equipo barato.
- **Ingreso** = facturas del equipo, por sus dos caminos: arriendo (`facturas.maquinaria_id`) y reparación (vía `orden_trabajo_id`).
- **Dos vistas**: la pantalla "Costo por equipo" lista la flota con lo que sale a pérdida primero, y el perfil de cada equipo muestra su propio desglose.
- Traslados y horas de trabajo **quedan fuera**: `guias` no guarda el monto del traslado y no existe ningún valor hora definido en el negocio.

**Atribución del gasto:** si el mecánico interviene un segundo equipo durante la misma visita, abre una OT aparte para ese equipo desde la app (`POST /api/ordenes-trabajo/en-terreno`), en vez de cargarle el repuesto a la orden en curso. Es la respuesta al problema que el jefe de taller describió como que el repuesto *"queda en el aire"*. Esa OT se puede crear sin señal: nace con un id local negativo y la cola lo reemplaza por el real al sincronizar, remapeando de paso sus fotos, repuestos y tramos.

## Vehículos y stock del furgón

Cada mecánico tiene un furgón asignado y no rotan (entrevista el jefe de taller, punto 3), y en ese furgón lleva su propio stock de repuestos. Existe además un furgón exclusivo de compras que no sale a terreno: por eso un vehículo puede no tener mecánico, y solo los asignados tienen stock.

**Inventario multi-ubicación** (patrón *van stock*, como lo modelan Salesforce Field Service o SAP FSM): `ubicaciones_stock` (bodega central + un furgón por vehículo asignado) → `stock_ubicacion` (existencia de cada insumo en cada lugar) → transferencia (bodega → furgón) → consumo (furgón → OT).

- `insumos.stock_actual` **no se eliminó**: pasó a ser el total derivado de todas las ubicaciones, recalculado en la misma transacción que mueve stock. La pantalla de Insumos y `GET /api/insumos` siguen funcionando sin cambios — mismo criterio que con `ordenes_trabajo.facturable`.
- **Consumir en una OT descuenta del furgón** de quien lo registra (de la bodega si lo registra el administrativo). Puede dejar el furgón **en negativo** a propósito: si el mecánico instaló un repuesto que el sistema no tenía, bloquearlo solo haría que el dato se pierda. El descuadre queda visible en `GET /api/insumos/descuadres`.
- **Cargar el furgón es solo online**, a diferencia del resto de la app. Se hace en el taller y hay que validar contra la bodega en el momento, para que dos mecánicos no reclamen la misma pieza. Ahí sí se rechaza sacar más de lo que hay.
- En la app: **Mi cuenta** (datos del mecánico, vehículo, documentos fotografiados) y **Mi furgón** (stock, cacheado para verlo en terreno). En el panel: **Vehículos**, donde se crean y asignan.

Esto además completa **HU-07**, que prometía avisar al cliente *"quién llega a reparar su equipo y con qué vehículo"*: el aviso ahora lleva nombre, RUT y marca/modelo/patente. La app le dice al mecánico exactamente qué de su ficha sale hacia el cliente.

## La cola offline de la app

El mecánico trabaja sin señal y la app reintenta al volver la conexión. Reglas que la sostienen (auditoría de septiembre de 2026):

- **Un reintento no duplica.** "No hubo respuesta" no significa "no se guardó": con señal inestable el servidor puede confirmar y perder solo la respuesta. Cada tarea lleva un UUID generado en el teléfono (`uuid_cliente`, migración 015); si llega de nuevo, el servidor devuelve lo que ya existe. Cubre repuestos, tramos, horómetro, evidencias y OT creadas en terreno. Cerrar una OT ya cerrada responde bien sin repetir el aviso al cliente.
- **401 pausa la cola, 403 no.** Un 401 es sesión vencida: se pide volver a entrar y el trabajo queda guardado. Un 403 es "esta OT ya no es tuya" (reasignada): solo esa tarea pasa a error, con su motivo. Las OT que el servidor ya no entrega se quitan del teléfono si no tienen cambios pendientes.
- **El trabajo guardado es de quien lo hizo.** Si otro mecánico inicia sesión con cambios pendientes del anterior, la app no lo deja entrar hasta que el primero sincronice.
- **Una línea de repuesto se anula, no se borra**, como una línea tachada en el talonario: el mecánico mientras la OT está abierta, el panel en cualquier momento. El repuesto vuelve a su ubicación y deja de contar como gasto.
- **Una OT cerrada no se modifica** desde la app, ni se reasigna. Reasignar una en curso cambia el técnico sin hacerla retroceder (`utils/estadosOt.js`).

## Flujo de la orden y app del mecánico (mejoras de octubre de 2026)

Salen de la prueba de punta a punta del 5 y 6 de octubre (plan en `docs/tecnica/PLAN_PRUEBAS_E2E.md`). Las dudas de negocio que quedaron abiertas están en `docs/entrevistas/PREGUNTAS_PENDIENTES_GOMAQ.md`.

- **Estados de la OT**: `pendiente` → `asignada` → `aceptada` → `en_camino` → `en_terreno` ↔ `en_reparacion` → `finalizada` (migración 018). El mecánico acepta, sale hacia el destino y al llegar pulsa Iniciar; cada paso guarda su hora (`aceptada_at`, `en_camino_at`, `llegada_at`) y la app envía la hora real del toque (`ocurrio_en`), aunque se sincronice después. Un reintento o un cambio atrasado responde bien sin retroceder el estado. Un APK anterior sigue pudiendo pasar de asignada a en_terreno. Reasignar una OT aceptada o en camino la deja asignada al nuevo técnico.
- **Tiempo de trabajo automático**: Iniciar abre el tramo y Finalizar cierra el que siga abierto. El viaje no cuenta como trabajo.
- **Órdenes sin asignar**: `GET /api/ordenes-trabajo?sin_asignar=1` y `PATCH /:id/tomar`, atómico (dos mecánicos a la vez, uno recibe 409). En la app: "Órdenes disponibles", solo con señal. El cliente recibe el mismo aviso de mecánico asignado.
- **Nueva OT desde terreno**: botón en la lista, con buscador sobre la flota completa (usa el flujo de OT en terreno con id local y `uuid_cliente`).
- **Flota en la app**: toda la flota con buscador; la ficha y el historial de un equipo ajeno se descargan al abrirlo (con señal).
- **Horómetro**: el mecánico y el administrativo pueden registrar la lectura de cualquier equipo en cualquier momento, con o sin OT. En la cola offline una lectura sin orden va con `orden_trabajo_id = 0`. El mecánico también puede reiniciar el contador de mantención de cualquier equipo, sin exigir una orden (decisión de David).
- **Cargar desde bodega**: el catálogo trae `stock_bodega` y `stock_furgon`; no deja pedir más de lo que hay y la transferencia es idempotente con `uuid_cliente` (reintentar no descuenta dos veces).
- **Precio de un repuesto**: parte del costo del catálogo y el mecánico lo puede cambiar. Si la línea no es facturable no se pide precio, pero se guarda el costo (Costos por equipo cuenta todas las líneas). GOMAQ todavía no define un precio de venta (pregunta 1 del documento de preguntas).
- **Secciones de la orden en amarillo o verde** según estén completas (tipo de servicio, sistemas intervenidos, tiempos, observaciones y fotos). Solo las fotos DESPUÉS bloquean el cierre.
- **Sincronización**: rápida (cola, OT y furgón) tras cada acción y completa (catálogos, flota e historial) al abrir la app y cada 6 h. La lista se refresca al volver a primer plano y cada 3 minutos. Los cambios pendientes que fallan guardan y muestran el motivo.
- **Despacho sin documento** (migración 019): una guía de despacho o recepción puede registrarse sin PDF con `sin_documento` explícito; el equipo se asigna o se libera igual, queda quién la registró, y el PDF se adjunta después (`POST /api/maquinarias/guias/:guiaId/archivo`). El panel lo ofrece en Guías y, desde el perfil del equipo, como "Asignar a cliente" y "Retirar del cliente". El dashboard avisa cuántas guías faltan.
- **Base local del teléfono, versión 9**: la cabecera del talonario (tipo de servicio, observación final, folio) y el costo de cada repuesto se guardan también en el teléfono.

## Avisos push del panel (web y Android)

El panel (administrativo, gerente y portal del cliente) puede recibir avisos push por Firebase Cloud Messaging. **Sin configuración de Firebase no hace nada**: no se inicializa el plugin, no se llama al servidor y el botón de avisos no se dibuja. La configuración llega al compilar con `--dart-define` (no se commitea):

- `FIREBASE_API_KEY`, `FIREBASE_APP_ID`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_PROJECT_ID`; para la **web** además `FIREBASE_VAPID_KEY`. La web y el APK del panel son apps distintas en Firebase: cada build lleva sus propios valores.
- En la web los avisos se activan solo con el botón de campana (nunca se pide permiso al cargar la página). En Android se pregunta una vez con un diálogo previo y después queda el mismo botón.
- El token se registra con `POST /api/dispositivos` (`app: 'panel'`) y se borra al cerrar sesión. Depende del backend de push (PR 126); mientras la ruta no exista (404) se ignora en silencio.
- `panel/web/firebase-messaging-sw.js` muestra la notificación con la pestaña cerrada. No carga el SDK de Firebase ni lleva configuración dentro (un service worker no puede leer los `--dart-define`): solo atiende el evento `push` y abre la OT al tocar. `server.js` lo sirve como JavaScript con `Cache-Control: no-cache`, y el CSP permite `fcmregistrations.googleapis.com` y `firebaseinstallations.googleapis.com`.
- Limitación: Safari en iPhone y iPad solo admite avisos web con el panel instalado en la pantalla de inicio (iOS 16.4 o superior); en un navegador normal el botón indica que no están disponibles.
- No verificado contra Firebase real: ni el envío, ni el formato del mensaje en el service worker, ni el aviso con la pestaña abierta.

## Fotos del trabajo en el correo de la factura

El correo que recibe el cliente con su factura de reparación puede llevar, junto al PDF, las fotos del antes y el después de la orden (`evidencias_fotograficas`, tipos `antes` y `despues`). Solo las facturas con orden de trabajo: una factura de arriendo sale solo con el PDF.

- **Quién elige:** el administrativo, en el cuadro de la factura (`FotosOrden` con `seleccionable`): una casilla por foto, todas marcadas al principio (hasta 12) y "Todas" y "Ninguna". `POST /api/facturacion/:id/autorizar-envio` y la ruta por orden aceptan `foto_ids`; una lista vacía significa sin fotos. Sin `foto_ids` (por ejemplo el "Reenviar correo" de Notificaciones) se repite la selección del último correo de esa factura, y `GET .../vista-previa` la devuelve en `fotos_elegidas_antes`. Las fotos de la orden las trae `GET /api/ordenes-trabajo/:id/evidencia`, que el cuadro ya usaba.
- **Reducción y tope:** `backend/src/utils/fotosCorreo.js` descarga las fotos de a una y las reduce con `sharp` a JPEG de 1600 px y calidad 80 (si el conjunto no cabe, un segundo intento a 1200 px y calidad 70). El tope es de 10 MB en total, sin contar el PDF (Resend admite 40 MB por correo después de codificar en base64). La API mide el peso real antes de aceptar el envío y responde 400 con el peso y el máximo; el worker repite el mismo procedimiento al enviar. Fuera de la transacción del envío, para no tener la factura bloqueada mientras se descargan y reducen las fotos.
- **Privacidad:** la re-codificación borra los metadatos EXIF, incluidas las coordenadas GPS que traiga la foto. En el correo van con nombres `antes-1.jpg`, `despues-1.jpg`; en el aviso (`notificaciones_pendientes.payload`) solo viajan los ids, y el worker lee únicamente fotos de la orden de esa factura.
- **Fotos que faltan:** si al enviar una foto ya no existe, el correo sale sin ella y queda anotado en `ultimo_error` ("Enviado sin N foto(s)..."), visible en Notificaciones. Que las fotos no quepan en el tope al enviar es un error permanente.
- **Worker:** un correo con fotos tiene un plazo de envío mayor (`NOTIF_TIMEOUT_FOTOS_MS`, 60 s por defecto; el resto sigue en `NOTIF_TIMEOUT_MS`) y el plazo de toma de una fila se calcula con ese valor.
- **Dependencia nueva:** `sharp` 0.35.5 (Apache-2.0), sin scripts de instalación; trae binarios precompilados por plataforma (`@img/sharp-*`). Las dos imágenes (`Dockerfile` y `Dockerfile.worker`) son `node:22-bookworm-slim` (Linux glibc), donde usa el binario `linux-x64`. Verificado en producción el 19-11-2026: un correo con dos fotos y el PDF salió sin error desde `gomaq-worker`.

### Reenviar el correo de una factura desde Notificaciones

Cada fila de **correo de factura** (canal correo, tipo `factura_emitida`) de la pantalla Notificaciones tiene un botón **Reenviar** para el administrativo, además del que ya había en las facturas encontradas con Buscar.

- **En qué filas:** enviadas, con error y canceladas. No en las pendientes (ya van a salir), ni en las canceladas porque la factura se anuló (`ultimo_error` "Factura anulada": ya no hay nada que reenviar), ni en las que la lista marca con `factura_existe = false`, ni en los avisos con error por falta de proveedor (volverían a fallar igual).
- **`factura_existe`:** `GET /api/notificaciones` lo agrega a los correos de factura (true si esa factura sigue en la base, false si se borró al anularla, null en el resto de las filas y en un `factura_id` que no es numérico).
- **Fotos:** se reenvía con **las mismas fotos que llevó ese correo** (`foto_ids` del aviso; una lista vacía si no llevó). La fila muestra "N fotos adjuntas" y el diálogo de confirmación lo repite. El reenvío crea un envío nuevo y cancela el anterior que no hubiera salido (`Reemplazado`), como siempre.
- **"Reintentar":** en los correos de factura lo reemplaza "Reenviar". Sigue en los push con error y para el gerente, que no puede autorizar envíos (`autorizar-envio` es del administrativo).
- **No verificado:** el botón contra el panel desplegado; las pruebas usan el servidor y el panel simulados.

### Diseño del correo de la factura

`backend/src/utils/plantillaCorreoFactura.js` (HTML y texto plano) y `backend/src/utils/envioFactura.js` (adjuntos). Tablas de una columna con estilos en línea, que se ven igual en Gmail, Outlook y el celular (verificado a 375 px y en escritorio en un navegador; no en cada cliente de correo).

- **Encabezado de marca:** franja oscura (`#1B1210`) con el logo de GOMAQ y una línea naranja (`#EA5B1F`). El logo va **incrustado** (adjunto de Resend con `content_id: logo-gomaq`, citado en el HTML como `cid:logo-gomaq`), así que no depende de ninguna URL pública. El archivo es `backend/src/assets/correo/logo_gomaq.png`, copia de `panel/assets/2.0x/logo_gomaq_sobre_oscuro.png` (si se cambia el logo del panel, hay que copiarlo aquí). Si el archivo no se puede leer, el correo sale igual con el nombre de la empresa en texto. Un cliente que bloquee imágenes ve el texto alternativo "GOMAQ Maquinarias".
- **Tarjeta de resumen:** folio, monto total (en pesos con punto de miles), orden de trabajo con su equipo o arriendo del equipo con su período, fechas de emisión y vencimiento (solo en envíos nuevos: se guardan en el aviso al encolarlo) y las fotos que **de verdad** van adjuntas (se cuentan de los adjuntos al enviar, no de lo pedido). Una fila sin dato no se muestra. Nunca lleva valorización, costos ni datos del mecánico.
- **Asunto por defecto:** `Factura folio N · Orden de trabajo #id · GOMAQ` (o `· Arriendo equipo CÓDIGO ·` en una factura de arriendo). El administrativo sigue pudiendo editar asunto y mensaje.
- **Responder:** con `CORREO_CONTACTO` válido (una dirección sola, sin nombre ni comas) el correo lleva `reply_to` y el pie dice "Puede responder a este correo o escribir a ...". Las respuestas llegan **al buzón de GOMAQ**, no al sistema; ese buzón tiene que leerse. Sin un contacto válido no hay `reply_to` y el pie dice solo que no se responda (ya no aparece el `xxxx`).
- **Nombre del remitente:** lo define la variable `CORREO_REMITENTE` (por ejemplo `GOMAQ Maquinarias <gomaq@avisos.example.com>`), no el código.
- **No verificado:** el campo `reply_to` y el logo incrustado contra Resend y Gmail reales (las pruebas usan el proveedor simulado), y cómo muestra Gmail el logo incrustado (como imagen o como adjunto).

## Qué falta (en orden de importancia)

1. **Gestión de Usuarios completa desde el panel** — la pantalla "Usuarios" hoy solo cubre la aprobación de solicitudes de cuenta de clientes (auto-registro); crear/editar mecánicos y administrativos sigue siendo por SSH con `create-user.js`.
2. **Login social (Google/Microsoft) para clientes** — el registro hoy es solo email+contraseña. Se investigó el patrón de NextAuth (otro proyecto del usuario). Ya no hay bloqueo: con Railway la URL de callback es fija.
3. **Dirección de cliente con mapa** — el campo "dirección" en el registro de cliente es texto libre; un selector tipo Google Maps requiere una API key que no se activó en esta sesión.
4. **Otros proveedores de aviso (WhatsApp u otros)** — no hay ninguno; el push al mecánico tiene el backend listo pero apagado (ver Infraestructura) y falta la app. Solo se encola lo que tiene envío real (el correo de factura, `TIPOS_CON_ENVIO` en `backend/src/utils/avisos.js`, y el push con `PUSH_HABILITADO=1`); los demás avisos no se encolan (migración 046 cancela los que había). La cola de salida y el worker (`backend/src/workers/notificaciones.js`, con reintentos, backoff y estado de error) quedan listos: agregar un proveedor es sumar su canal y tipo al portón y su plantilla al worker.
5. **Dominio de correo propio** — el correo de factura sale por Resend desde un dominio provisorio de pruebas (`avisos.example.com`, verificado en Resend); cuando GOMAQ entregue el suyo hay que agregarlo en Resend, cargar sus registros DNS y cambiar `CORREO_REMITENTE`.
6. **Dominio propio** — Railway entrega una URL fija (`*.up.railway.app`); un dominio propio (por ejemplo `app.gomaq.cl`) se agrega con `railway domain` sin cambiar nada del código.
7. **Tarifa de arriendo por día** — Facturación muestra los días calculados de cada arriendo pero el monto se ingresa a mano (no existe una tarifa fija por equipo en ningún lado de la entrevista a la administrativa; el jefe la decide caso a caso, igual que en reparaciones).
8. **Detección de datos desde PDF** — verificada contra los documentos reales de GOMAQ (guía de entrega, guía de retiro y factura): acierta fecha, tipo, folio, RUT, monto y horómetro, y está cubierta por tests con ese texto real como fixture. Sigue siendo heurística: si el PDF es una imagen escaneada sin capa de texto no detecta nada y el usuario llena a mano, y un facturador con otro formato requeriría ajustar las expresiones.
9. **Observar el worker** — el atajo "Avisos con problemas" del dashboard cuenta los avisos con error y los pendientes vencidos hace más de 10 min (señal de worker caído). Al conectar el proveedor real, agregar sus claves a `VARIABLES_REQUERIDAS` de `backend/scripts/worker.js` y a las variables de `gomaq-worker`.
10. **Refresh token / renovación de sesión** — hoy el token JWT dura 12 h y al expirar la app cierra sesión limpiamente con aviso (tanto web como móvil, donde además el trabajo offline queda protegido en cola). La práctica completa de la industria es access token corto + refresh token; queda para cuando el sistema salga de la etapa de demo.
11. **Quitar el inicio rápido antes de usar datos reales** — el panel (Administrativo y Cliente) y terreno (Mecánico) tienen botones de inicio rápido con credenciales de prueba escritas en `comun/lib/usuarios_demo.dart` (y en `backend/scripts/usuarios-demo.js`). Están en el repositorio y en la base de Railway. Antes de cargar datos reales: `railway ssh --service gomaq-worker "node scripts/usuarios-demo.js borrar"`, y borrar ese archivo, el script y los botones de `login_screen.dart` del panel y de terreno.
12. Pulido menor: ver/descargar una factura ya subida directo desde la pantalla de Facturación (hoy solo permite subir).

## Notas para quien retome esto

- **Datos de prueba en la BD** — quedaron registros de las verificaciones de desarrollo (maquinaria GH-999, guías/facturas dummy, clientes de prueba). `db/scripts/limpiar_datos_prueba.sql` los borra; correrlo a mano cuando se decida.

- **Entorno local de pruebas** — el backend puede ejecutarse completo en un equipo de desarrollo, sin depender del servidor. Es la única forma de correr la batería entera hoy:

  1. **PostgreSQL**: descargar los binarios en ZIP (sin instalador ni privilegios de administrador) desde `get.enterprisedb.com/postgresql/`, descomprimir y luego `initdb -D C:/dev/pgdata -U postgres --pwfile=clave.txt -E UTF8`, `pg_ctl -D C:/dev/pgdata -l servidor.log start` y `createdb -U postgres -h 127.0.0.1 gomaq`. El instalador gráfico en modo desatendido **no sirve**: devuelve código 0 sin copiar la carpeta `lib` ni crear el servicio.
  2. **Esquema**: aplicar `db/schema.sql` y después las migraciones de `db/migrations/` en orden numérico.
  3. **Datos**: `psql -U postgres -h 127.0.0.1 -d gomaq -f db/scripts/semilla_pruebas.sql`. Crea las cuatro cuentas, un cliente, dos equipos y una orden por cada mecánico; es idempotente.
  4. **Variables**: crear `backend/.env` con `DATABASE_URL` apuntando a la base local, un `JWT_SECRET` cualquiera y valores ficticios para `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` — el arranque los exige, pero la batería no toca el almacenamiento de archivos.
  5. **Ejecutar**: `npm start` y, en otra consola, `GOMAQ_TEST_URL=http://localhost:3000 npm test`.

- **Tests del backend**: `cd backend && npm test` (167 casos, `node:test`, sin dependencias nuevas), en cuatro niveles:
  - **Reglas de negocio** (121): mantención preventiva, facturable de la OT, ciclo de vida de la OT, rentabilidad, stock, paginación, rutas de archivo, idempotencia, IP del límite de intentos y el parseo de los PDF reales de GOMAQ como fixture.
  - **Capa de autorización** (14): `verifyToken` y `requireRole` con tokens ajenos, expirados y manipulados. Corren en cualquier máquina, sin servidor ni base de datos.
  - **Escritura** (16): reintentos de la cola sin duplicados, anulación de líneas con devolución de stock, transiciones de la OT y la cola de valorización. Levantan las rutas en memoria contra la base de `DATABASE_URL`, crean sus propios datos y los borran al terminar; firman sus tokens con un secreto de prueba. **Solo contra una base local**: se activan con `GOMAQ_TEST_ESCRITURA=1 npm test` y sin esa variable se omiten.
  - **Extremo a extremo** (16): contra una instancia desplegada. Verifican el contrato de la API, el control por rol, la pertenencia del recurso y la superficie expuesta. Son de solo lectura, así que pueden correrse contra el servidor real sin ensuciarlo. Si no hay instancia disponible se **omiten con el motivo**, no fallan: un servidor apagado no es un defecto del código. Apuntan por defecto al servidor de Railway; para usar otra instancia, `GOMAQ_TEST_URL=http://localhost:3000 npm test`.
- **`TRUST_PROXY`** (opcional): cuántos saltos de proxy hay delante del backend, para que el límite de intentos de login cuente por la IP real. Sin definirla solo se confía en loopback (desarrollo local). En Railway está en `TRUST_PROXY=1`.

- **Las contraseñas y tokens reales** (contraseña de la BD, `JWT_SECRET`, credenciales de Supabase) están únicamente en el `.env` del servidor — nunca se subieron a este repo ni deberían aparecer en el historial de git.
