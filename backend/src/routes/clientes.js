const express = require('express');
require('../utils/asyncErrores');
const { validarCuerpo } = require('../utils/validacion');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { validarCoordenadas } = require('../utils/geo');
const { rutValido, MENSAJE_RUT_INVALIDO } = require('../utils/rut');

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
    const errCuerpo = validarCuerpo(req.body, { textos: { nombre: 150, rut: 20, email: 150, telefono: 30 }, ids: ['ejecutivo_id'] });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (!nombre) {
        return res.status(400).json({ error: 'nombre es requerido' });
    }
    // un RUT vacio sigue siendo opcional; si viene, debe tener el digito verificador correcto
    if (typeof rut === 'string' && rut.trim() && !rutValido(rut)) {
        return res.status(400).json({ error: MENSAJE_RUT_INVALIDO });
    }
    const coords = validarCoordenadas(req.body.latitud, req.body.longitud);
    if (!coords.ok) return res.status(400).json({ error: coords.error });
    try {
        const result = await pool.query(
            `INSERT INTO clientes (nombre, rut, email, telefono, ejecutivo_id, latitud, longitud)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [nombre, rut || null, email || null, telefono || null, ejecutivo_id || null, coords.latitud, coords.longitud]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear cliente' });
    }
});

// PATCH /api/clientes/:id/ubicacion - fija o corrige la ubicacion de la empresa.
// Sin coordenadas (las dos en null) la borra. Solo cambia la ubicacion de la ficha: las OT ya
// creadas conservan el destino con que se crearon.
router.patch('/:id/ubicacion', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Cliente invalido' });
    }
    const coords = validarCoordenadas(req.body.latitud, req.body.longitud);
    if (!coords.ok) return res.status(400).json({ error: coords.error });
    try {
        const result = await pool.query(
            'UPDATE clientes SET latitud = $1, longitud = $2 WHERE id = $3 RETURNING id, nombre, latitud, longitud',
            [coords.latitud, coords.longitud, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Cliente no encontrado' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar la ubicacion' });
    }
});

module.exports = router;
