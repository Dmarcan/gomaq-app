const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { subidaPdf } = require('../middleware/upload');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { rutaArchivo } = require('../utils/rutaArchivo');

const router = express.Router();
const URL_EXPIRACION_SEGUNDOS = 3600;

// POST /api/ordenes-trabajo/:id/factura - subir PDF de factura ya emitida en el SII (va a Supabase Storage)
router.post('/:id/factura', verifyToken, requireRole('administrativo'), subidaPdf.single('archivo'), async (req, res) => {
    const { id } = req.params;
    const { folio, monto, fecha_emision } = req.body;
    if (!folio || !req.file) {
        return res.status(400).json({ error: 'folio y archivo (PDF) son requeridos' });
    }
    let rutaStorage = null;
    try {
        rutaStorage = rutaArchivo(['facturas', Number(id)], req.file.originalname);
        const { error: errorSubida } = await supabase.storage
            .from(BUCKET_DOCUMENTOS)
            .upload(rutaStorage, req.file.buffer, { contentType: req.file.mimetype });
        if (errorSubida) throw errorSubida;

        const result = await pool.query(
            `INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, monto, fecha_emision)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [id, folio, rutaStorage, monto || null, fecha_emision || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (rutaStorage) {
            await supabase.storage.from(BUCKET_DOCUMENTOS).remove([rutaStorage]).catch(() => {});
        }
        console.error(err);
        res.status(500).json({ error: 'Error al subir factura' });
    }
});

// GET /api/ordenes-trabajo/:id/factura - listar facturas de una OT, con URL firmada temporal
router.get('/:id/factura', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM facturas WHERE orden_trabajo_id = $1 ORDER BY created_at DESC',
            [req.params.id]
        );
        const conUrlFirmada = await Promise.all(result.rows.map(async (fila) => {
            const { data, error } = await supabase.storage
                .from(BUCKET_DOCUMENTOS)
                .createSignedUrl(fila.archivo_url, URL_EXPIRACION_SEGUNDOS);
            return { ...fila, url: error ? null : data.signedUrl };
        }));
        res.json(conUrlFirmada);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar facturas' });
    }
});

// POST /api/ordenes-trabajo/:id/factura/:facturaId/autorizar-envio
// Encola el envio del correo con la factura al cliente (patron Outbox, igual que WhatsApp).
// El envio real de correo aun no esta configurado, asi que quedara pendiente/error
// hasta que se agregue el proveedor SMTP - mismo comportamiento que las notificaciones de WhatsApp.
router.post('/:id/factura/:facturaId/autorizar-envio', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { id, facturaId } = req.params;
    try {
        const result = await pool.query(
            `SELECT f.folio, f.archivo_url, f.monto, ot.id AS orden_trabajo_id, c.nombre AS cliente_nombre, c.email AS cliente_email
             FROM facturas f
             JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
             LEFT JOIN clientes c ON c.id = ot.cliente_id
             WHERE f.id = $1 AND f.orden_trabajo_id = $2`,
            [facturaId, id]
        );
        const factura = result.rows[0];
        if (!factura) {
            return res.status(404).json({ error: 'Factura no encontrada para esta orden de trabajo' });
        }
        if (!factura.cliente_email) {
            return res.status(400).json({ error: 'El cliente no tiene un correo registrado' });
        }

        await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', $1, $2)`,
            [factura.cliente_email, JSON.stringify({
                tipo: 'factura_emitida',
                orden_trabajo_id: factura.orden_trabajo_id,
                folio: factura.folio,
                monto: factura.monto,
                cliente_nombre: factura.cliente_nombre,
            })]
        );

        res.json({ ok: true, mensaje: 'Envio de correo encolado' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al autorizar el envio de la factura' });
    }
});

module.exports = router;
