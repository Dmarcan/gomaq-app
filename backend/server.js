// zona horaria fija del negocio: los calculos de dias de arriendo (HORA_CORTE, cortes de
// dia calendario) usan la hora local del proceso - fijarla evita que una migracion a un
// servidor en UTC (Railway/nube) corra silenciosamente todos los cobros 4 horas.
// Si el negocio alguna vez opera en varias zonas, migrar a una libreria de zonas (luxon).
process.env.TZ = 'America/Santiago';

require('dotenv').config();

// Arranque a prueba de fallos, ANTES de cargar nada mas: sin estas variables el servidor
// arrancaba igual y fallaba recien al primer login, con un 500 que no explicaba nada (o
// reventaba con un error de Supabase sin contexto). Mejor no partir y decir cual falta.
const VARIABLES_REQUERIDAS = ['DATABASE_URL', 'JWT_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const faltantes = VARIABLES_REQUERIDAS.filter((v) => !process.env[v]);
if (faltantes.length > 0) {
    console.error(`Faltan variables de entorno obligatorias: ${faltantes.join(', ')}. Revisa el .env`);
    process.exit(1);
}

const path = require('path');
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
const insumosRouter = require('./src/routes/insumos');
const ejecutivosRouter = require('./src/routes/ejecutivos');
const facturacionRouter = require('./src/routes/facturacion');
const registroRouter = require('./src/routes/registro');
const { router: horometroRouter } = require('./src/routes/horometro');
const checklistRouter = require('./src/routes/checklist');
const rentabilidadRouter = require('./src/routes/rentabilidad');
const vehiculosRouter = require('./src/routes/vehiculos');
const { iniciarWorker } = require('./src/workers/notificaciones');
const { manejarErroresDeSubida } = require('./src/middleware/upload');

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

// Cabeceras de seguridad.
//
// El CSP hay que declararlo a mano: el de helmet por defecto es `default-src 'self'`, que deja
// el panel en pantalla negra porque Flutter Web carga CanvasKit y las fuentes desde gstatic.
// Se abre lo justo para eso y para las URL firmadas de Supabase, no mas.
app.use(helmet({
    // el panel muestra imagenes firmadas de Supabase, que es otro origen
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // wasm-unsafe-eval: Flutter Web compila a WebAssembly
            scriptSrc: ["'self'", "'wasm-unsafe-eval'", 'https://www.gstatic.com'],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
            imgSrc: ["'self'", 'data:', 'blob:', 'https://*.supabase.co'],
            connectSrc: ["'self'", 'https://*.supabase.co', 'https://fonts.gstatic.com', 'https://www.gstatic.com'],
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

// build de produccion del panel web (Flutter Web), servido en la raiz para
// reutilizar la misma URL/tunel que la API (ver `npm run build:web` / db/README)
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', db: 'connected' });
    } catch (err) {
        res.status(500).json({ status: 'error', db: 'disconnected' });
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
app.use('/api/insumos', insumosRouter);
app.use('/api/ejecutivos', ejecutivosRouter);
app.use('/api/facturacion', facturacionRouter);
app.use('/api/registro-cliente', registroRouter);
app.use('/api/horometro', horometroRouter);
app.use('/api/checklist', checklistRouter);
app.use('/api/rentabilidad', rentabilidadRouter);
app.use('/api/vehiculos', vehiculosRouter);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`GOMAQ backend escuchando en puerto ${PORT}`);
    iniciarWorker();
});
