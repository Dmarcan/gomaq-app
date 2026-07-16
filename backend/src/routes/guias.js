const express = require('express');
const multer = require('multer');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { calcularInicioCobro, calcularDiasTranscurridos } = require('../utils/diasArriendo');
const { leerTextoPdf } = require('../utils/leerTextoPdf');

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage() });

// POST /api/maquinarias/guias/detectar - lee el texto del PDF (si lo tiene) y adivina
// fecha/hora/tipo con heuristicas simples, para prellenar el formulario. Mejor esfuerzo:
// nunca falla el flujo, si no encuentra nada devuelve todo en null y el usuario llena a mano.
router.post('/guias/detectar', verifyToken, requireRole('administrativo'), upload.single('archivo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'archivo (PDF) es requerido' });
    }
    try {
        const texto = await leerTextoPdf(req.file.buffer);

        const matchFecha = texto.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
        const matchHora = texto.match(/(\d{1,2}):(\d{2})/);

        let fechaHoraDetectada = null;
        if (matchFecha) {
            const [, dia, mes, anioCrudo] = matchFecha;
            const anio = anioCrudo.length === 2 ? `20${anioCrudo}` : anioCrudo;
            const hora = matchHora ? matchHora[1] : '00';
            const minuto = matchHora ? matchHora[2] : '00';
            const fecha = new Date(`${anio}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}T${hora.padStart(2, '0')}:${minuto}:00`);
            if (!isNaN(fecha.getTime())) fechaHoraDetectada = fecha.toISOString();
        }

        let tipoDetectado = null;
        const posDespacho = texto.search(/despacho/i);
        const posRecepcion = texto.search(/recepci[oó]n|traslado/i);
        if (posDespacho >= 0 && (posRecepcion < 0 || posDespacho < posRecepcion)) tipoDetectado = 'despacho';
        else if (posRecepcion >= 0) tipoDetectado = 'recepcion';

        res.json({
            fecha_hora_detectada: fechaHoraDetectada,
            tipo_detectado: tipoDetectado,
            texto_legible: texto.trim().length > 0,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al leer el PDF' });
    }
});

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

        const inicioCobro = calcularInicioCobro(despacho.fecha);
        const diasTranscurridos = calcularDiasTranscurridos(despacho.fecha, recepcion ? recepcion.fecha : null);

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
