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
- **Servicio `gomaq-app`:** se construye con el `Dockerfile` de la raíz, que compila el panel con Flutter 3.47.2 y arma el backend con Node 22. La configuración de despliegue está en `railway.json`. Al arrancar, el contenedor corre `node scripts/migrar.js` y después el servidor; Railway revisa `/api/health` antes de dar el despliegue por bueno.
- **Base de datos:** el servicio `Postgres` del mismo proyecto. `DATABASE_URL` del backend es una referencia (`${{Postgres.DATABASE_URL}}`), así que las credenciales no se copian a mano.
- **Variables del servicio:** `DATABASE_URL`, `JWT_SECRET` (generado al azar al crear el proyecto), `TRUST_PROXY=1`, `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`. Se ven con `railway variable list --service gomaq-app`.
- **Todos los archivos pesados van a Supabase Storage**, en buckets privados con URLs firmadas temporales (1 h), nunca URLs públicas permanentes:
  - `evidencias-ot`: fotos de evidencia subidas por el mecánico desde terreno
  - `documentos-gomaq`: PDFs de guías y facturas subidos por el administrativo desde el panel web
- **Logs y métricas:** `railway logs --service gomaq-app` y `railway metrics --service gomaq-app`, o el panel de Railway (`railway open`).

## Migraciones de la base de datos

`db/schema.sql` y `db/migrations/NNN_*.sql` los aplica `backend/scripts/migrar.js` (`npm run migrar`), en orden y una sola vez cada uno. Lleva el registro en la tabla `schema_migraciones`. En Railway corre sola al arrancar el contenedor; para agregar una migración basta con crear el archivo siguiente en `db/migrations/`. Un candado de la base (`pg_advisory_lock`) evita que dos instancias migren a la vez.

Cada migración corre en su propia transacción: si falla, no queda aplicada a medias y el despliegue se detiene sin reemplazar la versión anterior.

Una base creada a mano, sin registro, no se toca: el script no puede saber qué migraciones ya tiene. Se marca primero con `node scripts/migrar.js --marcar-hasta 016`.

## Cómo desplegar un cambio

**Backend y panel web**, que van juntos en el mismo servicio: **basta con `git push` a `main`.**

1. GitHub Actions (`.github/workflows/tests.yml`) corre los tres niveles de tests sobre un Postgres temporal: reglas de negocio, escritura y extremo a extremo contra el backend levantado en el mismo job. Aplica las migraciones con el mismo script que Railway, así que una migración que no aplica sobre una base vacía también falla aquí.
2. Railway está conectado al repositorio con "Wait for CI": despliega el commit solo si ese workflow pasa.
3. Al arrancar se aplican las migraciones pendientes, y la versión anterior se reemplaza solo si `/api/health` responde.

Para seguir un despliegue: `railway logs --service gomaq-app --build`. Para desplegar sin pasar por GitHub (una emergencia): `railway up --service gomaq-app` desde la raíz del repositorio.

**App del Mecánico:** apunta por defecto a la URL de Railway, así que funciona con datos móviles en terreno. Para generar el APK de producción:
```bash
cd mobile && flutter build apk --release
```
Para instalarlo en un celular, conectarlo por USB o por depuración inalámbrica (`adb pair`/`adb connect`) y usar `flutter install` o `adb install`. El celular usado en pruebas es Android con MIUI: si la instalación falla con `INSTALL_FAILED_USER_RESTRICTED`, activar "Instalar vía USB" en Opciones de Desarrollador. Para desarrollar contra un backend local: `flutter run --dart-define=GOMAQ_API_URL=http://10.0.2.2:3000`.

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
- **Aviso a las 50 h restantes**, encolado en el Outbox por WhatsApp y correo. Se manda una sola vez por ciclo (`alerta_mantencion_enviada`) y se apaga al reiniciar el contador. Los destinatarios se eligen desde el panel (pantalla Usuarios), no por `.env`.
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

## Qué falta (en orden de importancia)

1. **Gestión de Usuarios completa desde el panel** — la pantalla "Usuarios" hoy solo cubre la aprobación de solicitudes de cuenta de clientes (auto-registro); crear/editar mecánicos y administrativos sigue siendo por SSH con `create-user.js`.
2. **Login social (Google/Microsoft) para clientes** — el registro hoy es solo email+contraseña. Se investigó el patrón de NextAuth (otro proyecto del usuario). Ya no hay bloqueo: con Railway la URL de callback es fija.
3. **Dirección de cliente con mapa** — el campo "dirección" en el registro de cliente es texto libre; un selector tipo Google Maps requiere una API key que no se activó en esta sesión.
4. **WhatsApp Business real** — deliberadamente pospuesto hasta el final del proyecto. El worker (`backend/src/workers/notificaciones.js`) ya tiene todo el mecanismo (reintentos, backoff, estado de error) — la función `enviarNotificacion` hoy lanza un error simulado ("Proveedor no configurado"); cuando exista la cuenta, se reemplaza esa única función por la llamada real a la Cloud API.
5. **Envío de correo real** (SMTP/SES) — mismo caso que WhatsApp, mismo patrón Outbox ya listo (usado también por la vista previa de correo de Facturación).
6. **Dominio propio** — Railway entrega una URL fija (`*.up.railway.app`); un dominio propio (por ejemplo `app.gomaq.cl`) se agrega con `railway domain` sin cambiar nada del código.
7. **Tarifa de arriendo por día** — Facturación muestra los días calculados de cada arriendo pero el monto se ingresa a mano (no existe una tarifa fija por equipo en ningún lado de la entrevista a la administrativa; el jefe la decide caso a caso, igual que en reparaciones).
8. **Detección de datos desde PDF** — verificada contra los documentos reales de GOMAQ (guía de entrega, guía de retiro y factura): acierta fecha, tipo, folio, RUT, monto y horómetro, y está cubierta por tests con ese texto real como fixture. Sigue siendo heurística: si el PDF es una imagen escaneada sin capa de texto no detecta nada y el usuario llena a mano, y un facturador con otro formato requeriría ajustar las expresiones.
9. **Migrar `railway.json` al formato nuevo** — Railway lo da por obsoleto y lo acepta hasta el 1 de diciembre de 2026. `railway config migrate` genera `.railway/railway.ts`, pero en su versión actual no traslada la política de reinicio ni la ruta del Dockerfile: revisar el resultado antes de aplicarlo.
10. **Refresh token / renovación de sesión** — hoy el token JWT dura 12 h y al expirar la app cierra sesión limpiamente con aviso (tanto web como móvil, donde además el trabajo offline queda protegido en cola). La práctica completa de la industria es access token corto + refresh token; queda para cuando el sistema salga de la etapa de demo.
11. Pulido menor: ver/descargar una factura ya subida directo desde la pantalla de Facturación (hoy solo permite subir).

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
