const express = require('express');
require('../utils/asyncErrores');
const { montoEnteroONulo } = require('../utils/auditoriaLinea');
const { validarIdsEnRuta } = require('../utils/validacion');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { subidaPdf, subidaComprobante } = require('../middleware/upload');
const { supabase, BUCKET, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { URL_EXPIRACION_SEGUNDOS, firmarUrl } = require('../utils/urlsFirmadas');
const { borrarArchivoSubido } = require('../utils/archivosStorage');
const { rutaArchivo } = require('../utils/rutaArchivo');
const { diasEntre } = require('../utils/diasArriendo');
const { validarPeriodo } = require('../utils/periodosArriendo');
const { cargarArriendos, filtrarPorFacturar, resumenEnCurso } = require('../utils/arriendos');
const { SQL_OT_POR_VALORIZAR, SQL_OT_LISTA_FACTURAR } = require('../utils/ordenes');
const { leerConfiguracion, validarCambioConfiguracion, CLAVES_OBSOLETAS } = require('../utils/configuracion');
const { textoPorDefecto, leerFacturaParaCorreo, hayEnvioPendiente, encolarCorreoFactura, validarFolio, cancelarCorreosPrevios, validarFotosDelEnvio, fotosDelUltimoCorreo } = require('../utils/correoFactura');
const { leerTextoPdf } = require('../utils/leerTextoPdf');
const { detectarCliente } = require('../utils/detectarCliente');
const { parsearFactura } = require('../utils/parsearDocumento');
const { parsearPaginacion, parsearBusqueda, envolver } = require('../utils/paginacion');
const { validarTraslado, validarNeto, resolverTraslado } = require('../utils/trasladoFactura');
const {
    FILTROS_ESTADO, hoySantiago, vencimientoPropuesto, avisosPrecarga, validarFechasFactura, validarFechaPago, validarFolioNotaCredito,
} = require('../utils/cobranza');
const { esDiaValido } = require('../utils/validacion');
const { cargarEmitidas } = require('../utils/facturasEmitidas');
const { crearXlsx, TIPO_XLSX } = require('../utils/xlsx');
const {
    NOMBRE_HOJA: NOMBRE_HOJA_EXPORTACION, MAX_FILAS: MAX_FILAS_EXPORTACION, armarHoja, cargarFilasExportacion,
} = require('../utils/exportarFacturacion');

const router = express.Router();
validarIdsEnRuta(router, ['facturaId', 'guiaDespachoId']);

// un monto 0 es un monto valido: `monto || null` lo volveria nulo
const montoONulo = (v) => (v === undefined || v === null || v === '' ? null : v);

// las fechas de cobranza de la factura como 'YYYY-MM-DD' en la respuesta: node-pg entrega un DATE como un Date
// a medianoche local y en JSON se correria de dia segun la zona del servidor
const pad2 = (n) => String(n).padStart(2, '0');
const diaDeFecha = (v) => (v instanceof Date ? `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}` : v ?? null);
const conFechasTexto = (fila) => ({
    ...fila,
    fecha_emision: diaDeFecha(fila.fecha_emision),
    fecha_vencimiento: diaDeFecha(fila.fecha_vencimiento),
    fecha_pago: diaDeFecha(fila.fecha_pago),
});

// todo lo que falta facturar, agrupado por estado real:
// arriendos con ciclo despacho+recepcion cerrado, reparaciones esperando que el Gerente
// les ponga monto, y reparaciones ya valorizadas listas para emitir factura.
router.get('/pendientes', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
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
});

// lee el texto del PDF de una factura para adivinar monto, folio, cliente,
// neto, emision, vencimiento y traslado (mejor esfuerzo, igual que /guias/detectar - nunca bloquea el flujo).
// Lo leido se PRECARGA: el administrativo lo confirma en el dialogo. Si el cliente tiene plazo habitual y el
// vencimiento del PDF no coincide con emision + plazo, `vencimiento` trae las dos opciones y va un aviso.
router.post('/detectar', verifyToken, requireRole('administrativo'), subidaPdf.single('archivo'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'archivo (PDF) es requerido' });
    }
    const texto = await leerTextoPdf(req.file.buffer);
    const leido = parsearFactura(texto);
    const cliente = await detectarCliente(texto, leido.rut_detectado);
    let plazo = null;
    if (cliente) {
        const r = await pool.query('SELECT plazo_pago_dias FROM clientes WHERE id = $1', [cliente.id]);
        plazo = r.rows[0] && r.rows[0].plazo_pago_dias !== null ? Number(r.rows[0].plazo_pago_dias) : null;
    }
    const vencimiento = vencimientoPropuesto({
        emision: leido.fecha_emision_detectada, vencimientoPdf: leido.vencimiento_detectado, plazoCliente: plazo,
    });

    res.json({
        monto_detectado: leido.monto_detectado,
        folio_detectado: leido.folio_detectado,
        cliente_detectado: cliente,
        texto_legible: texto.trim().length > 0,
        monto_neto_detectado: leido.monto_neto_detectado,
        fecha_emision_detectada: leido.fecha_emision_detectada,
        vencimiento_detectado: leido.vencimiento_detectado,
        varias_cuotas: leido.varias_cuotas,
        traslado_detectado: leido.traslado_detectado,
        plazo_cliente_dias: plazo,
        vencimiento,
        avisos: avisosPrecarga(leido, vencimiento),
    });
});

// el periodo que el sistema propone
// facturar de un arriendo: desde el dia siguiente al ultimo facturado, hasta el primer fin de
// periodo (o el fin del arriendo). El administrativo lo confirma o elige otro fin de la lista.
router.get('/arriendos/:guiaDespachoId/propuesta', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const id = Number(req.params.guiaDespachoId);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Arriendo no encontrado' });
    const config = await leerConfiguracion(pool);
    const [arriendo] = await cargarArriendos(pool, config, { despachoId: id });
    if (!arriendo) return res.status(404).json({ error: 'Arriendo no encontrado' });
    res.json(respuestaPropuesta(arriendo, config));
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

// sube la factura de un periodo de un arriendo.
// Campos: guia_despacho_id, periodo_desde, periodo_hasta, folio, monto y archivo (PDF). El servidor
// vuelve a calcular la propuesta con el despacho bloqueado y rechaza lo que no calce (huecos y
// solapes). Compatibilidad: solo con guia_recepcion_id (panel antiguo) factura todo lo que falta
// hasta el fin del arriendo.
// Opcionales (038): monto_neto, monto_traslado, traslado_entrega, traslado_retiro, fecha_emision y
// fecha_vencimiento. Si llegan las partes del traslado sin el total, el total es su suma; si llegan los
// tres deben cuadrar. Un panel anterior que no los manda sigue funcionando igual.
router.post('/arriendo', verifyToken, requireRole('administrativo'), subidaPdf.single('archivo'), async (req, res) => {
    const { guia_recepcion_id, guia_despacho_id, periodo_desde, periodo_hasta, folio, monto, monto_traslado } = req.body;
    const { monto_neto, traslado_entrega, traslado_retiro, fecha_emision, fecha_vencimiento } = req.body;
    const conPeriodo = Boolean(guia_despacho_id);
    if ((!conPeriodo && !guia_recepcion_id) || !folio || !req.file) {
        return res.status(400).json({ error: 'guia_despacho_id (o guia_recepcion_id), folio y archivo (PDF) son requeridos' });
    }
    const folioValido = validarFolio(folio);
    if (folioValido.error) return res.status(400).json({ error: folioValido.error });
    if (conPeriodo && (!esDiaValido(periodo_desde) || !esDiaValido(periodo_hasta))) {
        return res.status(400).json({ error: 'periodo_desde y periodo_hasta son requeridos (AAAA-MM-DD)' });
    }
    // pesos chilenos enteros: sin puntos, decimales ni signo (el panel ya manda un entero)
    if (monto !== undefined && monto !== null && monto !== '' && montoEnteroONulo(monto) === null) {
        return res.status(400).json({ error: 'El monto debe ser un número entero de pesos, sin puntos ni decimales, de hasta 10 dígitos' });
    }
    const netoValido = validarNeto(monto, monto_neto);
    if (netoValido.error) return res.status(400).json({ error: netoValido.error });
    const trasladoValido = resolverTraslado({ monto, neto: netoValido.neto, monto_traslado, traslado_entrega, traslado_retiro });
    if (trasladoValido.error) return res.status(400).json({ error: trasladoValido.error });
    const fechas = validarFechasFactura({ fecha_emision, fecha_vencimiento });
    if (fechas.error) return res.status(400).json({ error: fechas.error });
    const idOrigen = Number(conPeriodo ? guia_despacho_id : guia_recepcion_id);
    if (!Number.isInteger(idOrigen) || idOrigen <= 0) {
        return res.status(400).json({ error: 'Id de guía inválido' });
    }
    let rutaStorage = null;
    let client = null;
    const rechazar = async (estado, cuerpo) => {
        await client.query('ROLLBACK');
        if (rutaStorage) await borrarArchivoSubido(BUCKET_DOCUMENTOS, rutaStorage);
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
                                   cliente_id, folio, archivo_url, monto, monto_traslado,
                                   monto_neto, traslado_entrega, traslado_retiro, fecha_emision, fecha_vencimiento)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
            [arriendo.maquinaria_id, cierra ? arriendo.guia_recepcion_id : null, arriendo.guia_despacho_id, desde, hasta,
             arriendo.cliente_id, folioValido.folio, rutaStorage, montoONulo(monto), trasladoValido.traslado,
             netoValido.neto, trasladoValido.entrega, trasladoValido.retiro, fechas.fecha_emision, fechas.fecha_vencimiento]
        );
        await client.query('COMMIT');
        res.status(201).json(conFechasTexto(result.rows[0]));
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (rutaStorage) {
            await borrarArchivoSubido(BUCKET_DOCUMENTOS, rutaStorage);
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

// reglas de cobro vigentes (dia de facturacion, hora de corte
// del despacho, si el dia de la recepcion cuenta). Las rutas fijas van antes de /:facturaId.
router.get('/configuracion', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
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
});

// solo el gerente. Cambia las claves enviadas; no reescribe
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

// solo lectura: equipos despachados que aun no vuelven,
// desde cuando se cobran, cuantos dias van y cuantos periodos (cortes) llevan sin facturar.
// Sale de las guias, no de maquinarias.cliente_id: un equipo con cliente cargado a mano y sin
// despacho no aparece. Un equipo tiene a lo mas un arriendo en curso: el del ultimo despacho.
router.get('/arriendos-en-curso', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
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
});

const ESTADOS_LISTA = Object.keys(FILTROS_ESTADO);

// facturas emitidas con su estado de cobranza (anulada, pagada, vencida,
// proxima, al_dia, sin_vencimiento), dias de mora y dias para vencer. Filtros: estado (vencidas, proximas,
// por_cobrar, pagadas, anuladas, todas), cliente_id, q (folio o cliente), desde/hasta (sobre la emision, o
// el dia de carga si no la tiene) y limit/offset. Vencidas y proximas usan el mismo predicado que las
// tarjetas de GET /api/dashboard/resumen. Sin archivo_url. Ruta fija: va antes de las de /:facturaId.
router.get('/emitidas', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const estado = req.query.estado === undefined || req.query.estado === '' ? 'todas' : req.query.estado;
    if (typeof estado !== 'string' || !ESTADOS_LISTA.includes(estado)) {
        return res.status(400).json({ error: `estado debe ser uno de: ${ESTADOS_LISTA.join(', ')}` });
    }
    let clienteId = null;
    if (req.query.cliente_id !== undefined && req.query.cliente_id !== '') {
        if (typeof req.query.cliente_id !== 'string' || !/^\d{1,9}$/.test(req.query.cliente_id) || Number(req.query.cliente_id) <= 0) {
            return res.status(400).json({ error: 'cliente_id inválido' });
        }
        clienteId = Number(req.query.cliente_id);
    }
    const dia = (v) => (v === undefined || v === '' ? null : (esDiaValido(v) ? v : undefined));
    const desde = dia(req.query.desde);
    const hasta = dia(req.query.hasta);
    if (desde === undefined || hasta === undefined) return res.status(400).json({ error: 'desde y hasta deben ser fechas válidas (AAAA-MM-DD)' });
    const { limit, offset } = parsearPaginacion(req.query);
    const q = parsearBusqueda(req.query);
    const r = await cargarEmitidas(pool, { estado, clienteId, q: q ? q.slice(0, 100) : null, desde, hasta, limit, offset });
    res.set('Cache-Control', 'no-store');
    res.json({ estado, hoy: r.hoy, ...envolver(r.items, r.total, { limit, offset }) });
});

// Excel con el formato de la hoja CLIENTES de la planilla de cobranza (una fila
// por factura, valores y no formulas). Cuerpo opcional: { desde, hasta, cliente_id } (desde/hasta sobre la
// emision, o el dia de carga si no la tiene). Sube el archivo al bucket privado de documentos
// (exportaciones/facturacion-usuario-<id>.xlsx, se sobrescribe) y responde
// { url, filas, sin_neto, generado_en }: url firmada de 1 hora; sin_neto = facturas sin monto neto guardado, cuyo
// neto se calculo como monto / 1,19. Tope de 5.000 filas (400 si se supera). Solo administrativo y gerente.
router.post('/exportar', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const cuerpo = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const dia = (v) => (v === undefined || v === null || v === '' ? null : (typeof v === 'string' && esDiaValido(v) ? v : undefined));
    const desde = dia(cuerpo.desde);
    const hasta = dia(cuerpo.hasta);
    if (desde === undefined || hasta === undefined) return res.status(400).json({ error: 'desde y hasta deben ser fechas válidas (AAAA-MM-DD)' });
    if (desde && hasta && desde > hasta) return res.status(400).json({ error: 'desde no puede ser posterior a hasta' });
    let clienteId = null;
    const c = cuerpo.cliente_id;
    if (c !== undefined && c !== null && c !== '') {
        if (!(typeof c === 'number' || typeof c === 'string') || !/^\d{1,9}$/.test(String(c)) || Number(c) <= 0) {
            return res.status(400).json({ error: 'cliente_id inválido' });
        }
        clienteId = Number(c);
    }
    try {
        const { items, hoy } = await cargarFilasExportacion(pool, { desde, hasta, clienteId });
        if (items.length > MAX_FILAS_EXPORTACION) {
            return res.status(400).json({ error: `La exportación supera las ${MAX_FILAS_EXPORTACION} facturas: acota el rango de fechas` });
        }
        const generado = hoy || hoySantiago();
        const hoja = armarHoja(items, { hoy: generado, generado });
        const archivo = crearXlsx({ hoja: NOMBRE_HOJA_EXPORTACION, filas: hoja.matriz });
        const ruta = `exportaciones/facturacion-usuario-${Number(req.user.id)}.xlsx`;
        const almacen = supabase.storage.from(BUCKET_DOCUMENTOS);
        const { error: errorSubida } = await almacen.upload(ruta, archivo, { contentType: TIPO_XLSX, upsert: true });
        if (errorSubida) {
            console.error('Error al subir la exportación:', errorSubida.message);
            return res.status(500).json({ error: 'No se pudo guardar el archivo de la exportación' });
        }
        const { data, error: errorUrl } = await almacen.createSignedUrl(ruta, URL_EXPIRACION_SEGUNDOS);
        if (errorUrl || !data || !data.signedUrl) {
            console.error('Error al firmar la exportación:', errorUrl && errorUrl.message);
            return res.status(500).json({ error: 'No se pudo generar el enlace de descarga' });
        }
        res.set('Cache-Control', 'no-store');
        res.json({ url: data.signedUrl, filas: hoja.filas, sin_neto: hoja.sin_neto, generado_en: generado });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al exportar la facturación' });
    }
});

const tiene = (obj, clave) => Object.prototype.hasOwnProperty.call(obj, clave);
const vacio = (v) => v === undefined || v === null || v === '';
const aNumeroONulo = (v) => (v === null || v === undefined ? null : Number(v));

// cobranza (038): { fecha_pago } marca la factura pagada (null la
// deja por cobrar) y { anulada_nc } la marca anulada con nota de credito guardando el folio de la NC (null
// lo deshace). Se puede mandar uno o los dos. Solo el administrativo; el gerente consulta la lista.
// No cambia el contenido de la factura: no pasa por la regla del correo pendiente ni cancela correos.
// Una factura anulada con NC deja de contar como ingreso del equipo (utils/rentabilidad.js) pero NO libera
// el periodo facturado. Responde la fila como en GET /emitidas.
router.patch('/:facturaId/pago', verifyToken, requireRole('administrativo'), subidaComprobante.single('archivo'), async (req, res) => {
    const cuerpo = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const conPago = tiene(cuerpo, 'fecha_pago');
    const conNc = tiene(cuerpo, 'anulada_nc');
    if (!conPago && !conNc) return res.status(400).json({ error: 'Indica fecha_pago o anulada_nc' });
    const pago = conPago ? validarFechaPago(cuerpo.fecha_pago) : null;
    if (pago && pago.error) return res.status(400).json({ error: pago.error });
    const nc = conNc ? validarFolioNotaCredito(cuerpo.anulada_nc) : null;
    if (nc && nc.error) return res.status(400).json({ error: nc.error });
    // el comprobante (foto o PDF) viaja como multipart junto con la fecha de pago
    if (req.file && !(conPago && pago.fecha_pago)) {
        return res.status(400).json({ error: 'El comprobante se adjunta junto con la fecha de pago' });
    }
    const id = Number(req.params.facturaId);
    let client;
    let rutaNueva = null;
    const borrarArchivo = async (ruta) => {
        if (ruta) await borrarArchivoSubido(BUCKET_DOCUMENTOS, ruta);
    };
    try {
        // el archivo se sube ANTES de tomar la conexion de la base: una subida lenta no la deja retenida
        if (req.file) {
            const existe = await pool.query('SELECT 1 FROM facturas WHERE id = $1', [id]);
            if (existe.rows.length === 0) return res.status(404).json({ error: 'Factura no encontrada' });
            rutaNueva = rutaArchivo(['comprobantes', id], req.file.originalname);
            const { error: errorSubida } = await supabase.storage
                .from(BUCKET_DOCUMENTOS)
                .upload(rutaNueva, req.file.buffer, { contentType: req.file.mimetype });
            if (errorSubida) {
                rutaNueva = null;
                throw errorSubida;
            }
        }
        client = await pool.connect();
        await client.query('BEGIN');
        const fila = await client.query(
            'SELECT fecha_pago, comprobante_pago_ruta FROM facturas WHERE id = $1 FOR UPDATE', [id]
        );
        if (fila.rows.length === 0) {
            await client.query('ROLLBACK');
            await borrarArchivo(rutaNueva);
            return res.status(404).json({ error: 'Factura no encontrada' });
        }
        const previa = fila.rows[0];
        // pasar de por cobrar a pagada exige el comprobante. Cambiar la fecha de una factura que ya estaba
        // pagada antes de existir el comprobante no lo exige (quedan "sin comprobante", sin pedirles nada)
        if (conPago && pago.fecha_pago && previa.fecha_pago === null && !rutaNueva) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Para marcar la factura como pagada adjunta el comprobante de pago (foto JPG, PNG o PDF de hasta 10 MB)' });
        }
        const deshacePago = conPago && pago.fecha_pago === null;
        // deshacer el pago borra el comprobante; subir uno nuevo reemplaza al anterior
        const rutaFinal = deshacePago ? null : (rutaNueva || previa.comprobante_pago_ruta);
        await client.query(
            `UPDATE facturas SET
                 fecha_pago = CASE WHEN $2 THEN $3::date ELSE fecha_pago END,
                 anulada_nc = CASE WHEN $4 THEN $5::varchar ELSE anulada_nc END,
                 comprobante_pago_ruta = $6
             WHERE id = $1`,
            [id, conPago, conPago ? pago.fecha_pago : null, conNc, conNc ? nc.anulada_nc : null, rutaFinal]
        );
        await client.query('COMMIT');
        // ya confirmado: el archivo anterior (reemplazado o de un pago deshecho) ya no lo usa nadie
        if (previa.comprobante_pago_ruta && previa.comprobante_pago_ruta !== rutaFinal) {
            await borrarArchivo(previa.comprobante_pago_ruta);
        }
        const r = await cargarEmitidas(pool, { id });
        res.json(r.items[0]);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        // si la base fallo con el archivo ya subido, no dejarlo huerfano
        await borrarArchivo(rutaNueva);
        console.error(err);
        res.status(500).json({ error: 'Error al registrar el pago de la factura' });
    } finally {
        if (client) client.release();
    }
});

// URL firmada (1 hora) del comprobante de pago. 404 si la
// factura no existe o no tiene comprobante (las pagadas antes de existir esta regla no lo tienen).
router.get('/:facturaId/comprobante', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const r = await pool.query('SELECT comprobante_pago_ruta FROM facturas WHERE id = $1', [Number(req.params.facturaId)]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Factura no encontrada' });
    const ruta = r.rows[0].comprobante_pago_ruta;
    if (!ruta) return res.status(404).json({ error: 'Esta factura no tiene comprobante de pago' });
    const { data, error } = await firmarUrl(supabase, BUCKET_DOCUMENTOS, ruta);
    if (error || !data || !data.signedUrl) {
        console.error('Error al firmar el comprobante:', error && error.message);
        return res.status(500).json({ error: 'No se pudo generar el enlace del comprobante' });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ url: data.signedUrl });
});

// corrige folio/monto despues de creada la factura
// (por si la deteccion del PDF se equivoco), funciona para cualquier tipo de factura.
// Desde la 038 corrige tambien monto_neto, traslado_entrega, traslado_retiro, fecha_emision y
// fecha_vencimiento. Un campo ausente no cambia; presente con null o '' lo borra (monto_neto y fechas).
// Si llega alguna parte del traslado, se toman las dos del cuerpo (la que falta vale 0) y, sin
// monto_traslado, el total es su suma. Si llega solo monto_traslado, la division guardada se mantiene si
// sigue cuadrando (si no, el trigger de la 038 la borra).
router.patch('/:facturaId', verifyToken, requireRole('administrativo'), async (req, res) => {
    const cuerpo = req.body || {};
    const { folio, monto, monto_traslado } = cuerpo;
    if (!/^\d{1,9}$/.test(String(req.params.facturaId))) return res.status(400).json({ error: 'Id de factura inválido' });
    // formato de lo nuevo; las reglas contra lo ya guardado se revisan con la fila bloqueada
    if (tiene(cuerpo, 'monto_neto') && !vacio(cuerpo.monto_neto) && montoEnteroONulo(cuerpo.monto_neto) === null) {
        return res.status(400).json({ error: 'El monto neto debe ser un número entero de pesos, sin puntos ni decimales, de hasta 10 dígitos' });
    }
    const fechasEnviadas = validarFechasFactura({
        fecha_emision: tiene(cuerpo, 'fecha_emision') ? cuerpo.fecha_emision : undefined,
        fecha_vencimiento: tiene(cuerpo, 'fecha_vencimiento') ? cuerpo.fecha_vencimiento : undefined,
    });
    if (fechasEnviadas.error) return res.status(400).json({ error: fechasEnviadas.error });
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
        const fila = await client.query(
            `SELECT id, monto, monto_traslado, monto_neto, traslado_entrega, traslado_retiro,
                    to_char(fecha_emision, 'YYYY-MM-DD') AS fecha_emision, to_char(fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento
             FROM facturas WHERE id = $1 FOR UPDATE`, [req.params.facturaId]);
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
        const guardada = fila.rows[0];
        const montoGuardado = aNumeroONulo(guardada.monto);
        const montoFinal = montoONulo(monto) ?? montoGuardado;
        const rechazarCambio = async (mensaje) => {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: mensaje });
        };
        // neto final: lo enviado (null lo borra) o lo guardado; no mayor que el monto final
        const netoFinal = validarNeto(montoFinal, tiene(cuerpo, 'monto_neto') ? cuerpo.monto_neto : aNumeroONulo(guardada.monto_neto));
        if (netoFinal.error) return await rechazarCambio(netoFinal.error);
        const trasladoEnviado = !vacio(monto_traslado);
        const trasladoBase = trasladoEnviado ? monto_traslado : aNumeroONulo(guardada.monto_traslado);
        const partesEnviadas = tiene(cuerpo, 'traslado_entrega') || tiene(cuerpo, 'traslado_retiro');
        let traslado;
        if (partesEnviadas && (!vacio(cuerpo.traslado_entrega) || !vacio(cuerpo.traslado_retiro))) {
            traslado = resolverTraslado({
                monto: montoFinal, neto: netoFinal.neto, monto_traslado: trasladoEnviado ? monto_traslado : undefined,
                traslado_entrega: cuerpo.traslado_entrega, traslado_retiro: cuerpo.traslado_retiro,
            });
        } else {
            const v = validarTraslado(montoFinal, trasladoBase, netoFinal.neto);
            traslado = v.error ? v : {
                traslado: v.traslado,
                // partes enviadas vacias = sin division; sin partes, la guardada (el trigger la borra si ya no cuadra)
                entrega: partesEnviadas ? null : aNumeroONulo(guardada.traslado_entrega),
                retiro: partesEnviadas ? null : aNumeroONulo(guardada.traslado_retiro),
            };
        }
        if (traslado.error) return await rechazarCambio(traslado.error);
        // fechas finales: el vencimiento no puede quedar antes de la emision (solo si se cambio alguna)
        const emisionFinal = tiene(cuerpo, 'fecha_emision') ? fechasEnviadas.fecha_emision : guardada.fecha_emision;
        const vencimientoFinal = tiene(cuerpo, 'fecha_vencimiento') ? fechasEnviadas.fecha_vencimiento : guardada.fecha_vencimiento;
        if ((tiene(cuerpo, 'fecha_emision') || tiene(cuerpo, 'fecha_vencimiento'))
            && emisionFinal && vencimientoFinal && vencimientoFinal < emisionFinal) {
            return await rechazarCambio('La fecha de vencimiento no puede ser anterior a la emisión');
        }
        const result = await client.query(
            `UPDATE facturas SET folio = COALESCE($1, folio), monto = COALESCE($2, monto), monto_traslado = $3,
                    monto_neto = $4, traslado_entrega = $5, traslado_retiro = $6, fecha_emision = $7, fecha_vencimiento = $8
             WHERE id = $9 RETURNING *`,
            [folioNuevo, montoONulo(monto), traslado.traslado, netoFinal.neto, traslado.entrega, traslado.retiro,
             emisionFinal, vencimientoFinal, req.params.facturaId]
        );
        // un correo anterior que agoto sus reintentos (error) llevaba el folio y el monto viejos
        await cancelarCorreosPrevios(client, req.params.facturaId, 'Factura corregida');
        await client.query('COMMIT');
        res.json(conFechasTexto(result.rows[0]));
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar la factura' });
    } finally {
        if (client) client.release();
    }
});

// asunto y cuerpo propuestos para el correo, el periodo
// facturado y si ya hay un envio pendiente. El texto por defecto vive solo aca (utils/correoFactura.js).
router.get('/:facturaId/vista-previa', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    if (!/^\d{1,9}$/.test(String(req.params.facturaId))) return res.status(400).json({ error: 'Id de factura inválido' });
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
        // las fotos de la OT las trae GET /api/ordenes-trabajo/:id/evidencia (el panel ya las muestra); aqui solo
        // la seleccion del ultimo correo de esta factura, para que un reenvio y el cuadro la repitan
        fotos_elegidas_antes: await fotosDelUltimoCorreo(pool, factura),
    });
});

// Funciona para cualquier factura, sea de reparacion (orden_trabajo_id) o de arriendo (maquinaria_id).
// Acepta { asunto, cuerpo } editados; sin ellos usa el texto por defecto. Ver encolarCorreoFactura
// (bloqueo contra la anulacion). `foto_ids` (opcional, solo facturas de reparacion): las fotos del antes y el
// despues que van adjuntas junto al PDF; se miden reducidas antes de aceptar (tope de peso en fotosCorreo.js). Sin
// foto_ids (un reenvio) se repite la seleccion del ultimo correo; una lista vacia significa "sin fotos".
router.post('/:facturaId/autorizar-envio', verifyToken, requireRole('administrativo'), async (req, res) => {
    if (!/^\d{1,9}$/.test(String(req.params.facturaId))) return res.status(400).json({ error: 'Id de factura inválido' });
    const cuerpoPeticion = req.body || {};
    const fotos = await validarFotosDelEnvio(pool, supabase, BUCKET, { facturaId: req.params.facturaId, fotoIds: cuerpoPeticion.foto_ids });
    if (fotos.error) return res.status(fotos.status).json({ error: fotos.error });
    const r = await encolarCorreoFactura(pool, {
        facturaId: req.params.facturaId, asunto: cuerpoPeticion.asunto, cuerpo: cuerpoPeticion.cuerpo, fotoIds: fotos.ids,
    });
    res.status(r.status).json(r.body);
});

module.exports = router;
