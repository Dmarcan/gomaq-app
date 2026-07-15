const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// POST /api/solicitudes - el cliente reporta una falla o pide mantencion sobre su propia maquinaria
router.post('/', verifyToken, requireRole('cliente'), async (req, res) => {
    const { maquinaria_id, descripcion } = req.body;
    if (!maquinaria_id || !descripcion) {
        return res.status(400).json({ error: 'maquinaria_id y descripcion son requeridos' });
    }
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Su usuario no esta vinculado a ninguna empresa cliente' });
    }
    try {
        const maquinaria = await pool.query(
            'SELECT id FROM maquinarias WHERE id = $1 AND cliente_id = $2',
            [maquinaria_id, req.user.cliente_id]
        );
        if (maquinaria.rows.length === 0) {
            return res.status(403).json({ error: 'Esa maquinaria no pertenece a su empresa' });
        }
        const result = await pool.query(
            'INSERT INTO solicitudes (cliente_id, maquinaria_id, descripcion) VALUES ($1, $2, $3) RETURNING *',
            [req.user.cliente_id, maquinaria_id, descripcion]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear solicitud' });
    }
});

// GET /api/solicitudes - administrativo/gerente revisan las solicitudes de los clientes
router.get('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT s.*, c.nombre AS cliente_nombre, m.codigo AS maquinaria_codigo
             FROM solicitudes s
             JOIN clientes c ON c.id = s.cliente_id
             JOIN maquinarias m ON m.id = s.maquinaria_id
             ORDER BY s.created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar solicitudes' });
    }
});

// PATCH /api/solicitudes/:id/convertir - transforma la solicitud en una Orden de Trabajo real
router.patch('/:id/convertir', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const solicitudResult = await client.query('SELECT * FROM solicitudes WHERE id = $1 FOR UPDATE', [req.params.id]);
        const solicitud = solicitudResult.rows[0];
        if (!solicitud) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Solicitud no encontrada' });
        }
        if (solicitud.estado !== 'pendiente') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Esta solicitud ya fue procesada' });
        }

        const otResult = await client.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, origen, motivo)
             VALUES ($1, $2, 'directo', $3) RETURNING *`,
            [solicitud.maquinaria_id, solicitud.cliente_id, solicitud.descripcion]
        );
        const orden = otResult.rows[0];

        await client.query(
            `UPDATE solicitudes SET estado = 'convertida', orden_trabajo_id = $1 WHERE id = $2`,
            [orden.id, solicitud.id]
        );

        await client.query('COMMIT');
        res.json({ solicitud_id: solicitud.id, orden_trabajo: orden });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al convertir solicitud' });
    } finally {
        client.release();
    }
});

module.exports = router;
