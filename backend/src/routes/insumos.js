const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/insumos - catalogo completo (mecanico lo usa para el picker de consumo)
router.get('/', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM insumos ORDER BY nombre ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar insumos' });
    }
});

// POST /api/insumos - crear item de catalogo
router.post('/', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { nombre, unidad_medida, costo_unitario } = req.body;
    if (!nombre || !unidad_medida) {
        return res.status(400).json({ error: 'nombre y unidad_medida son requeridos' });
    }
    try {
        const result = await pool.query(
            `INSERT INTO insumos (nombre, unidad_medida, costo_unitario) VALUES ($1, $2, $3) RETURNING *`,
            [nombre, unidad_medida, costo_unitario || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear insumo' });
    }
});

// PATCH /api/insumos/:id - editar nombre/unidad/costo
router.patch('/:id', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { nombre, unidad_medida, costo_unitario } = req.body;
    try {
        const result = await pool.query(
            `UPDATE insumos SET
                nombre = COALESCE($1, nombre),
                unidad_medida = COALESCE($2, unidad_medida),
                costo_unitario = COALESCE($3, costo_unitario)
             WHERE id = $4 RETURNING *`,
            [nombre || null, unidad_medida || null, costo_unitario || null, req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Insumo no encontrado' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar insumo' });
    }
});

// POST /api/insumos/:id/ingreso - suma stock (compra de insumo)
router.post('/:id/ingreso', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { cantidad } = req.body;
    if (!cantidad || isNaN(cantidad) || Number(cantidad) <= 0) {
        return res.status(400).json({ error: 'cantidad (numerica positiva) es requerida' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE insumos SET stock_actual = stock_actual + $1 WHERE id = $2 RETURNING *`,
            [cantidad, req.params.id]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Insumo no encontrado' });
        }
        await client.query(
            `INSERT INTO movimientos_insumo (insumo_id, cantidad, tipo, usuario_id) VALUES ($1, $2, 'ingreso', $3)`,
            [req.params.id, cantidad, req.user.id]
        );
        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al registrar ingreso de stock' });
    } finally {
        client.release();
    }
});

// GET /api/insumos/movimientos - consumos recientes, con datos de OT/insumo/usuario para auditoria
router.get('/movimientos', verifyToken, requireRole('gerente', 'administrativo'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT mi.*, i.nombre AS insumo_nombre, i.unidad_medida, u.nombre AS usuario_nombre,
                    m.codigo AS maquinaria_codigo
             FROM movimientos_insumo mi
             JOIN insumos i ON i.id = mi.insumo_id
             LEFT JOIN usuarios u ON u.id = mi.usuario_id
             LEFT JOIN ordenes_trabajo ot ON ot.id = mi.orden_trabajo_id
             LEFT JOIN maquinarias m ON m.id = ot.maquinaria_id
             ORDER BY mi.created_at DESC
             LIMIT 100`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar movimientos de insumos' });
    }
});

// GET /api/insumos/orden/:ordenId - insumos consumidos por una OT puntual
router.get('/orden/:ordenId', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT mi.*, i.nombre AS insumo_nombre, i.unidad_medida
             FROM movimientos_insumo mi
             JOIN insumos i ON i.id = mi.insumo_id
             WHERE mi.orden_trabajo_id = $1 AND mi.tipo = 'salida'
             ORDER BY mi.created_at DESC`,
            [req.params.ordenId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar insumos de la orden' });
    }
});

// POST /api/insumos/orden/:ordenId - registrar consumo de insumo en una OT (descuenta stock)
router.post('/orden/:ordenId', verifyToken, requireRole('mecanico', 'administrativo'), async (req, res) => {
    const { insumo_id, cantidad } = req.body;
    if (!insumo_id || !cantidad || isNaN(cantidad) || Number(cantidad) <= 0) {
        return res.status(400).json({ error: 'insumo_id y cantidad (numerica positiva) son requeridos' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const insumoResult = await client.query(
            `UPDATE insumos SET stock_actual = stock_actual - $1 WHERE id = $2 RETURNING *`,
            [cantidad, insumo_id]
        );
        if (insumoResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Insumo no encontrado' });
        }
        const movimiento = await client.query(
            `INSERT INTO movimientos_insumo (insumo_id, orden_trabajo_id, cantidad, tipo, usuario_id)
             VALUES ($1, $2, $3, 'salida', $4) RETURNING *`,
            [insumo_id, req.params.ordenId, cantidad, req.user.id]
        );
        await client.query('COMMIT');
        res.status(201).json(movimiento.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al registrar consumo de insumo' });
    } finally {
        client.release();
    }
});

module.exports = router;
