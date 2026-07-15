const express = require('express');
const multer = require('multer');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { supabase, BUCKET_EQUIPOS } = require('../config/supabase');

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });
const URL_EXPIRACION_SEGUNDOS = 3600;

async function conFotoFirmada(fila) {
    if (!fila.foto_url) return fila;
    const { data, error } = await supabase.storage.from(BUCKET_EQUIPOS).createSignedUrl(fila.foto_url, URL_EXPIRACION_SEGUNDOS);
    return { ...fila, foto_url: error ? null : data.signedUrl };
}

// GET /api/maquinarias - listado con estado (HU-02)
// Permisos (Tabla 6.1): Gerente=Lectura, Administrativo=Lectura/Escritura, Mecanico=Lectura, Cliente=Denegado
router.get('/', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT m.id, m.codigo, m.tipo, m.estado, m.ubicacion, m.foto_url, c.nombre AS cliente
             FROM maquinarias m
             LEFT JOIN clientes c ON c.id = m.cliente_id
             ORDER BY m.codigo`
        );
        res.json(await Promise.all(result.rows.map(conFotoFirmada)));
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
            'SELECT id, codigo, tipo, estado, ubicacion, foto_url FROM maquinarias WHERE cliente_id = $1 ORDER BY codigo',
            [req.user.cliente_id]
        );
        res.json(await Promise.all(result.rows.map(conFotoFirmada)));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar su flota' });
    }
});

// GET /api/maquinarias/:id - perfil completo del equipo (ficha tecnica)
router.get('/:id', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT m.*, c.nombre AS cliente
             FROM maquinarias m
             LEFT JOIN clientes c ON c.id = m.cliente_id
             WHERE m.id = $1`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }
        res.json(await conFotoFirmada(result.rows[0]));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar la maquinaria' });
    }
});

// GET /api/maquinarias/:id/ordenes-trabajo - historial simple de OTs del equipo
router.get('/:id/ordenes-trabajo', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, estado, motivo, diagnostico, fecha_creacion, fecha_cierre
             FROM ordenes_trabajo WHERE maquinaria_id = $1 ORDER BY fecha_creacion DESC`,
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar el historial de la maquinaria' });
    }
});

// POST /api/maquinarias - crear maquinaria (con ficha tecnica y foto opcional)
// Permisos: Administrativo tiene Lectura/Escritura sobre Control de Flota
router.post('/', verifyToken, requireRole('administrativo'), upload.single('archivo'), async (req, res) => {
    const {
        codigo, tipo, cliente_id, ubicacion,
        categoria_equipo, marca, modelo, anio, descripcion,
        numero_serie, numero_motor, numero_chasis, numero_mastil,
        capacidad_carga, altura_trabajo, tipo_combustible,
    } = req.body;
    if (!codigo || !tipo) {
        return res.status(400).json({ error: 'codigo y tipo son requeridos' });
    }
    try {
        let fotoPath = null;
        if (req.file) {
            fotoPath = `equipos/${codigo}/${Date.now()}-${req.file.originalname}`;
            const { error: errorSubida } = await supabase.storage
                .from(BUCKET_EQUIPOS)
                .upload(fotoPath, req.file.buffer, { contentType: req.file.mimetype });
            if (errorSubida) throw errorSubida;
        }

        const result = await pool.query(
            `INSERT INTO maquinarias (
                codigo, tipo, cliente_id, ubicacion, foto_url,
                categoria_equipo, marca, modelo, anio, descripcion,
                numero_serie, numero_motor, numero_chasis, numero_mastil,
                capacidad_carga, altura_trabajo, tipo_combustible
             ) VALUES ($1, $2, $3, $4, $5, $6::categoria_equipo, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::tipo_combustible_maquinaria)
             RETURNING *`,
            [
                codigo, tipo, cliente_id || null, ubicacion || null, fotoPath,
                categoria_equipo || null, marca || null, modelo || null, anio || null, descripcion || null,
                numero_serie || null, numero_motor || null, numero_chasis || null, numero_mastil || null,
                capacidad_carga || null, altura_trabajo || null, tipo_combustible || null,
            ]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear maquinaria' });
    }
});

// PATCH /api/maquinarias/:id/foto - reemplazar solo la foto de la ficha tecnica
router.patch('/:id/foto', verifyToken, requireRole('administrativo'), upload.single('archivo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'archivo (imagen) es requerido' });
    }
    try {
        const actual = await pool.query('SELECT codigo FROM maquinarias WHERE id = $1', [req.params.id]);
        if (actual.rows.length === 0) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }

        const fotoPath = `equipos/${actual.rows[0].codigo}/${Date.now()}-${req.file.originalname}`;
        const { error: errorSubida } = await supabase.storage
            .from(BUCKET_EQUIPOS)
            .upload(fotoPath, req.file.buffer, { contentType: req.file.mimetype });
        if (errorSubida) throw errorSubida;

        const result = await pool.query('UPDATE maquinarias SET foto_url = $1 WHERE id = $2 RETURNING *', [fotoPath, req.params.id]);
        res.json(await conFotoFirmada(result.rows[0]));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar la foto' });
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
