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
    // ot_abiertas: cuantas ordenes de trabajo no finalizadas tiene asignadas cada usuario
    // (solo es relevante para mecanicos, pero se calcula igual para cualquier rol sin costo extra)
    const selectConOtAbiertas = `
        SELECT u.id, u.nombre, u.email, u.rol,
               COALESCE(ot.abiertas, 0) AS ot_abiertas
        FROM usuarios u
        LEFT JOIN (
            SELECT mecanico_id, COUNT(*) AS abiertas
            FROM ordenes_trabajo
            WHERE mecanico_id IS NOT NULL AND estado != 'finalizada'
            GROUP BY mecanico_id
        ) ot ON ot.mecanico_id = u.id
    `;
    try {
        const result = rol
            ? await pool.query(`${selectConOtAbiertas} WHERE u.rol = $1 ORDER BY u.nombre`, [rol])
            : await pool.query(`${selectConOtAbiertas} ORDER BY u.nombre`);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar usuarios' });
    }
});

module.exports = router;
