const express = require('express');
require('../utils/asyncErrores');
const { validarCuerpo } = require('../utils/validacion');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/ejecutivos - catalogo de ejecutivos en terreno (Freddy, Oscar, etc.)
router.get('/', verifyToken, requireRole('gerente', 'administrativo'), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM ejecutivos ORDER BY nombre ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar ejecutivos' });
    }
});

// POST /api/ejecutivos - crear ejecutivo
router.post('/', verifyToken, requireRole('gerente', 'administrativo'), async (req, res) => {
    const { nombre } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { nombre: 150 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (!nombre) {
        return res.status(400).json({ error: 'nombre es requerido' });
    }
    try {
        const result = await pool.query('INSERT INTO ejecutivos (nombre) VALUES ($1) RETURNING *', [nombre]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear ejecutivo' });
    }
});

module.exports = router;
