# GOMAQ

Sistema de Gestión y Comunicación Centralizado para una empresa de arriendo de maquinarias (contexto: seminario/proyecto de título, Ingeniería Civil en Informática). Este README describe el estado real del proyecto para que cualquier conversación nueva (con Claude o cualquier otra persona) pueda retomarlo sin contexto previo.

## Qué es esto

Un sistema con 3 aplicaciones que comparten un mismo backend:

- **Backend** (`backend/`) — API REST en Node.js + Express + PostgreSQL
- **App del Mecánico** (`mobile/`) — Flutter, Android, **offline-first** (SQLite local + cola de sincronización)
- **Panel Web** (`web/`) — Flutter Web, con vistas distintas por rol: Administrativo/Gerente (panel de gestión) y Cliente (portal de seguimiento)

## Infraestructura actual (todo corre en un Dell OptiPlex GX520 viejo, no en la nube)

- **Servidor:** un Dell OptiPlex GX520 (2005, 3GB RAM, HDD) con Debian 13, nombre de host `debianMARCAN`, IP LAN `192.168.1.29`, usuario `dmarcan`
- **Por qué no está en la nube:** se decidió partir en hardware local para no gastar en cloud antes de tener el MVP funcionando; migrar a AWS/GCP quedó para más adelante (la arquitectura ya está pensada para eso, ver el informe del seminario)
- **Backend:** corre como servicio `systemd` (`gomaq-backend`), puerto 3000, arranca solo al encender el equipo
- **Base de datos:** PostgreSQL 17, base `gomaq`, usuario `gomaq_user` (contraseña en el `.env` del backend en el servidor, no está en este repo)
- **Acceso externo:** Cloudflare Tunnel modo "Quick Tunnel" (`cloudflared-quick.service`) — **la URL pública cambia cada vez que se reinicia el servicio o el equipo**. Para verla:
  ```bash
  ssh dmarcan@192.168.1.29
  journalctl -u cloudflared-quick --no-pager | grep -o "https://[a-zA-Z0-9.-]*trycloudflare.com" | tail -1
  ```
  Esa misma URL sirve tanto la API (`/api/*`) como el Panel Web (`/`), porque el build de Flutter Web se sirve como estático desde el propio backend Node — no hay un segundo túnel.
- **Todos los archivos pesados van a Supabase Storage**, en buckets privados con URLs firmadas temporales (1h) — nunca URLs públicas permanentes:
  - `evidencias-ot` — fotos de evidencia subidas por el mecánico desde terreno
  - `documentos-gomaq` — PDFs de guías y facturas subidos por el administrativo desde el panel web
- `backend/uploads/` prácticamente no se usa — quedó de una decisión anterior (guías/facturas en disco local) que se corrigió; puede tener archivos de prueba viejos ahí, no se están sirviendo
- **Monitoreo del servidor:** `ssh dmarcan@192.168.1.29` y luego `htop` (ya instalado) para ver CPU/RAM/procesos en vivo

## Cómo desplegar un cambio

**Backend:**
```bash
# en tu maquina: git push (con confirmacion del usuario)
ssh dmarcan@192.168.1.29
cd ~/gomaq && git pull origin main
# si hay migracion nueva en db/migrations/, aplicarla:
#   sudo -u postgres psql -d gomaq -f db/migrations/00X_nombre.sql
#   (copiar antes a /tmp con permisos 644, el usuario postgres no puede leer el home de dmarcan directamente)
sudo systemctl restart gomaq-backend
```

**Panel Web:**
```bash
cd web
flutter build web --release --dart-define=GOMAQ_API_URL=   # IMPORTANTE: URL vacia = rutas relativas, mismo origen que el backend
# copiar build/web/* a ~/gomaq/backend/public/ en el servidor (via sftp/scp)
ssh dmarcan@192.168.1.29 "sudo systemctl restart gomaq-backend"
```

**App del Mecánico:** conectar el celular por USB o depuración inalámbrica (`adb pair`/`adb connect`), luego `flutter run -d <device>` desde `mobile/`. El celular usado en pruebas es Android con MIUI — si la instalación falla con `INSTALL_FAILED_USER_RESTRICTED`, activar "Instalar vía USB" en Opciones de Desarrollador.

## Estructura del repo

```
gomaq/
├── backend/
│   ├── server.js              # entrypoint, monta todas las rutas + sirve backend/public/
│   ├── src/routes/            # un archivo por recurso (auth, maquinarias, ordenes, guias, facturas,
│   │                          #   evidencias, notificaciones, usuarios, clientes, solicitudes, dashboard)
│   ├── src/workers/notificaciones.js  # patron Outbox: reintentos con backoff exponencial
│   ├── src/middleware/auth.js # verifyToken + requireRole(...roles)
│   ├── scripts/create-user.js # bootstrap de usuarios (no hay registro publico)
│   └── uploads/, public/      # generados, no estan en git (.gitignore)
├── db/
│   ├── schema.sql             # esquema base
│   └── migrations/            # 001..00N, se aplican a mano en orden (no hay migration runner)
├── mobile/                    # Flutter, app del mecanico (offline-first)
└── web/                       # Flutter Web, panel Admin/Gerente + portal Cliente
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

Crear más usuarios: `node scripts/create-user.js <nombre> <email> <password> <rol> [cliente_id]` (el `cliente_id` solo aplica a rol `cliente`).

## Diseño visual

Paleta extraída de los mockups originales del informe (no inventada), definida una sola vez en `theme/gomaq_theme.dart` (duplicado en `mobile/` y `web/`, sin paquete compartido — es deliberadamente simple): naranja primario `#EA5B1F`, sidebar oscuro `#1B1210`, verde/ámbar/rojo para estados operativa/mantención/fuera de servicio.

## Qué falta (en orden de importancia)

1. **Notificación al cerrar una Orden de Trabajo** — el patrón Outbox ya está armado y se usa al *asignar* un mecánico (HU-07), pero no se dispara nada al *finalizar* la OT, aunque el diagrama BPMN del informe sí lo contempla. Es un fix chico, mismo patrón ya construido.
2. **Gestión de Usuarios completa desde el panel** — la pantalla "Usuarios" hoy solo cubre la aprobación de solicitudes de cuenta de clientes (auto-registro); crear/editar mecánicos y administrativos sigue siendo por SSH con `create-user.js`.
3. **Login social (Google/Microsoft) para clientes** — el registro hoy es solo email+contraseña. Se investigó el patrón de NextAuth (otro proyecto del usuario) pero no se implementó porque requiere registrar la app ante Google/Microsoft con una URL de callback fija, y hoy la URL pública cambia en cada reinicio del túnel de Cloudflare. Queda listo para agregar cuando el proyecto tenga un dominio fijo (ej. desplegado en Railway).
4. **Dirección de cliente con mapa** — el campo "dirección" en el registro de cliente es texto libre; un selector tipo Google Maps requiere una API key que no se activó en esta sesión.
5. **WhatsApp Business real** — deliberadamente pospuesto hasta el final del proyecto. El worker (`backend/src/workers/notificaciones.js`) ya tiene todo el mecanismo (reintentos, backoff, estado de error) — la función `enviarNotificacion` hoy lanza un error simulado ("Proveedor no configurado"); cuando exista la cuenta, se reemplaza esa única función por la llamada real a la Cloud API.
6. **Envío de correo real** (SMTP/SES) — mismo caso que WhatsApp, mismo patrón Outbox ya listo (usado también por la vista previa de correo de Facturación).
7. **Dominio propio** — hoy la URL pública cambia en cada reinicio del túnel; con un dominio en Cloudflare se puede pasar a un túnel nombrado con URL fija (esto además desbloquea el punto 3).
8. **Tarifa de arriendo por día** — Facturación muestra los días calculados de cada arriendo pero el monto se ingresa a mano (no existe una tarifa fija por equipo en ningún lado de la entrevista a la administrativa; el jefe la decide caso a caso, igual que en reparaciones).
9. **Detección de datos desde PDF (Guías y Facturación)** — la extracción de fecha/hora/tipo/monto es heurística sobre el texto del PDF (`pdf-parse` + expresiones regulares), no garantizada; si el PDF es una imagen escaneada sin texto, no detecta nada y el usuario llena a mano. Suficiente para el flujo de UI, pero no es un parser robusto.
10. Pulido menor: ver/descargar una factura ya subida directo desde la pantalla de Facturación (hoy solo permite subir).

## Notas para quien retome esto

- **No hay tests automatizados** — toda la verificación de este proyecto se hizo manualmente con `curl` contra el backend y probando la UI a mano. Si se agregan tests, sería un buen próximo paso.
- **Las contraseñas y tokens reales** (contraseña de la BD, `JWT_SECRET`, credenciales de Supabase) están únicamente en el `.env` del servidor — nunca se subieron a este repo ni deberían aparecer en el historial de git.
- **El GX520 es hardware de 2005** — no tiene margen para crecer mucho más de lo que hay hoy sin migrar a la nube (ver sección 6.1.1 del informe, que ya justifica por qué eventualmente hay que migrar).
