// Zona horaria fija del negocio: los calculos de dias de arriendo (HORA_CORTE, cortes de dia calendario)
// usan la hora local del proceso. Fijarla evita que un servidor en UTC (Railway/nube) corra
// silenciosamente todos los cobros 4 horas.
process.env.TZ = 'America/Santiago';

require('dotenv').config();

// Arranque a prueba de fallos, ANTES de cargar nada mas: sin estas variables el servidor arrancaria
// igual y fallaria recien al primer login, con un 500 que no explica nada. Mejor no partir y decir cual falta.
const VARIABLES_REQUERIDAS = ['DATABASE_URL', 'JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const faltantes = VARIABLES_REQUERIDAS.filter((v) => !process.env[v]);
if (faltantes.length > 0) {
    console.error(`Faltan variables de entorno obligatorias: ${faltantes.join(', ')}. Revisa el .env`);
    process.exit(1);
}

// Un secreto de firma debil o de ejemplo permitiria firmar sesiones falsas: en produccion no se
// parte con el. Si esto falla en un despliegue, Railway deja corriendo la version anterior (el
// healthcheck no responde) hasta que se ponga un JWT_SECRET largo y aleatorio.
const { validarSecretoJwt, MIN_LARGO } = require('./src/utils/secretoJwt');
const secreto = validarSecretoJwt(process.env.JWT_SECRET, process.env.NODE_ENV);
if (!secreto.ok) {
    console.error(
        `JWT_SECRET no es seguro: ${secreto.motivo}. Usa un valor aleatorio de al menos ${MIN_LARGO} caracteres ` +
        '(por ejemplo `openssl rand -hex 32`). Cambiarlo cierra las sesiones abiertas; la cola de la app del mecanico no se pierde.'
    );
    process.exit(1);
}

const path = require('path');
require('./src/utils/asyncErrores');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pool = require('./src/config/db');
const maquinariasRouter = require('./src/routes/maquinarias');
const authRouter = require('./src/routes/auth');
const clientesRouter = require('./src/routes/clientes');
const ordenesRouter = require('./src/routes/ordenes');
const guiasRouter = require('./src/routes/guias');
const facturasRouter = require('./src/routes/facturas');
const evidenciasRouter = require('./src/routes/evidencias');
const notificacionesRouter = require('./src/routes/notificaciones');
const usuariosRouter = require('./src/routes/usuarios');
const solicitudesRouter = require('./src/routes/solicitudes');
const dashboardRouter = require('./src/routes/dashboard');
const mapaRouter = require('./src/routes/mapa');
const geocodificarRouter = require('./src/routes/geocodificar');
const insumosRouter = require('./src/routes/insumos');
const ejecutivosRouter = require('./src/routes/ejecutivos');
const facturacionRouter = require('./src/routes/facturacion');
const registroRouter = require('./src/routes/registro');
const { router: horometroRouter } = require('./src/routes/horometro');
const checklistRouter = require('./src/routes/checklist');
const rentabilidadRouter = require('./src/routes/rentabilidad');
const vehiculosRouter = require('./src/routes/vehiculos');
const dispositivosRouter = require('./src/routes/dispositivos');
const { iniciarWorker } = require('./src/workers/notificaciones');
const { manejarErroresDeSubida } = require('./src/middleware/upload');
const { manejarErrores, rutaApiNoEncontrada, registrarRedDeSeguridad } = require('./src/middleware/errores');

registrarRedDeSeguridad();

const app = express();

// x-powered-by anuncia el stack a cualquiera que mire las cabeceras
app.disable('x-powered-by');

// Detras de un proxy, la IP de la conexion es la del proxy y no la del usuario. Por defecto solo
// se confia en loopback (cloudflared corre en el mismo equipo); en Railway u otra nube hay que
// indicar cuantos saltos de proxy hay, por ejemplo TRUST_PROXY=1. Ver middleware/limites.js.
const trustProxy = process.env.TRUST_PROXY;
app.set('trust proxy', trustProxy === undefined ? 'loopback'
    : /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

// Railway define RAILWAY_ENVIRONMENT_NAME en cada despliegue, y ahi el trafico siempre es HTTPS.
const detrasDeHttps = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME) || process.env.FORZAR_HTTPS === '1';

// El CSP hay que declararlo a mano: el de helmet por defecto es `default-src 'self'`, que deja
// el panel en pantalla negra porque Flutter Web carga CanvasKit y las fuentes desde gstatic.
// Se abre lo justo para eso y para las URL firmadas de Supabase, no mas.
app.use(helmet({
    // el panel muestra imagenes firmadas de Supabase, que es otro origen
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // El valor por defecto de helmet es `no-referrer`, que borra el Referer de TODO lo que pide el
    // navegador. OpenStreetMap exige un Referer real en las imagenes del mapa y bloquea (403 "Access
    // blocked") a quien lo quita. Con `strict-origin-when-cross-origin` (el valor por defecto de los
    // navegadores) a otros sitios solo viaja el origen, nunca la ruta ni los parametros.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // wasm-unsafe-eval: Flutter Web compila a WebAssembly
            scriptSrc: ["'self'", "'wasm-unsafe-eval'", 'https://www.gstatic.com'],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
            // tile.openstreetmap.org: mapa operativo del panel (flutter_map pide cada tile como imagen o con fetch)
            imgSrc: ["'self'", 'data:', 'blob:', 'https://*.supabase.co', 'https://tile.openstreetmap.org'],
            connectSrc: ["'self'", 'https://*.supabase.co', 'https://fonts.gstatic.com', 'https://www.gstatic.com', 'https://tile.openstreetmap.org'],
            workerSrc: ["'self'", 'blob:'],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            // En Railway todo llega por HTTPS: se obliga al navegador a pedir cada recurso por
            // HTTPS. En desarrollo local (http://localhost) se desactiva, porque rompería todas
            // las llamadas. FORZAR_HTTPS=1 la activa detrás de otro proveedor con HTTPS.
            upgradeInsecureRequests: detrasDeHttps ? [] : null,
        },
    },
}));

// CORS acotado: el panel se sirve desde este mismo backend y la app movil es nativa (no aplica
// CORS), asi que en la practica nadie necesita un origen cruzado. CORS_ORIGENES permite
// habilitar alguno puntual (por ejemplo un `flutter run -d chrome` durante el desarrollo).
const origenesPermitidos = (process.env.CORS_ORIGENES || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
app.use(cors({
    origin: (origin, cb) => {
        // sin Origin: cliente nativo o same-origin, no es una peticion cruzada
        if (!origin) return cb(null, true);
        return cb(null, origenesPermitidos.includes(origin));
    },
}));

app.use(express.json());

// build de produccion del panel web (Flutter Web), servido en la raiz: misma URL que la API
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// Mientras la API se apaga (SIGTERM) o la base no responde, el chequeo da 503: es lo que Railway y
// los balanceadores entienden como "no me mandes trafico" (un 500 se lee como un error de codigo).
let apagando = false;
app.get('/api/health', async (req, res) => {
    if (apagando) return res.status(503).json({ status: 'apagando', db: 'desconocido' });
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', db: 'connected' });
    } catch (err) {
        res.status(503).json({ status: 'error', db: 'disconnected' });
    }
});

app.use('/api/auth', authRouter);
app.use('/api/maquinarias', maquinariasRouter);
app.use('/api/maquinarias', guiasRouter);
app.use('/api/clientes', clientesRouter);
app.use('/api/ordenes-trabajo', ordenesRouter);
app.use('/api/ordenes-trabajo', facturasRouter);
app.use('/api/ordenes-trabajo', evidenciasRouter);
app.use('/api/notificaciones', notificacionesRouter);
app.use('/api/usuarios', usuariosRouter);
app.use('/api/solicitudes', solicitudesRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/mapa', mapaRouter);
app.use('/api/geocodificar', geocodificarRouter);
app.use('/api/insumos', insumosRouter);
app.use('/api/ejecutivos', ejecutivosRouter);
app.use('/api/facturacion', facturacionRouter);
app.use('/api/registro-cliente', registroRouter);
app.use('/api/horometro', horometroRouter);
app.use('/api/checklist', checklistRouter);
app.use('/api/rentabilidad', rentabilidadRouter);
app.use('/api/vehiculos', vehiculosRouter);
app.use('/api/dispositivos', dispositivosRouter);

// una ruta /api inexistente responde 404 JSON (antes de servir el panel y su fallback)
app.use('/api', rutaApiNoEncontrada);

// traduce los rechazos de multer (archivo muy grande, tipo no permitido) a 4xx con
// mensaje entendible; sin esto terminan como un 500 generico
app.use(manejarErroresDeSubida);

// fallback de SPA: cualquier ruta que no sea /api devuelve el index.html del panel web
// (si existe), para que el enrutamiento propio de Flutter Web funcione
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(publicDir, 'index.html'), (err) => {
        if (err) next();
    });
});

app.use(manejarErrores);

const PORT = process.env.PORT || 3000;
let detenerWorker = null;
const servidor = app.listen(PORT, () => {
    console.log(`GOMAQ backend escuchando en puerto ${PORT}`);
    // En produccion el worker corre como servicio aparte (scripts/worker.js) y la API lo apaga con
    // NOTIFICACIONES_EN_PROCESO=0. Por defecto sigue encendido aca: asi el desarrollo local y el CI
    // no cambian. Si el flag quedara mal puesto, el peor caso son dos emisores, y SKIP LOCKED
    // impide que un aviso salga dos veces.
    if (process.env.NOTIFICACIONES_EN_PROCESO !== '0') detenerWorker = iniciarWorker();
});

// Apagado ordenado: con node como proceso 1 (el Dockerfile usa `exec`), sin este manejador Node
// ignora SIGTERM y Railway espera hasta matarlo a la fuerza, cortando las peticiones en curso.
// Se deja de aceptar conexiones, se termina lo que esta en vuelo y se cierra el pool.
async function apagar(senal) {
    if (apagando) return;
    apagando = true;
    console.log(`[api] ${senal} recibida, cerrando`);
    // si algo se cuelga, se sale igual antes de que Railway lo mate
    const tope = setTimeout(() => process.exit(1), 25000);
    tope.unref();
    try {
        servidor.close();
        if (typeof servidor.closeIdleConnections === 'function') servidor.closeIdleConnections();
        if (typeof detenerWorker === 'function') await detenerWorker();
        await new Promise((resolver) => {
            if (!servidor.listening) return resolver();
            servidor.once('close', resolver);
        });
        await pool.end();
        process.exit(0);
    } catch (err) {
        console.error('[api] error al cerrar:', err);
        process.exit(1);
    }
}
process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
