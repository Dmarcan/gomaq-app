const express = require('express');
require('../utils/asyncErrores');
const { montoEnteroONulo } = require('../utils/auditoriaLinea');
const { validarIdsEnRuta } = require('../utils/validacion');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { subidaPdf } = require('../middleware/upload');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { rutaArchivo } = require('../utils/rutaArchivo');
const { diasEntre } = require('../utils/diasArriendo');
const { validarPeriodo } = require('../utils/periodosArriendo');
const { cargarArriendos, filtrarPorFacturar, resumenEnCurso } = require('../utils/arriendos');
const { SQL_OT_POR_VALORIZAR, SQL_OT_LISTA_FACTURAR } = require('../utils/ordenes');
const { leerConfiguracion, validarCambioConfiguracion, CLAVES_OBSOLETAS } = require('../utils/configuracion');
const { textoPorDefecto, leerFacturaParaCorreo, hayEnvioPendiente, encolarCorreoFactura, validarFolio, cancelarCorreosPrevios } = require('../utils/correoFactura');
const { leerTextoPdf } = require('../utils/leerTextoPdf');
const { detectarCliente } = require('../utils/detectarCliente');
const { parsearFactura } = require('../utils/parsearDocumento');

const { validarTraslado } = require('../utils/trasladoFactura');

const router = express.Router();
validarIdsEnRuta(router, ['facturaId', 'guiaDespachoId']);

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
        // un arriendo facturado de mas (recepcion registrada con fecha anterior a lo ya facturado)
        // se muestra con su aviso: pide nota de credito en el SII y no se puede subir otra factura
        const arriendos = filtrarPorFacturar(todos)
            .map((a) => ({
                guia_recepcion_id: a.guia_recepcion_id,
                guia_despacho_id: a.guia_despacho_id,
                maquinaria_id: a.maquinaria_id,
                maquinaria_codigo: a.maquinaria_codigo,
                cliente_id: a.cliente_id,
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
            -- solo trabajo terminado y sin factura: una OT en curso todavia puede sumar o anular repuestos
            WHERE ${SQL_OT_POR_VALORIZAR}
            ORDER BY ot.fecha_creacion DESC
        `);

        const listasResult = await pool.query(`
            SELECT ot.id, ot.motivo, ot.diagnostico, ot.valorizacion, ot.fecha_creacion,
                   m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre, c.email AS cliente_email
            FROM ordenes_trabajo ot
            JOIN maquinarias m ON m.id = ot.maquinaria_id
            LEFT JOIN clientes c ON c.id = ot.cliente_id
            WHERE ${SQL_OT_LISTA_FACTURAR}
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
    const { guia_recepcion_id, guia_despacho_id, periodo_desde, periodo_hasta, folio, monto, monto_traslado } = req.body;
    const conPeriodo = Boolean(guia_despacho_id);
    if ((!conPeriodo && !guia_recepcion_id) || !folio || !req.file) {
        return res.status(400).json({ error: 'guia_despacho_id (o guia_recepcion_id), folio y archivo (PDF) son requeridos' });
    }
    const folioValido = validarFolio(folio);
    if (folioValido.error) return res.status(400).json({ error: folioValido.error });
    if (conPeriodo && (!esDia(periodo_desde) || !esDia(periodo_hasta))) {
        return res.status(400).json({ error: 'periodo_desde y periodo_hasta son requeridos (AAAA-MM-DD)' });
    }
    // pesos chilenos enteros: sin puntos, decimales ni signo (el panel ya manda un entero)
    if (monto !== undefined && monto !== null && monto !== '' && montoEnteroONulo(monto) === null) {
        return res.status(400).json({ error: 'El monto debe ser un número entero de pesos, sin puntos ni decimales, de hasta 10 dígitos' });
    }
    const trasladoValido = validarTraslado(monto, monto_traslado);
    if (trasladoValido.error) return res.status(400).json({ error: trasladoValido.error });
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
                                   cliente_id, folio, archivo_url, monto, monto_traslado)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [arriendo.maquinaria_id, cierra ? arriendo.guia_recepcion_id : null, arriendo.guia_despacho_id, desde, hasta,
             arriendo.cliente_id, folioValido.folio, rutaStorage, montoONulo(monto), trasladoValido.traslado]
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
    // las claves obsoletas (incluir_dia_recepcion) se aceptan para no romper paneles antiguos, pero no se
    // guardan ni cambian quien/cuando: un PUT con solo ellas responde 200 con la configuracion vigente
    const vigentes = Object.entries(valores).filter(([clave]) => !CLAVES_OBSOLETAS.has(clave));
    if (vigentes.length === 0) return res.json(await leerConfiguracion(pool));
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        for (const [clave, valor] of vigentes) {
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
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al guardar la configuración' });
    } finally {
        if (client) client.release();
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
                ...resumenEnCurso(a, config),
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
    const { folio, monto, monto_traslado } = req.body || {};
    if (!/^\d{1,9}$/.test(String(req.params.facturaId))) return res.status(400).json({ error: 'Id de factura inválido' });
    let folioNuevo = null;
    if (folio !== undefined && folio !== null && folio !== '') {
        const v = validarFolio(folio);
        if (v.error) return res.status(400).json({ error: v.error });
        folioNuevo = v.folio;
    }
    // pesos chilenos enteros, igual que al crear la factura
    if (monto !== undefined && monto !== null && monto !== '' && montoEnteroONulo(monto) === null) {
        return res.status(400).json({ error: 'El monto debe ser un número entero de pesos, sin puntos ni decimales, de hasta 10 dígitos' });
    }
    // formato del traslado; la regla contra el monto final se revisa con la fila bloqueada
    if (!(monto_traslado === undefined || monto_traslado === null || monto_traslado === '') && montoEnteroONulo(monto_traslado) === null) {
        return res.status(400).json({ error: 'El traslado debe ser un número entero de pesos, sin puntos ni decimales, de hasta 10 dígitos' });
    }
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        // se bloquea la fila: serializa con encolarCorreoFactura (que tambien la bloquea), asi un envio no
        // puede colarse entre la revision de abajo y el UPDATE
        const fila = await client.query('SELECT id, monto, monto_traslado FROM facturas WHERE id = $1 FOR UPDATE', [req.params.facturaId]);
        if (fila.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Factura no encontrada' });
        }
        // con un correo pendiente el texto ya quedo congelado como lo vio el administrativo:
        // corregir folio o monto ahora lo dejaria distinto de la factura
        if (await hayEnvioPendiente(client, req.params.facturaId)) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'La factura tiene un envío pendiente: espera a que salga o cancélalo antes de corregirla' });
        }
        // monto y traslado finales (lo nuevo o lo ya guardado) deben seguir cuadrando
        // NUMERIC llega como texto con decimales ('249900.00'): se pasa a numero entero antes de validar
        const montoGuardado = fila.rows[0].monto === null ? null : Number(fila.rows[0].monto);
        const montoFinal = montoONulo(monto) ?? montoGuardado;
        const trasladoEnviado = !(monto_traslado === undefined || monto_traslado === null || monto_traslado === '');
        const trasladoFinal = validarTraslado(montoFinal, trasladoEnviado ? monto_traslado : Number(fila.rows[0].monto_traslado));
        if (trasladoFinal.error) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: trasladoFinal.error });
        }
        const result = await client.query(
            `UPDATE facturas SET folio = COALESCE($1, folio), monto = COALESCE($2, monto), monto_traslado = $3 WHERE id = $4 RETURNING *`,
            [folioNuevo, montoONulo(monto), trasladoFinal.traslado, req.params.facturaId]
        );
        // un correo anterior que agoto sus reintentos (error) llevaba el folio y el monto viejos
        await cancelarCorreosPrevios(client, req.params.facturaId, 'Factura corregida');
        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar la factura' });
    } finally {
        if (client) client.release();
    }
});

// GET /api/facturacion/:facturaId/vista-previa - asunto y cuerpo propuestos para el correo, el periodo
// facturado y si ya hay un envio pendiente. El texto por defecto vive solo aca (utils/correoFactura.js).
router.get('/:facturaId/vista-previa', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    if (!/^\d{1,9}$/.test(String(req.params.facturaId))) return res.status(400).json({ error: 'Id de factura inválido' });
    try {
        const factura = await leerFacturaParaCorreo(pool, req.params.facturaId);
        if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
        const texto = textoPorDefecto(factura);
        res.json({
            ...texto,
            folio: factura.folio,
            periodo_desde: factura.periodo_desde,
            periodo_hasta: factura.periodo_hasta,
            orden_trabajo_id: factura.orden_trabajo_id,
            cliente_nombre: factura.cliente_nombre,
            cliente_email: factura.cliente_email,
            envio_pendiente: await hayEnvioPendiente(pool, factura.id),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al armar la vista previa' });
    }
});

// POST /api/facturacion/:facturaId/autorizar-envio - version unificada de la que ya
// existia en facturas.js (solo para reparaciones): funciona para cualquier factura,
// sea de reparacion (orden_trabajo_id) o de arriendo (maquinaria_id). Acepta { asunto, cuerpo }
// editados; sin ellos usa el texto por defecto. Ver encolarCorreoFactura (bloqueo contra la anulacion).
router.post('/:facturaId/autorizar-envio', verifyToken, requireRole('administrativo'), async (req, res) => {
    if (!/^\d{1,9}$/.test(String(req.params.facturaId))) return res.status(400).json({ error: 'Id de factura inválido' });
    try {
        const cuerpoPeticion = req.body || {};
        const r = await encolarCorreoFactura(pool, {
            facturaId: req.params.facturaId, asunto: cuerpoPeticion.asunto, cuerpo: cuerpoPeticion.cuerpo,
        });
        res.status(r.status).json(r.body);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al autorizar el envío de la factura' });
    }
});

module.exports = router;
