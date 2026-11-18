const express = require('express');
require('../utils/asyncErrores');
const { validarCuerpo } = require('../utils/validacion');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', verifyToken, requireRole('gerente', 'administrativo'), async (req, res) => {
    const result = await pool.query('SELECT * FROM ejecutivos ORDER BY nombre ASC');
    res.json(result.rows);
});

router.post('/', verifyToken, requireRole('gerente', 'administrativo'), async (req, res) => {
    const { nombre } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { nombre: 150 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (!nombre) {
        return res.status(400).json({ error: 'nombre es requerido' });
    }
    const result = await pool.query('INSERT INTO ejecutivos (nombre) VALUES ($1) RETURNING *', [nombre]);
    res.status(201).json(result.rows[0]);
});

module.exports = router;
