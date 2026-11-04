const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { subidaPdf } = require('../middleware/upload');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { rutaArchivo } = require('../utils/rutaArchivo');
const { diasEntre, diaSantiago, inicioCobroDia, resumirArriendoEnCurso } = require('../utils/diasArriendo');
const { leerConfiguracion, validarCambioConfiguracion } = require('../utils/configuracion');
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
                   d.fecha AS fecha_despacho, to_char(d.inicio_cobro, 'YYYY-MM-DD') AS inicio_cobro, g.fecha AS fecha_recepcion
            FROM guias g
            JOIN maquinarias m ON m.id = g.maquinaria_id
            LEFT JOIN clientes c ON c.id = g.cliente_id
            JOIN LATERAL (
                SELECT fecha, inicio_cobro FROM guias d2
                WHERE d2.maquinaria_id = g.maquinaria_id AND d2.tipo = 'despacho'
                  AND d2.fallido = false AND d2.fecha <= g.fecha
                ORDER BY d2.fecha DESC LIMIT 1
            ) d ON true
            WHERE g.tipo = 'recepcion' AND g.fallido = false
              AND NOT EXISTS (SELECT 1 FROM facturas f WHERE f.guia_recepcion_id = g.id)
            ORDER BY g.fecha DESC
        `);
        // el inicio de cobro se fijo al crear el despacho (migracion 022); sin el, la regla historica
        const config = await leerConfiguracion(pool);
        const arriendos = arriendosResult.rows.map(({ inicio_cobro: inicioGuardado, ...fila }) => {
            const inicio = inicioGuardado || inicioCobroDia(fila.fecha_despacho);
            const dias = diasEntre(inicio, diaSantiago(fila.fecha_recepcion)) - (config.incluir_dia_recepcion ? 0 : 1);
            return { ...fila, dias: Math.max(0, dias) };
        });

        const pendientesValorizarResult = await pool.query(`
            SELECT ot.id, ot.motivo, ot.diagnostico, ot.fecha_creacion,
                   m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre
            FROM ordenes_trabajo ot
            JOIN maquinarias m ON m.id = ot.maquinaria_id
            LEFT JOIN clientes c ON c.id = ot.cliente_id
            WHERE ot.facturable = true AND ot.valorizacion IS NULL
              -- una orden ya facturada (se puede facturar sin valorizar) no queda pendiente de valorizar
              AND NOT EXISTS (SELECT 1 FROM facturas f WHERE f.orden_trabajo_id = ot.id)
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

// GET /api/facturacion/configuracion - reglas de cobro vigentes (dia de facturacion, hora de corte
// del despacho, si el dia de la recepcion cuenta). Las rutas fijas van antes de /:facturaId.
router.get('/configuracion', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const config = await leerConfiguracion(pool);
        const ultimo = await pool.query(
            `SELECT c.actualizado_at, u.nombre AS actualizado_por
             FROM configuracion c LEFT JOIN usuarios u ON u.id = c.actualizado_por
             WHERE c.actualizado_por IS NOT NULL ORDER BY c.actualizado_at DESC LIMIT 1`);
        res.json({
            ...config,
            actualizado_por: ultimo.rows[0] ? ultimo.rows[0].actualizado_por : null,
            actualizado_at: ultimo.rows[0] ? ultimo.rows[0].actualizado_at : null,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al leer la configuración' });
    }
});

// PUT /api/facturacion/configuracion - solo el gerente. Cambia las claves enviadas; no reescribe
// el inicio de cobro de los despachos ya creados.
router.put('/configuracion', verifyToken, requireRole('gerente'), async (req, res) => {
    const { valores, error } = validarCambioConfiguracion(req.body);
    if (error) return res.status(400).json({ error });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const [clave, valor] of Object.entries(valores)) {
            await client.query(
                `INSERT INTO configuracion (clave, valor, actualizado_por, actualizado_at)
                 VALUES ($1, $2::jsonb, $3, now())
                 ON CONFLICT (clave) DO UPDATE
                 SET valor = EXCLUDED.valor, actualizado_por = EXCLUDED.actualizado_por, actualizado_at = now()`,
                [clave, JSON.stringify(valor), req.user.id]);
        }
        await client.query('COMMIT');
        res.json(await leerConfiguracion(pool));
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al guardar la configuración' });
    } finally {
        client.release();
    }
});

// GET /api/facturacion/arriendos-en-curso - solo lectura: equipos despachados que aun no vuelven,
// desde cuando se cobran, cuantos dias van y cuantos periodos (cortes) llevan sin facturar.
// Sale de las guias, no de maquinarias.cliente_id: un equipo con cliente cargado a mano y sin
// despacho no aparece. Toma el primer despacho abierto, igual que utils/rentabilidad.js.
router.get('/arriendos-en-curso', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const config = await leerConfiguracion(pool);
        const r = await pool.query(
            `WITH ur AS (
                 SELECT DISTINCT ON (maquinaria_id) maquinaria_id, fecha, id FROM guias
                 WHERE tipo = 'recepcion' AND fallido = false
                 ORDER BY maquinaria_id, fecha DESC, id DESC)
             SELECT DISTINCT ON (d.maquinaria_id)
                    d.id AS guia_despacho_id, d.maquinaria_id, m.codigo AS maquinaria_codigo,
                    d.cliente_id, c.nombre AS cliente_nombre, d.fecha AS fecha_despacho,
                    to_char(COALESCE(d.inicio_cobro, gomaq_inicio_cobro(d.fecha, $1)), 'YYYY-MM-DD') AS inicio_cobro,
                    to_char(now() AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') AS hoy
             FROM guias d
             JOIN maquinarias m ON m.id = d.maquinaria_id
             LEFT JOIN clientes c ON c.id = d.cliente_id
             LEFT JOIN ur ON ur.maquinaria_id = d.maquinaria_id
             WHERE d.tipo = 'despacho' AND d.fallido = false
               AND (ur.id IS NULL OR (d.fecha, d.id) > (ur.fecha, ur.id))
             ORDER BY d.maquinaria_id, d.fecha ASC, d.id ASC`,
            [config.hora_corte_despacho]);
        const arriendos = r.rows.map(({ hoy, inicio_cobro: inicioCobro, ...fila }) => ({
            ...fila,
            inicio_cobro: inicioCobro,
            ...resumirArriendoEnCurso({ inicioCobro, hoy, diaFacturacion: config.dia_facturacion }),
        }));
        arriendos.sort((a, b) => b.periodos_sin_facturar - a.periodos_sin_facturar || b.dias - a.dias);
        res.json({ arriendos, configuracion: config });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar los arriendos en curso' });
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
        // el cliente es el de la propia factura (facturas.cliente_id, migracion 023); las anteriores a
        // la migracion lo traen rellenado, y como respaldo se usa el de la OT o el de la guia de
        // recepcion (snapshot), nunca el de la maquinaria, que ya fue liberada al recibir el equipo
        const result = await pool.query(
            `SELECT f.*, m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre, c.email AS cliente_email
             FROM facturas f
             LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
             LEFT JOIN guias g ON g.id = f.guia_recepcion_id
             LEFT JOIN clientes c ON c.id = COALESCE(f.cliente_id, ot.cliente_id, g.cliente_id)
             LEFT JOIN maquinarias m ON m.id = f.maquinaria_id
             WHERE f.id = $1`,
            [req.params.facturaId]
        );
        const factura = result.rows[0];
        if (!factura) {
            return res.status(404).json({ error: 'Factura no encontrada' });
        }

        const clienteNombre = factura.cliente_nombre;
        const clienteEmail = factura.cliente_email;
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
