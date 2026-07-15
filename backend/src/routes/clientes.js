const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/clientes - listado
router.get('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM clientes ORDER BY nombre');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar clientes' });
    }
});

// POST /api/clientes - crear cliente
router.post('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { nombre, rut, email, telefono, ejecutivo_id } = req.body;
    if (!nombre) {
        return res.status(400).json({ error: 'nombre es requerido' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO clientes (nombre, rut, email, telefono, ejecutivo_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [nombre, rut || null, email || null, telefono || null, ejecutivo_id || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear cliente' });
    }
});

module.exports = router;
