const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

const ROLES_VALIDOS = ['gerente', 'administrativo', 'mecanico', 'cliente'];

// GET /api/usuarios?rol=mecanico - listado filtrado por rol (sin exponer password_hash)
router.get('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { rol } = req.query;
    if (rol && !ROLES_VALIDOS.includes(rol)) {
        return res.status(400).json({ error: `rol debe ser uno de: ${ROLES_VALIDOS.join(', ')}` });
    }
    try {
        const result = rol
            ? await pool.query('SELECT id, nombre, email, rol FROM usuarios WHERE rol = $1 ORDER BY nombre', [rol])
            : await pool.query('SELECT id, nombre, email, rol FROM usuarios ORDER BY nombre');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar usuarios' });
    }
});

module.exports = router;
