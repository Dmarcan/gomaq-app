// Correo de la factura: texto por defecto, validacion del texto editado y cancelacion de los
// correos encolados cuando la factura se anula. Funciones puras salvo las que reciben un cliente
// de base de datos (`db`) y deben llamarse dentro de la transaccion de quien las usa.

const { encolarNotificacion } = require('./avisos');
const {
    validarIdsFotos, leerFotosDeOrden, prepararAdjuntosFotos, descargadorDeBucket, formatearMb, MAX_BYTES_FOTOS,
} = require('./fotosCorreo');

const MAX_ASUNTO = 200;
const MAX_CUERPO = 5000;

/** 'YYYY-MM-DD' (o Date) a 'dd-mm-aaaa'. Un valor vacio da null. */
function formatearDia(valor) {
    if (!valor) return null;
    const texto = valor instanceof Date ? valor.toISOString().slice(0, 10) : String(valor).slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Asunto y cuerpo que se proponen al administrativo. `factura` trae folio, cliente, periodo, OT y equipo. */
function textoPorDefecto(factura) {
    const folio = factura.folio;
    const desde = formatearDia(factura.periodo_desde);
    const hasta = formatearDia(factura.periodo_hasta);
    let concepto;
    if (factura.orden_trabajo_id) concepto = `la orden de trabajo #${factura.orden_trabajo_id}`;
    else if (factura.maquinaria_codigo) concepto = `el arriendo del equipo ${factura.maquinaria_codigo}`;
    else concepto = 'su servicio';
    const periodo = desde && hasta ? `, por el período del ${desde} al ${hasta}` : '';
    const saludo = factura.cliente_nombre ? `Estimado/a ${factura.cliente_nombre}:` : 'Estimado/a cliente:';
    return {
        asunto: `Factura folio ${folio} - GOMAQ Maquinarias`,
        cuerpo: `${saludo}\n\nAdjuntamos la factura folio ${folio} correspondiente a ${concepto}${periodo}.`
            + '\n\nGOMAQ Maquinarias',
    };
}

// Caracteres de control: en el asunto no se admite ninguno (tampoco los separadores de linea de
// Unicode: U+0085, U+2028 y U+2029) para evitar la inyeccion de cabeceras cuando haya proveedor; en el
// cuerpo solo se admiten salto de linea y tabulacion. Un NUL tambien reventaria el INSERT del JSONB.
const CONTROL_ASUNTO = /[\u0000-\u001F\u007F\u0085\u2028\u2029]/;
const CONTROL_CUERPO = /[\u0000-\u0008\u000B-\u001F\u007F]/;

/**
 * Valida el texto que edito el administrativo. Un campo ausente o vacio usa el texto por defecto.
 * El cuerpo es texto plano (text/plain): si algun dia se arma un correo HTML hay que escapar.
 */
function validarTexto({ asunto, cuerpo } = {}, porDefecto) {
    const limpio = (v) => (typeof v === 'string' ? v.trim() : v);
    const a = limpio(asunto);
    const c = typeof cuerpo === 'string' ? cuerpo.replace(/\r\n/g, '\n').trim() : cuerpo;
    if (a !== undefined && a !== null && typeof a !== 'string') return { error: 'El asunto debe ser texto' };
    if (c !== undefined && c !== null && typeof c !== 'string') return { error: 'El cuerpo debe ser texto' };
    const asuntoFinal = a ? a : porDefecto.asunto;
    const cuerpoFinal = c ? c : porDefecto.cuerpo;
    if (CONTROL_ASUNTO.test(asuntoFinal)) return { error: 'El asunto no puede tener saltos de línea ni caracteres de control' };
    if (CONTROL_CUERPO.test(cuerpoFinal)) return { error: 'El mensaje tiene caracteres no permitidos' };
    if (asuntoFinal.length > MAX_ASUNTO) return { error: `El asunto admite hasta ${MAX_ASUNTO} caracteres` };
    if (cuerpoFinal.length > MAX_CUERPO) return { error: `El cuerpo admite hasta ${MAX_CUERPO} caracteres` };
    return { asunto: asuntoFinal, cuerpo: cuerpoFinal };
}

/** Folio de una factura: letras, numeros, punto, guion, barra y espacios, de 1 a 50, sin saltos de linea. */
function validarFolio(folio) {
    if (typeof folio !== 'string' && typeof folio !== 'number') return { error: 'El folio debe ser texto' };
    const texto = String(folio).trim();
    if (!/^[\w.\-/ ]{1,50}$/.test(texto)) {
        return { error: 'El folio solo admite letras, números, punto, guion, barra y espacios (hasta 50 caracteres)' };
    }
    return { folio: texto };
}

/**
 * Cancela los correos `factura_emitida` que aun no salieron (pendiente o error) de una factura.
 * Cubre los encolados antes de que el payload llevara factura_id, por orden y folio.
 * Debe correr en la misma transaccion que borra la factura.
 */
async function cancelarCorreosFactura(db, factura) {
    const r = await db.query(
        `UPDATE notificaciones_pendientes
         SET estado = 'cancelado', ultimo_error = 'Factura anulada'
         WHERE estado IN ('pendiente', 'error')
           AND payload->>'tipo' = 'factura_emitida'
           AND (payload->>'factura_id' = $1::text
                OR (payload->>'factura_id' IS NULL
                    AND $2::text IS NOT NULL
                    AND payload->>'orden_trabajo_id' = $2::text
                    AND payload->>'folio' = $3::text))`,
        [factura.id, factura.orden_trabajo_id === null || factura.orden_trabajo_id === undefined ? null : factura.orden_trabajo_id, factura.folio]
    );
    return r.rowCount;
}

/**
 * Pasa a 'cancelado' los correos de esta factura que no salieron (pendiente o error) con el motivo dado
 * ('Reemplazado', 'Factura corregida'). Se usa al encolar uno nuevo y al corregir folio o monto.
 */
async function cancelarCorreosPrevios(db, facturaId, motivo) {
    const r = await db.query(
        `UPDATE notificaciones_pendientes SET estado = 'cancelado', ultimo_error = $2
         WHERE estado IN ('pendiente', 'error') AND payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1::text`,
        [facturaId, motivo]
    );
    return r.rowCount;
}

const CONSULTA_FACTURA = `
    SELECT f.id, f.folio, f.monto, f.orden_trabajo_id, f.maquinaria_id,
           to_char(f.periodo_desde, 'YYYY-MM-DD') AS periodo_desde, to_char(f.periodo_hasta, 'YYYY-MM-DD') AS periodo_hasta,
           m.codigo AS maquinaria_codigo, ot.maquinaria_id AS ot_maquinaria_id,
           c.nombre AS cliente_nombre, c.email AS cliente_email
    FROM facturas f
    LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
    LEFT JOIN guias g ON g.id = f.guia_recepcion_id
    LEFT JOIN clientes c ON c.id = COALESCE(f.cliente_id, ot.cliente_id, g.cliente_id)
    LEFT JOIN maquinarias m ON m.id = COALESCE(f.maquinaria_id, ot.maquinaria_id)`;

/** Datos de la factura para armar el correo (sin bloquear). null si no existe o no es de esa orden. */
async function leerFacturaParaCorreo(db, facturaId, ordenId = null) {
    const r = await db.query(
        `${CONSULTA_FACTURA} WHERE f.id = $1 AND ($2::int IS NULL OR f.orden_trabajo_id = $2::int)`,
        [facturaId, ordenId]
    );
    return r.rows[0] || null;
}

/** Hay un correo de esta factura esperando salir. */
async function hayEnvioPendiente(db, facturaId) {
    const r = await db.query(
        `SELECT 1 FROM notificaciones_pendientes
         WHERE estado = 'pendiente' AND payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1::text
         LIMIT 1`,
        [facturaId]
    );
    return r.rows.length > 0;
}

/**
 * Ids de las fotos que llevo el ultimo correo de esta factura (del mismo payload con que se encolo), solo las que
 * siguen existiendo en su orden. Un reenvio repite esa seleccion; el cuadro de la factura la marca de nuevo.
 */
async function fotosDelUltimoCorreo(db, factura) {
    if (!factura || !factura.orden_trabajo_id) return [];
    const previo = await db.query(
        `SELECT payload->'foto_ids' AS foto_ids FROM notificaciones_pendientes
         WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1::text
         ORDER BY id DESC LIMIT 1`,
        [factura.id]
    );
    const ids = previo.rows[0] && Array.isArray(previo.rows[0].foto_ids) ? previo.rows[0].foto_ids.filter(Number.isInteger) : [];
    if (ids.length === 0) return [];
    const vigentes = await db.query(
        'SELECT id FROM evidencias_fotograficas WHERE orden_trabajo_id = $1 AND id = ANY($2::int[])',
        [factura.orden_trabajo_id, ids]
    );
    const existen = new Set(vigentes.rows.map((f) => f.id));
    return ids.filter((id) => existen.has(id));
}

/**
 * Comprueba las fotos que el administrativo eligio para el correo ANTES de encolarlo: que sean ids validos,
 * que todas sean de la orden de la factura y que, reducidas, quepan en el tope de peso. Se hace fuera de la
 * transaccion del envio porque descargar y reducir toma segundos y no conviene tener la factura bloqueada.
 * Devuelve { ids } (lista vacia si no se pidieron fotos) o { status, error } listo para responder.
 *
 * @param {object} supabase  cliente de Supabase (solo se usa si hay fotos)
 * @param {string} bucket    bucket de las evidencias
 */
async function validarFotosDelEnvio(db, supabase, bucket, { facturaId, ordenId = null, fotoIds, descargar = null, reducir = undefined }) {
    const noEncontrada = { status: 404, error: ordenId ? 'Factura no encontrada para esta orden de trabajo' : 'Factura no encontrada' };
    let factura = null;
    let pedidas = fotoIds;
    if (pedidas === undefined || pedidas === null) {
        // sin lista (por ejemplo, un reenvio desde Notificaciones): se repite la seleccion del ultimo correo
        factura = await leerFacturaParaCorreo(db, facturaId, ordenId);
        if (!factura) return noEncontrada;
        pedidas = await fotosDelUltimoCorreo(db, factura);
    }
    const v = validarIdsFotos(pedidas);
    if (v.error) return { status: 400, error: v.error };
    if (v.ids.length === 0) return { ids: [] };
    if (!factura) factura = await leerFacturaParaCorreo(db, facturaId, ordenId);
    if (!factura) return noEncontrada;
    if (!factura.orden_trabajo_id) return { status: 400, error: 'Esta factura no tiene orden de trabajo: no admite fotos' };
    const leidas = await leerFotosDeOrden(db, factura.orden_trabajo_id, v.ids);
    if (leidas.error) return { status: 400, error: leidas.error };
    let preparadas;
    try {
        preparadas = await prepararAdjuntosFotos({ fotos: leidas.fotos, descargar: descargar || descargadorDeBucket(supabase, bucket), ...(reducir ? { reducir } : {}) });
    } catch (err) {
        console.error('[correoFactura] no se pudieron preparar las fotos:', err.message);
        return { status: 503, error: 'No se pudieron leer las fotos para medir su peso. Intenta de nuevo en un momento' };
    }
    if (preparadas.faltantes.length > 0) {
        return { status: 409, error: 'Alguna de las fotos elegidas ya no está disponible: actualiza la vista previa' };
    }
    if (preparadas.excede) {
        return {
            status: 400,
            error: `Las fotos pesan ${formatearMb(preparadas.total)} ya reducidas y el máximo es ${formatearMb(MAX_BYTES_FOTOS)}: quita algunas`,
        };
    }
    return { ids: v.ids };
}

/**
 * Encola el correo de una factura. Va en una transaccion propia: bloquea la fila de la factura
 * (la anulacion tambien la bloquea, asi que una de las dos espera a la otra y nunca queda un correo
 * pendiente de una factura que ya no existe) y rechaza un segundo envio mientras haya uno pendiente.
 * Devuelve { status, body } listo para responder.
 */
async function encolarCorreoFactura(pool, { facturaId, ordenId = null, asunto, cuerpo, fotoIds = [] }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const bloqueo = await client.query(
            `SELECT id FROM facturas WHERE id = $1 AND ($2::int IS NULL OR orden_trabajo_id = $2::int) FOR NO KEY UPDATE`,
            [facturaId, ordenId]
        );
        if (bloqueo.rows.length === 0) {
            await client.query('ROLLBACK');
            return { status: 404, body: { error: ordenId ? 'Factura no encontrada para esta orden de trabajo' : 'Factura no encontrada' } };
        }
        const factura = await leerFacturaParaCorreo(client, facturaId, ordenId);
        if (!factura.cliente_email) {
            await client.query('ROLLBACK');
            return { status: 400, body: { error: 'El cliente no tiene un correo registrado' } };
        }
        const texto = validarTexto({ asunto, cuerpo }, textoPorDefecto(factura));
        if (texto.error) {
            await client.query('ROLLBACK');
            return { status: 400, body: { error: texto.error } };
        }
        // las fotos ya se midieron antes (validarFotosDelEnvio); aqui solo se confirma, con la factura
        // bloqueada, que sigan siendo de la orden de esta factura
        if (fotoIds.length > 0) {
            const fotos = factura.orden_trabajo_id ? await leerFotosDeOrden(client, factura.orden_trabajo_id, fotoIds) : { error: 'Esta factura no tiene orden de trabajo: no admite fotos' };
            if (fotos.error) {
                await client.query('ROLLBACK');
                return { status: 400, body: { error: fotos.error } };
            }
        }
        if (await hayEnvioPendiente(client, facturaId)) {
            await client.query('ROLLBACK');
            return { status: 409, body: { error: 'Esta factura ya tiene un envío pendiente' } };
        }
        // un correo en error de un intento anterior ya no corresponde: este lo reemplaza
        await cancelarCorreosPrevios(client, facturaId, 'Reemplazado');
        await encolarNotificacion(client, {
            canal: 'email', destinatario: factura.cliente_email,
            payload: {
                tipo: 'factura_emitida',
                factura_id: factura.id,
                orden_trabajo_id: factura.orden_trabajo_id,
                maquinaria_codigo: factura.maquinaria_codigo,
                folio: factura.folio,
                monto: factura.monto,
                cliente_nombre: factura.cliente_nombre,
                periodo_desde: factura.periodo_desde,
                periodo_hasta: factura.periodo_hasta,
                asunto: texto.asunto,
                cuerpo: texto.cuerpo,
                ...(fotoIds.length > 0 ? { foto_ids: fotoIds } : {}),
            },
        });
        await client.query('COMMIT');
        return { status: 200, body: { ok: true, mensaje: 'Envio de correo encolado' } };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

module.exports = {
    MAX_ASUNTO, MAX_CUERPO, formatearDia, textoPorDefecto, validarTexto, validarFolio, cancelarCorreosFactura, cancelarCorreosPrevios,
    leerFacturaParaCorreo, hayEnvioPendiente, encolarCorreoFactura, validarFotosDelEnvio, fotosDelUltimoCorreo,
};
