const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { subidaPdf } = require('../middleware/upload');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { rutaArchivo } = require('../utils/rutaArchivo');
const { calcularDiasTranscurridos } = require('../utils/diasArriendo');
const { leerTextoPdf } = require('../utils/leerTextoPdf');
const { detectarCliente } = require('../utils/detectarCliente');
const { parsearFactura } = require('../utils/parsearDocumento');

const router = express.Router();

// un monto 0 es un monto valido: `monto || null` lo convertia en nulo
const montoONulo = (v) => (v === undefined || v === null || v === '' ? null : v);

// GET /api/facturacion/pendientes - todo lo que falta facturar, agrupado por estado real:
// arriendos con ciclo despacho+recepcion cerrado, reparaciones esperando que el Gerente
// les ponga monto, y reparaciones ya valorizadas listas para emitir factura.
router.get('/pendientes', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        // el cliente sale de la propia guia de recepcion (snapshot al momento del evento),
        // NUNCA de maquinarias.cliente_id: la recepcion libera la maquina (cliente_id = NULL)
        // justo antes de llegar aca, y el arriendo quedaria sin cliente para facturar
        const arriendosResult = await pool.query(`
            SELECT g.id AS guia_recepcion_id, g.maquinaria_id, m.codigo AS maquinaria_codigo,
                   c.nombre AS cliente_nombre, c.email AS cliente_email,
                   d.fecha AS fecha_despacho, g.fecha AS fecha_recepcion
            FROM guias g
            JOIN maquinarias m ON m.id = g.maquinaria_id
            LEFT JOIN clientes c ON c.id = g.cliente_id
            JOIN LATERAL (
                SELECT fecha FROM guias d2
                WHERE d2.maquinaria_id = g.maquinaria_id AND d2.tipo = 'despacho'
                  AND d2.fallido = false AND d2.fecha <= g.fecha
                ORDER BY d2.fecha DESC LIMIT 1
            ) d ON true
            WHERE g.tipo = 'recepcion' AND g.fallido = false
              AND NOT EXISTS (SELECT 1 FROM facturas f WHERE f.guia_recepcion_id = g.id)
            ORDER BY g.fecha DESC
        `);
        const arriendos = arriendosResult.rows.map((fila) => ({
            ...fila,
            dias: calcularDiasTranscurridos(fila.fecha_despacho, fila.fecha_recepcion),
        }));

        const pendientesValorizarResult = await pool.query(`
            SELECT ot.id, ot.motivo, ot.diagnostico, ot.fecha_creacion,
                   m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre
            FROM ordenes_trabajo ot
            JOIN maquinarias m ON m.id = ot.maquinaria_id
            LEFT JOIN clientes c ON c.id = ot.cliente_id
            WHERE ot.facturable = true AND ot.valorizacion IS NULL
              -- solo trabajo terminado: una OT en curso todavia puede sumar o anular repuestos
              AND ot.estado = 'finalizada'
            ORDER BY ot.fecha_creacion DESC
        `);

        const listasResult = await pool.query(`
            SELECT ot.id, ot.motivo, ot.diagnostico, ot.valorizacion, ot.fecha_creacion,
                   m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre, c.email AS cliente_email
            FROM ordenes_trabajo ot
            JOIN maquinarias m ON m.id = ot.maquinaria_id
            LEFT JOIN clientes c ON c.id = ot.cliente_id
            WHERE ot.facturable = true AND ot.valorizacion IS NOT NULL
              AND ot.estado = 'finalizada'
              AND NOT EXISTS (SELECT 1 FROM facturas f WHERE f.orden_trabajo_id = ot.id)
            ORDER BY ot.fecha_creacion DESC
        `);

        res.json({
            arriendos,
            reparaciones_pendientes_valorizar: pendientesValorizarResult.rows,
            reparaciones_listas: listasResult.rows,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar pendientes de facturación' });
    }
});

// POST /api/facturacion/detectar - lee el texto del PDF de una factura para adivinar
// monto, folio y cliente (mejor esfuerzo, igual que /guias/detectar - nunca bloquea el flujo)
router.post('/detectar', verifyToken, requireRole('administrativo'), subidaPdf.single('archivo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'archivo (PDF) es requerido' });
    }
    try {
        const texto = await leerTextoPdf(req.file.buffer);
        const { monto_detectado, folio_detectado, rut_detectado } = parsearFactura(texto);

        res.json({
            monto_detectado,
            folio_detectado,
            cliente_detectado: await detectarCliente(texto, rut_detectado),
            texto_legible: texto.trim().length > 0,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al leer el PDF' });
    }
});

// POST /api/facturacion/arriendo - sube la factura de un ciclo de arriendo ya cerrado
router.post('/arriendo', verifyToken, requireRole('administrativo'), subidaPdf.single('archivo'), async (req, res) => {
    const { guia_recepcion_id, folio, monto } = req.body;
    if (!guia_recepcion_id || !folio || !req.file) {
        return res.status(400).json({ error: 'guia_recepcion_id, folio y archivo (PDF) son requeridos' });
    }
    let rutaStorage = null;
    try {
        const guia = await pool.query('SELECT maquinaria_id FROM guias WHERE id = $1', [guia_recepcion_id]);
        if (guia.rows.length === 0) {
            return res.status(404).json({ error: 'Guía de recepción no encontrada' });
        }
        const maquinariaId = guia.rows[0].maquinaria_id;

        rutaStorage = rutaArchivo(['facturas', `arriendo-${Number(guia_recepcion_id)}`], req.file.originalname);
        const { error: errorSubida } = await supabase.storage
            .from(BUCKET_DOCUMENTOS)
            .upload(rutaStorage, req.file.buffer, { contentType: req.file.mimetype });
        if (errorSubida) throw errorSubida;

        const result = await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url, monto)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [maquinariaId, guia_recepcion_id, folio, rutaStorage, montoONulo(monto)]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (rutaStorage) {
            await supabase.storage.from(BUCKET_DOCUMENTOS).remove([rutaStorage]).catch(() => {});
        }
        if (err.code === '23505') {
            return res.status(409).json({ error: 'Este arriendo ya tiene su factura' });
        }
        console.error(err);
        res.status(500).json({ error: 'Error al subir factura de arriendo' });
    }
});

// PATCH /api/facturacion/:facturaId - corrige folio/monto despues de creada la factura
// (por si la deteccion del PDF se equivoco), funciona para cualquier tipo de factura
router.patch('/:facturaId', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { folio, monto } = req.body;
    try {
        const result = await pool.query(
            `UPDATE facturas SET folio = COALESCE($1, folio), monto = COALESCE($2, monto) WHERE id = $3 RETURNING *`,
            [folio || null, montoONulo(monto), req.params.facturaId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Factura no encontrada' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar la factura' });
    }
});

// POST /api/facturacion/:facturaId/autorizar-envio - version unificada de la que ya
// existia en facturas.js (solo para reparaciones): funciona para cualquier factura,
// sea de reparacion (orden_trabajo_id) o de arriendo (maquinaria_id)
router.post('/:facturaId/autorizar-envio', verifyToken, requireRole('administrativo'), async (req, res) => {
    try {
        // para facturas de arriendo, el cliente sale de la guia de recepcion (snapshot),
        // no de la maquinaria (que ya fue liberada al recibir el equipo)
        const result = await pool.query(
            `SELECT f.*, m.codigo AS maquinaria_codigo,
                    cot.nombre AS cliente_nombre_ot, cot.email AS cliente_email_ot,
                    cm.nombre AS cliente_nombre_m, cm.email AS cliente_email_m
             FROM facturas f
             LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
             LEFT JOIN clientes cot ON cot.id = ot.cliente_id
             LEFT JOIN maquinarias m ON m.id = f.maquinaria_id
             LEFT JOIN guias g ON g.id = f.guia_recepcion_id
             LEFT JOIN clientes cm ON cm.id = g.cliente_id
             WHERE f.id = $1`,
            [req.params.facturaId]
        );
        const factura = result.rows[0];
        if (!factura) {
            return res.status(404).json({ error: 'Factura no encontrada' });
        }

        const clienteNombre = factura.orden_trabajo_id ? factura.cliente_nombre_ot : factura.cliente_nombre_m;
        const clienteEmail = factura.orden_trabajo_id ? factura.cliente_email_ot : factura.cliente_email_m;
        if (!clienteEmail) {
            return res.status(400).json({ error: 'El cliente no tiene un correo registrado' });
        }

        await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', $1, $2)`,
            [clienteEmail, JSON.stringify({
                tipo: 'factura_emitida',
                orden_trabajo_id: factura.orden_trabajo_id,
                maquinaria_codigo: factura.maquinaria_codigo,
                folio: factura.folio,
                monto: factura.monto,
                cliente_nombre: clienteNombre,
            })]
        );

        res.json({ ok: true, mensaje: 'Envio de correo encolado' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al autorizar el envío de la factura' });
    }
});

module.exports = router;
