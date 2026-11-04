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
    if (!/^\d{1,9}$/.test(String(req.params.id))) return res.status(400).json({ error: 'Id de notificación inválido' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const actual = await client.query(
            `SELECT id, payload FROM notificaciones_pendientes WHERE id = $1 AND estado = 'error' FOR UPDATE`,
            [req.params.id]
        );
        if (actual.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Notificación no encontrada o no está en error' });
        }
        // el correo de una factura solo se reintenta si sigue valiendo: la factura existe, no cambio de
        // folio ni de monto desde que se encolo y no hay otro envio de la misma factura esperando salir
        const payload = actual.rows[0].payload || {};
        if (payload.tipo === 'factura_emitida' && payload.factura_id) {
            const factura = await client.query(
                'SELECT folio, monto FROM facturas WHERE id = $1 FOR SHARE', [payload.factura_id]);
            if (factura.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'La factura ya no existe: este correo no se puede reintentar' });
            }
            const montoIgual = Number(factura.rows[0].monto ?? 0) === Number(payload.monto ?? 0);
            if (String(factura.rows[0].folio) !== String(payload.folio) || !montoIgual) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'La factura cambió desde que se encoló este correo: autoriza el envío de nuevo' });
            }
            const otro = await client.query(
                `SELECT 1 FROM notificaciones_pendientes
                 WHERE estado = 'pendiente' AND id <> $1 AND payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $2::text LIMIT 1`,
                [req.params.id, payload.factura_id]
            );
            if (otro.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Esta factura ya tiene otro envío pendiente' });
            }
        }
        const result = await client.query(
            `UPDATE notificaciones_pendientes
             SET estado = 'pendiente', intentos = 0, ultimo_error = NULL, proximo_intento = now()
             WHERE id = $1 AND estado = 'error'
             RETURNING *`,
            [req.params.id]
        );
        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al reintentar la notificación' });
    } finally {
        client.release();
    }
});

module.exports = router;
