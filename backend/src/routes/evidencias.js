const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { verificarDuenoOrden } = require('../utils/ordenes');
const { supabase, BUCKET } = require('../config/supabase');

const router = express.Router();

// POST /api/ordenes-trabajo/:id/evidencia/solicitar-upload
// Genera una URL prefirmada de Supabase Storage para que el celular suba la foto directo
router.post('/:id/evidencia/solicitar-upload', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { id } = req.params;
    const { nombre_archivo } = req.body;
    if (!nombre_archivo) {
        return res.status(400).json({ error: 'nombre_archivo es requerido' });
    }
    try {
        const check = await verificarDuenoOrden(id, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });

        const path = `ot-${id}/${Date.now()}-${nombre_archivo}`;
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
        if (error) throw error;

        res.json({ path: data.path, token: data.token, signedUrl: data.signedUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al generar URL de subida' });
    }
});

// POST /api/ordenes-trabajo/:id/evidencia/confirmar
// Registra la evidencia una vez que el archivo ya fue subido directo a Supabase
router.post('/:id/evidencia/confirmar', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { id } = req.params;
    const { path } = req.body;
    if (!path) {
        return res.status(400).json({ error: 'path es requerido' });
    }
    try {
        const check = await verificarDuenoOrden(id, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });

        const result = await pool.query(
            'INSERT INTO evidencias_fotograficas (orden_trabajo_id, path) VALUES ($1, $2) RETURNING *',
            [id, path]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al confirmar evidencia' });
    }
});

// GET /api/ordenes-trabajo/:id/evidencia
// Bucket privado: se genera una URL firmada temporal (1h) por cada foto, en vez de una URL publica permanente
const URL_EXPIRACION_SEGUNDOS = 3600;

router.get('/:id/evidencia', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const { id } = req.params;
    try {
        if (req.user.rol === 'mecanico') {
            const check = await verificarDuenoOrden(id, req.user.id);
            if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
            if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });
        }
        const result = await pool.query(
            'SELECT * FROM evidencias_fotograficas WHERE orden_trabajo_id = $1 ORDER BY created_at DESC',
            [id]
        );

        const conUrlFirmada = await Promise.all(result.rows.map(async (fila) => {
            const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(fila.path, URL_EXPIRACION_SEGUNDOS);
            return { ...fila, url: error ? null : data.signedUrl };
        }));

        res.json(conUrlFirmada);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar evidencia' });
    }
});

module.exports = router;
