const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { subidaPdf } = require('../middleware/upload');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { rutaArchivo } = require('../utils/rutaArchivo');
const { diasEntre } = require('../utils/diasArriendo');
const { resumirArriendoEnCurso, validarPeriodo } = require('../utils/periodosArriendo');
const { cargarArriendos } = require('../utils/arriendos');
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
        // un arriendo es un despacho; lo cierra la recepcion siguiente o, si falta, el despacho siguiente
        // (utils/arriendos.js). El cliente es el del despacho (el de la recepcion sale de
        // maquinarias.cliente_id, que con dos despachos seguidos ya seria el del segundo)
        const config = await leerConfiguracion(pool);
        const todos = await cargarArriendos(pool, config);
        const arriendos = todos
            // un arriendo facturado de mas (recepcion registrada con fecha anterior a lo ya facturado)
            // se muestra con su aviso: pide nota de credito en el SII y no se puede subir otra factura
            .filter((a) => !a.en_curso && (!a.nada_que_facturar || a.facturado_de_mas))
            .map((a) => ({
                guia_recepcion_id: a.guia_recepcion_id,
                guia_despacho_id: a.guia_despacho_id,
                maquinaria_id: a.maquinaria_id,
                maquinaria_codigo: a.maquinaria_codigo,
                cliente_nombre: a.cliente_nombre,
                cliente_email: a.cliente_email,
                fecha_despacho: a.fecha_despacho,
                fecha_recepcion: a.fecha_fin,
                desde: a.desde,
                fin: a.fin,
                hasta_sugerido: a.hasta_sugerido,
                es_final: a.es_final,
                falta_recepcion: a.falta_recepcion,
                facturado_de_mas: a.facturado_de_mas === true,
                facturado_hasta: a.facturado_hasta || null,
                // dias que quedan por facturar del arriendo, y dias del primer periodo propuesto
                dias: a.facturado_de_mas ? 0 : diasEntre(a.desde, a.fin),
                dias_periodo: a.dias,
            }))
            .sort((x, y) => new Date(y.fecha_recepcion) - new Date(x.fecha_recepcion));

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

// GET /api/facturacion/arriendos/:guiaDespachoId/propuesta - el periodo que el sistema propone
// facturar de un arriendo: desde el dia siguiente al ultimo facturado, hasta el primer fin de
// periodo (o el fin del arriendo). El administrativo lo confirma o elige otro fin de la lista.
router.get('/arriendos/:guiaDespachoId/propuesta', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const id = Number(req.params.guiaDespachoId);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Arriendo no encontrado' });
    try {
        const config = await leerConfiguracion(pool);
        const [arriendo] = await cargarArriendos(pool, config, { despachoId: id });
        if (!arriendo) return res.status(404).json({ error: 'Arriendo no encontrado' });
        res.json(respuestaPropuesta(arriendo, config));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al calcular el período a facturar' });
    }
});

function respuestaPropuesta(a, config) {
    return {
        guia_despacho_id: a.guia_despacho_id,
        guia_recepcion_id: a.guia_recepcion_id,
        maquinaria_id: a.maquinaria_id,
        maquinaria_codigo: a.maquinaria_codigo,
        cliente_id: a.cliente_id,
        cliente_nombre: a.cliente_nombre,
        inicio_cobro: a.inicio_cobro,
        facturado_hasta: a.facturado_hasta,
        fin: a.fin,
        en_curso: a.en_curso,
        desde: a.desde,
        hasta_sugerido: a.hasta_sugerido,
        opciones_hasta: a.opciones_hasta,
        dias: a.dias,
        es_final: a.es_final,
        falta_recepcion: a.falta_recepcion,
        nada_que_facturar: a.nada_que_facturar,
        facturado_de_mas: a.facturado_de_mas,
        facturado_completo: a.facturado_completo,
        configuracion: config,
    };
}

const esDia = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

// POST /api/facturacion/arriendo - sube la factura de un periodo de un arriendo.
// Campos: guia_despacho_id, periodo_desde, periodo_hasta, folio, monto y archivo (PDF). El servidor
// vuelve a calcular la propuesta con el despacho bloqueado y rechaza lo que no calce (huecos y
// solapes). Compatibilidad: solo con guia_recepcion_id (panel antiguo) factura todo lo que falta
// hasta el fin del arriendo.
router.post('/arriendo', verifyToken, requireRole('administrativo'), subidaPdf.single('archivo'), async (req, res) => {
    const { guia_recepcion_id, guia_despacho_id, periodo_desde, periodo_hasta, folio, monto } = req.body;
    const conPeriodo = Boolean(guia_despacho_id);
    if ((!conPeriodo && !guia_recepcion_id) || !folio || !req.file) {
        return res.status(400).json({ error: 'guia_despacho_id (o guia_recepcion_id), folio y archivo (PDF) son requeridos' });
    }
    if (conPeriodo && (!esDia(periodo_desde) || !esDia(periodo_hasta))) {
        return res.status(400).json({ error: 'periodo_desde y periodo_hasta son requeridos (AAAA-MM-DD)' });
    }
    // pesos chilenos enteros: sin puntos, decimales ni signo (el panel ya manda un entero)
    if (monto !== undefined && monto !== null && monto !== '' && !/^\d+$/.test(String(monto).trim())) {
        return res.status(400).json({ error: 'El monto debe ser un número entero de pesos, sin puntos ni decimales' });
    }
    const idOrigen = Number(conPeriodo ? guia_despacho_id : guia_recepcion_id);
    if (!Number.isInteger(idOrigen) || idOrigen <= 0) {
        return res.status(400).json({ error: 'Id de guía inválido' });
    }
    let rutaStorage = null;
    let client = null;
    const rechazar = async (estado, cuerpo) => {
        await client.query('ROLLBACK');
        if (rutaStorage) await supabase.storage.from(BUCKET_DOCUMENTOS).remove([rutaStorage]).catch(() => {});
        rutaStorage = null;
        return res.status(estado).json(cuerpo);
    };
    try {
        // el despacho del arriendo: directo, o el que cierra la recepcion indicada
        let despachoId = conPeriodo ? idOrigen : null;
        const config = await leerConfiguracion(pool);
        if (!conPeriodo) {
            const guia = await pool.query('SELECT id FROM guias WHERE id = $1 AND tipo = \'recepcion\'', [idOrigen]);
            if (guia.rows.length === 0) return res.status(404).json({ error: 'Guía de recepción no encontrada' });
            const [a] = await cargarArriendos(pool, config, { recepcionId: idOrigen });
            if (!a) return res.status(409).json({ error: 'Esta recepción no corresponde a un arriendo con despacho' });
            despachoId = a.guia_despacho_id;
        }

        rutaStorage = rutaArchivo(['facturas', `arriendo-${despachoId}`], req.file.originalname);
        const { error: errorSubida } = await supabase.storage
            .from(BUCKET_DOCUMENTOS)
            .upload(rutaStorage, req.file.buffer, { contentType: req.file.mimetype });
        if (errorSubida) throw errorSubida;

        client = await pool.connect();
        await client.query('BEGIN');
        // el mismo candado por despacho que usa el trigger de facturas (migracion 023) y despues el
        // bloqueo de la fila: serializa dos facturas simultaneas del mismo arriendo
        await client.query('SELECT pg_advisory_xact_lock(70215, $1)', [despachoId]);
        const bloqueo = await client.query(
            `SELECT id FROM guias WHERE id = $1 AND tipo = 'despacho' AND fallido = false FOR UPDATE`, [despachoId]);
        if (bloqueo.rows.length === 0) return await rechazar(404, { error: 'Arriendo no encontrado' });

        const [arriendo] = await cargarArriendos(client, config, { despachoId });
        if (arriendo.facturado_completo || arriendo.facturado_de_mas) {
            return await rechazar(409, { error: conPeriodo ? 'El arriendo ya está facturado completo' : 'Este arriendo ya tiene su factura' });
        }
        // panel antiguo: se factura hasta el fin del arriendo
        const desde = conPeriodo ? periodo_desde : arriendo.desde;
        const hasta = conPeriodo ? periodo_hasta : arriendo.fin;
        if (!conPeriodo && arriendo.en_curso) {
            return await rechazar(409, { error: 'El arriendo aún no tiene recepción: factura por período' });
        }
        const veredicto = conPeriodo
            ? validarPeriodo({ desde, hasta }, arriendo)
            : (arriendo.nada_que_facturar
                ? { ok: false, codigo: 'nada_que_facturar', estado: 409, mensaje: 'No hay días por facturar en este arriendo' }
                : { ok: true });
        if (!veredicto.ok) {
            return await rechazar(veredicto.estado, {
                error: veredicto.mensaje, codigo: veredicto.codigo, propuesta: respuestaPropuesta(arriendo, config),
            });
        }
        // la guia de recepcion solo se ata a la factura que cierra el arriendo
        const cierra = arriendo.fin !== null && hasta === arriendo.fin && arriendo.guia_recepcion_id !== null;
        const result = await client.query(
            `INSERT INTO facturas (maquinaria_id, guia_recepcion_id, guia_despacho_id, periodo_desde, periodo_hasta,
                                   cliente_id, folio, archivo_url, monto)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [arriendo.maquinaria_id, cierra ? arriendo.guia_recepcion_id : null, arriendo.guia_despacho_id, desde, hasta,
             arriendo.cliente_id, folio, rutaStorage, montoONulo(monto)]
        );
        await client.query('COMMIT');
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (rutaStorage) {
            await supabase.storage.from(BUCKET_DOCUMENTOS).remove([rutaStorage]).catch(() => {});
        }
        if (err.code === '23505') {
            return res.status(409).json({
                error: err.constraint === 'facturas_despacho_periodo_unico'
                    ? 'Ya hay una factura para este período'
                    : 'Esta recepción ya tiene su factura',
            });
        }
        console.error(err);
        res.status(500).json({ error: 'Error al subir factura de arriendo' });
    } finally {
        if (client) client.release();
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
// despacho no aparece. Un equipo tiene a lo mas un arriendo en curso: el del ultimo despacho.
router.get('/arriendos-en-curso', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const config = await leerConfiguracion(pool);
        const todos = await cargarArriendos(pool, config);
        const arriendos = todos
            .filter((a) => a.en_curso)
            .map((a) => ({
                guia_despacho_id: a.guia_despacho_id,
                maquinaria_id: a.maquinaria_id,
                maquinaria_codigo: a.maquinaria_codigo,
                cliente_id: a.cliente_id,
                cliente_nombre: a.cliente_nombre,
                fecha_despacho: a.fecha_despacho,
                inicio_cobro: a.inicio_cobro,
                facturado_hasta: a.facturado_hasta,
                opciones_hasta: a.opciones_hasta,
                ...resumirArriendoEnCurso({
                    inicioCobro: a.inicio_cobro,
                    ultimoPeriodoHasta: a.facturado_hasta,
                    hoy: a.hoy,
                    diaFacturacion: config.dia_facturacion,
                    corteCierraPeriodo: config.corte_cierra_periodo,
                }),
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
