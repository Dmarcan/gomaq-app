const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// POST /api/ordenes-trabajo - crear OT
router.post('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { maquinaria_id, cliente_id, origen, motivo, facturable } = req.body;
    if (!maquinaria_id) {
        return res.status(400).json({ error: 'maquinaria_id es requerido' });
    }
    try {
        const result = await pool.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, origen, motivo, facturable)
             VALUES ($1, $2, COALESCE($3::origen_orden, 'directo'), $4, COALESCE($5, false))
             RETURNING *`,
            [maquinaria_id, cliente_id || null, origen || null, motivo || null, facturable]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear orden de trabajo' });
    }
});

// GET /api/ordenes-trabajo - listar (mecanico solo ve las suyas)
router.get('/', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        let query = `SELECT ot.*, m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre
                      FROM ordenes_trabajo ot
                      JOIN maquinarias m ON m.id = ot.maquinaria_id
                      LEFT JOIN clientes c ON c.id = ot.cliente_id`;
        const params = [];
        if (req.user.rol === 'mecanico') {
            query += ' WHERE ot.mecanico_id = $1';
            params.push(req.user.id);
        }
        query += ' ORDER BY ot.fecha_creacion DESC';

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar ordenes de trabajo' });
    }
});

// GET /api/ordenes-trabajo/:id - detalle
router.get('/:id', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT ot.*, m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre
             FROM ordenes_trabajo ot
             JOIN maquinarias m ON m.id = ot.maquinaria_id
             LEFT JOIN clientes c ON c.id = ot.cliente_id
             WHERE ot.id = $1`,
            [req.params.id]
        );
        const orden = result.rows[0];
        if (!orden) {
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        if (req.user.rol === 'mecanico' && orden.mecanico_id !== req.user.id) {
            return res.status(403).json({ error: 'No tiene permiso para ver esta orden' });
        }
        res.json(orden);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar orden de trabajo' });
    }
});

// PATCH /api/ordenes-trabajo/:id/asignar - asignar mecanico
router.patch('/:id/asignar', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { mecanico_id } = req.body;
    if (!mecanico_id) {
        return res.status(400).json({ error: 'mecanico_id es requerido' });
    }
    try {
        const mecanico = await pool.query('SELECT id FROM usuarios WHERE id = $1 AND rol = $2', [mecanico_id, 'mecanico']);
        if (mecanico.rows.length === 0) {
            return res.status(400).json({ error: 'mecanico_id no corresponde a un usuario con rol mecanico' });
        }
        const result = await pool.query(
            `UPDATE ordenes_trabajo SET mecanico_id = $1, estado = 'asignada' WHERE id = $2 RETURNING *`,
            [mecanico_id, req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al asignar mecanico' });
    }
});

// helper: verifica que la OT pertenezca al mecanico autenticado
async function ordenPerteneceAMecanico(ordenId, mecanicoId) {
    const result = await pool.query('SELECT mecanico_id FROM ordenes_trabajo WHERE id = $1', [ordenId]);
    if (result.rows.length === 0) return { existe: false };
    return { existe: true, esDueno: result.rows[0].mecanico_id === mecanicoId };
}

// PATCH /api/ordenes-trabajo/:id/diagnostico - mecanico registra diagnostico y avanza estado
router.patch('/:id/diagnostico', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { diagnostico, estado } = req.body;
    const estadosValidos = ['en_terreno', 'en_reparacion'];
    if (estado && !estadosValidos.includes(estado)) {
        return res.status(400).json({ error: `estado debe ser uno de: ${estadosValidos.join(', ')}` });
    }
    try {
        const check = await ordenPerteneceAMecanico(req.params.id, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });

        const result = await pool.query(
            `UPDATE ordenes_trabajo
             SET diagnostico = COALESCE($1, diagnostico), estado = COALESCE($2, estado)
             WHERE id = $3 RETURNING *`,
            [diagnostico || null, estado || null, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar diagnostico' });
    }
});

// PATCH /api/ordenes-trabajo/:id/finalizar - mecanico cierra la OT
router.patch('/:id/finalizar', verifyToken, requireRole('mecanico'), async (req, res) => {
    try {
        const check = await ordenPerteneceAMecanico(req.params.id, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });

        const result = await pool.query(
            `UPDATE ordenes_trabajo SET estado = 'finalizada', fecha_cierre = now() WHERE id = $1 RETURNING *`,
            [req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al finalizar orden de trabajo' });
    }
});

// PATCH /api/ordenes-trabajo/:id/valorizacion - gerente aprueba monto (HU-04)
router.patch('/:id/valorizacion', verifyToken, requireRole('gerente'), async (req, res) => {
    const { valorizacion } = req.body;
    if (valorizacion === undefined || isNaN(valorizacion)) {
        return res.status(400).json({ error: 'valorizacion (numerica) es requerida' });
    }
    try {
        const result = await pool.query(
            `UPDATE ordenes_trabajo
             SET valorizacion = $1, valorizacion_aprobada_por = $2, facturable = true
             WHERE id = $3 RETURNING *`,
            [valorizacion, req.user.id, req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al aprobar valorizacion' });
    }
});

module.exports = router;
