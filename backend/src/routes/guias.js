const express = require('express');
const multer = require('multer');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

// hora (24h) a partir de la cual el dia de despacho ya no cuenta como dia de arriendo
// (entrevista la administrativa: "si se fue a las 10 de la manana se cobra ese dia, si se fue a las 3
// de la tarde no se cobra ese dia" - valor pendiente de confirmar el corte exacto con ella)
const HORA_CORTE = 13;

// POST /api/maquinarias/:id/guias - subir guia de despacho o recepcion (PDF va a Supabase Storage)
router.post('/:id/guias', verifyToken, requireRole('administrativo'), upload.single('archivo'), async (req, res) => {
    const { id } = req.params;
    const { tipo, fecha_hora, fallido } = req.body;
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
            `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, fallido)
             VALUES ($1, $2::tipo_guia, $3, COALESCE($4, now()), COALESCE($5, false))
             RETURNING *`,
            [id, tipo, rutaStorage, fecha_hora || null, fallido === 'true' || fallido === true]
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
            `SELECT * FROM guias WHERE maquinaria_id = $1 AND tipo = 'despacho' AND fallido = false ORDER BY fecha DESC LIMIT 1`,
            [id]
        );
        const despacho = despachoResult.rows[0];
        if (!despacho) {
            return res.json({ dias_transcurridos: 0, facturacion_bloqueada: false, mensaje: 'No hay guia de despacho registrada' });
        }

        const recepcionResult = await pool.query(
            `SELECT * FROM guias WHERE maquinaria_id = $1 AND tipo = 'recepcion' AND fallido = false AND fecha >= $2 ORDER BY fecha ASC LIMIT 1`,
            [id, despacho.fecha]
        );
        const recepcion = recepcionResult.rows[0];

        // si el despacho salio a partir de HORA_CORTE, ese dia no se cobra: el conteo parte al dia siguiente
        const inicioCobro = new Date(despacho.fecha);
        if (inicioCobro.getHours() >= HORA_CORTE) {
            inicioCobro.setDate(inicioCobro.getDate() + 1);
        }
        inicioCobro.setHours(0, 0, 0, 0);

        const fechaFin = recepcion ? new Date(recepcion.fecha) : new Date();
        const diasTranscurridos = Math.max(0, Math.round((fechaFin - inicioCobro) / (1000 * 60 * 60 * 24)));

        let facturacionBloqueada = false;
        if (!recepcion) {
            const limite = new Date(inicioCobro.getFullYear(), inicioCobro.getMonth() + 1, 5);
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
