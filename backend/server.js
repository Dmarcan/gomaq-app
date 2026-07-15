require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./src/config/db');
const maquinariasRouter = require('./src/routes/maquinarias');
const authRouter = require('./src/routes/auth');
const clientesRouter = require('./src/routes/clientes');
const ordenesRouter = require('./src/routes/ordenes');

const app = express();
app.use(cors());
app.use(express.json());

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
app.use('/api/clientes', clientesRouter);
app.use('/api/ordenes-trabajo', ordenesRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`GOMAQ backend escuchando en puerto ${PORT}`);
});
