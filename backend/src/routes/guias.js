const express = require('express');
const multer = require('multer');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

// POST /api/maquinarias/:id/guias - subir guia de despacho o recepcion (PDF va a Supabase Storage)
router.post('/:id/guias', verifyToken, requireRole('administrativo'), upload.single('archivo'), async (req, res) => {
    const { id } = req.params;
    const { tipo, fecha } = req.body;
    const validos = ['despacho', 'recepcion'];
    if (!validos.includes(tipo)) {
        return res.status(400).json({ error: `tipo debe ser uno de: ${validos.join(', ')}` });
    }
    if (!req.file) {
        return res.status(400).json({ error: 'archivo (PDF) es requerido' });
    }
    try {
        const rutaStorage = `guias/${id}/${Date.now()}-${req.file.originalname}`;
        const { error: errorSubida } = await supabase.storage
            .from(BUCKET_DOCUMENTOS)
            .upload(rutaStorage, req.file.buffer, { contentType: req.file.mimetype });
        if (errorSubida) throw errorSubida;

        const result = await pool.query(
            `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha)
             VALUES ($1, $2::tipo_guia, $3, COALESCE($4, CURRENT_DATE))
             RETURNING *`,
            [id, tipo, rutaStorage, fecha || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al subir guia' });
    }
});

// GET /api/maquinarias/:id/dias-arriendo - calculo automatico (HU-01)
router.get('/:id/dias-arriendo', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const { id } = req.params;
    try {
        const despachoResult = await pool.query(
            `SELECT * FROM guias WHERE maquinaria_id = $1 AND tipo = 'despacho' ORDER BY fecha DESC LIMIT 1`,
            [id]
        );
        const despacho = despachoResult.rows[0];
        if (!despacho) {
            return res.json({ dias_transcurridos: 0, facturacion_bloqueada: false, mensaje: 'No hay guia de despacho registrada' });
        }

        const recepcionResult = await pool.query(
            `SELECT * FROM guias WHERE maquinaria_id = $1 AND tipo = 'recepcion' AND fecha >= $2 ORDER BY fecha ASC LIMIT 1`,
            [id, despacho.fecha]
        );
        const recepcion = recepcionResult.rows[0];

        const fechaDespacho = new Date(despacho.fecha);
        const fechaFin = recepcion ? new Date(recepcion.fecha) : new Date();
        const diasTranscurridos = Math.max(0, Math.round((fechaFin - fechaDespacho) / (1000 * 60 * 60 * 24)));

        let facturacionBloqueada = false;
        if (!recepcion) {
            const limite = new Date(fechaDespacho.getFullYear(), fechaDespacho.getMonth() + 1, 5);
            facturacionBloqueada = new Date() > limite;
        }

        res.json({
            maquinaria_id: Number(id),
            fecha_despacho: despacho.fecha,
            fecha_recepcion: recepcion ? recepcion.fecha : null,
            dias_transcurridos: diasTranscurridos,
            facturacion_bloqueada: facturacionBloqueada,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al calcular dias de arriendo' });
    }
});

module.exports = router;
