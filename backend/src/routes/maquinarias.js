const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/maquinarias - listado con estado (HU-02)
// Permisos (Tabla 6.1): Gerente=Lectura, Administrativo=Lectura/Escritura, Mecanico=Lectura, Cliente=Denegado
router.get('/', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT m.id, m.codigo, m.tipo, m.estado, m.ubicacion, c.nombre AS cliente
             FROM maquinarias m
             LEFT JOIN clientes c ON c.id = m.cliente_id
             ORDER BY m.codigo`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar maquinarias' });
    }
});

// GET /api/maquinarias/mias - portal cliente: solo su propia flota
router.get('/mias', verifyToken, requireRole('cliente'), async (req, res) => {
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Su usuario no esta vinculado a ninguna empresa cliente' });
    }
    try {
        const result = await pool.query(
            'SELECT id, codigo, tipo, estado, ubicacion FROM maquinarias WHERE cliente_id = $1 ORDER BY codigo',
            [req.user.cliente_id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar su flota' });
    }
});

// POST /api/maquinarias - crear maquinaria
// Permisos: Administrativo tiene Lectura/Escritura sobre Control de Flota
router.post('/', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { codigo, tipo, cliente_id, ubicacion } = req.body;
    if (!codigo || !tipo) {
        return res.status(400).json({ error: 'codigo y tipo son requeridos' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO maquinarias (codigo, tipo, cliente_id, ubicacion) VALUES ($1, $2, $3, $4) RETURNING *',
            [codigo, tipo, cliente_id || null, ubicacion || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear maquinaria' });
    }
});

// PATCH /api/maquinarias/:id/estado - actualizar estado (mecanico reporta)
// Permisos: Mecanico y Administrativo pueden escribir; Gerente solo lectura, Cliente denegado
router.patch('/:id/estado', verifyToken, requireRole('mecanico', 'administrativo'), async (req, res) => {
    const { id } = req.params;
    const { estado } = req.body;
    const validos = ['operativa', 'en_mantencion', 'fuera_de_servicio'];
    if (!validos.includes(estado)) {
        return res.status(400).json({ error: 'Estado invalido' });
    }
    try {
        const result = await pool.query(
            'UPDATE maquinarias SET estado = $1 WHERE id = $2 RETURNING *',
            [estado, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar estado' });
    }
});

module.exports = router;
