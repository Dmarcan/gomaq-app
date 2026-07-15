require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./src/config/db');
const maquinariasRouter = require('./src/routes/maquinarias');

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

app.use('/api/maquinarias', maquinariasRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`GOMAQ backend escuchando en puerto ${PORT}`);
});
