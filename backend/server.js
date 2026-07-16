require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
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
const { iniciarWorker } = require('./src/workers/notificaciones');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

// fallback de SPA: cualquier ruta que no sea /api ni /uploads devuelve el index.html
// del panel web (si existe), para que el enrutamiento propio de Flutter Web funcione
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(publicDir, 'index.html'), (err) => {
        if (err) next();
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`GOMAQ backend escuchando en puerto ${PORT}`);
    iniciarWorker();
});
