// Catalogo de insumos y stock del furgon del mecanico.
const express = require('express');
require('../../utils/asyncErrores');
const pool = require('../../config/db');
const { verifyToken, requireRole } = require('../../middleware/auth');
const { validarIdsEnRuta, validarCuerpo } = require('../../utils/validacion');
const { esIdPositivo, montoEnteroONulo } = require('../../utils/auditoriaLinea');
const { num } = require('../../utils/valores');
const { bodegaCentral, furgonDe } = require('./comun');

const router = express.Router();
validarIdsEnRuta(router, ['id', 'ordenId', 'lineaId']);

// catalogo completo (mecanico lo usa para el picker de consumo).
// Ademas de stock_actual (el total) trae cuanto hay en la bodega central y, para un mecanico,
// en su furgon: al cargar repuestos necesita ver "bodega: X / furgon: Y" antes de elegir.
router.get('/', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const bodega = await bodegaCentral(pool);
    const furgon = req.user.rol === 'mecanico' ? await furgonDe(pool, req.user.id) : null;
    const result = await pool.query(
        `SELECT i.*,
                    COALESCE(sb.cantidad, 0) AS stock_bodega,
                    COALESCE(sf.cantidad, 0) AS stock_furgon
             FROM insumos i
             LEFT JOIN stock_ubicacion sb ON sb.insumo_id = i.id AND sb.ubicacion_id = $1
             LEFT JOIN stock_ubicacion sf ON sf.insumo_id = i.id AND sf.ubicacion_id = $2
             ORDER BY i.nombre ASC`,
        [bodega, furgon]
    );
    res.json(result.rows.map((f) => ({ ...f, stock_bodega: num(f.stock_bodega), stock_furgon: num(f.stock_furgon) })));
});

router.post('/', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { nombre, unidad_medida, costo_unitario } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { nombre: 150, unidad_medida: 20 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (!nombre || !unidad_medida) {
        return res.status(400).json({ error: 'nombre y unidad_medida son requeridos' });
    }
    const vacio = costo_unitario === undefined || costo_unitario === null || costo_unitario === '';
    if (!vacio && montoEnteroONulo(costo_unitario) === null) {
        return res.status(400).json({ error: 'El costo debe ser un monto entero en pesos, mayor o igual a 0' });
    }
    const result = await pool.query(
        `INSERT INTO insumos (nombre, unidad_medida, costo_unitario) VALUES ($1, $2, $3) RETURNING *`,
        [nombre, unidad_medida, vacio ? null : montoEnteroONulo(costo_unitario)]
    );
    res.status(201).json(result.rows[0]);
});

router.patch('/:id', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { nombre, unidad_medida, costo_unitario } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { nombre: 150, unidad_medida: 20 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (!esIdPositivo(req.params.id)) return res.status(400).json({ error: 'Id de insumo inválido' });
    const sinCosto = costo_unitario === undefined || costo_unitario === null || costo_unitario === '';
    if (!sinCosto && montoEnteroONulo(costo_unitario) === null) {
        return res.status(400).json({ error: 'El costo debe ser un monto entero en pesos, mayor o igual a 0' });
    }
    const result = await pool.query(
        `UPDATE insumos SET
                nombre = COALESCE($1, nombre),
                unidad_medida = COALESCE($2, unidad_medida),
                costo_unitario = COALESCE($3, costo_unitario)
             WHERE id = $4 RETURNING *`,
        [nombre || null, unidad_medida || null, sinCosto ? null : montoEnteroONulo(costo_unitario), req.params.id]
    );
    if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Insumo no encontrado' });
    }
    res.json(result.rows[0]);
});

router.get('/mi-furgon', verifyToken, requireRole('mecanico'), async (req, res) => {
    try {
        const furgon = await furgonDe(pool, req.user.id);
        if (!furgon) {
            // no es error: puede que todavia no le hayan asignado vehiculo
            return res.json({ ubicacion_id: null, items: [] });
        }
        const result = await pool.query(
            `SELECT su.insumo_id, su.cantidad, i.nombre, i.unidad_medida
             FROM stock_ubicacion su
             JOIN insumos i ON i.id = su.insumo_id
             WHERE su.ubicacion_id = $1 AND su.cantidad <> 0
             ORDER BY i.nombre`,
            [furgon]
        );
        res.json({
            ubicacion_id: furgon,
            items: result.rows.map((f) => ({ ...f, cantidad: num(f.cantidad) })),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar el stock de tu furgón' });
    }
});

module.exports = router;
