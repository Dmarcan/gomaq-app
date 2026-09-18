const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/notificaciones - listado (para reenvio manual / seguimiento de errores)
router.get('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM notificaciones_pendientes ORDER BY created_at DESC LIMIT 100'
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar notificaciones' });
    }
});

// POST /api/notificaciones/:id/reintentar - devuelve una notificacion en error a la cola
// del worker (reinicia intentos y backoff). Solo aplica a las que ya agotaron reintentos.
router.post('/:id/reintentar', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE notificaciones_pendientes
             SET estado = 'pendiente', intentos = 0, ultimo_error = NULL, proximo_intento = now()
             WHERE id = $1 AND estado = 'error'
             RETURNING *`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Notificación no encontrada o no está en error' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al reintentar la notificación' });
    }
});

module.exports = router;
