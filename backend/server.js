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
const { iniciarWorker } = require('./src/workers/notificaciones');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`GOMAQ backend escuchando en puerto ${PORT}`);
    iniciarWorker();
});
