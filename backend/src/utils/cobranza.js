// Cobranza de facturas: estado, dias de mora y vencimiento propuesto (migracion 038).
//
// Nada de esto se guarda calculado: en la base solo estan fecha_emision, fecha_vencimiento, fecha_pago y
// anulada_nc. El estado sale de aqui con el dia de hoy en America/Santiago:
//   anulada          anulada_nc tiene valor (nota de credito en el SII)
//   pagada           hay fecha_pago
//   vencida          hoy es POSTERIOR al vencimiento (vence el dia siguiente, como la planilla de cobranza)
//   proxima          faltan de 0 a 7 dias para el vencimiento
//   al_dia           faltan mas de 7 dias
//   sin_vencimiento  no hay fecha de vencimiento (las facturas cargadas antes de la 038: no se inventa una)
//
// El contador de las tarjetas del inicio y la lista de facturas emitidas usan los MISMOS predicados SQL
// (SQL_FACTURAS_VENCIDAS y SQL_FACTURAS_PROXIMAS, patron de utils/pendientes.js). La lista calcula el
// estado de cada fila con estadoCobranza() pero con el "hoy" que devuelve la propia consulta, asi el
// numero de la tarjeta y la lista no discrepan ni siquiera a medianoche.

const { diaSantiago, sumarDias } = require('./diasArriendo');
const { esDiaValido } = require('./validacion');

const DIAS_PROXIMA = 7;
const ESTADOS = ['anulada', 'pagada', 'vencida', 'proxima', 'al_dia', 'sin_vencimiento'];
const FECHA_MINIMA = '2000-01-01';
const PLAZO_MAXIMO = 365;

/** Hoy en Santiago, en SQL. Una sola definicion para todos los predicados. */
const SQL_HOY = `((now() AT TIME ZONE 'America/Santiago')::date)`;

/** Facturas por cobrar (ni pagadas ni anuladas). `f` es el alias de facturas. */
const SQL_FACTURAS_POR_COBRAR = `f.anulada_nc IS NULL AND f.fecha_pago IS NULL`;
/** Vencidas: por cobrar y con el vencimiento ya pasado (hoy es posterior). */
const SQL_FACTURAS_VENCIDAS = `${SQL_FACTURAS_POR_COBRAR} AND f.fecha_vencimiento < ${SQL_HOY}`;
/** Proximas a vencer: por cobrar y faltan de 0 a 7 dias. */
const SQL_FACTURAS_PROXIMAS = `${SQL_FACTURAS_POR_COBRAR} AND f.fecha_vencimiento BETWEEN ${SQL_HOY} AND ${SQL_HOY} + ${DIAS_PROXIMA}`;
const SQL_FACTURAS_PAGADAS = `f.anulada_nc IS NULL AND f.fecha_pago IS NOT NULL`;
const SQL_FACTURAS_ANULADAS = `f.anulada_nc IS NOT NULL`;

/** Filtro de la lista de emitidas -> predicado. `todas` no filtra. */
const FILTROS_ESTADO = {
    vencidas: SQL_FACTURAS_VENCIDAS,
    proximas: SQL_FACTURAS_PROXIMAS,
    por_cobrar: SQL_FACTURAS_POR_COBRAR,
    pagadas: SQL_FACTURAS_PAGADAS,
    anuladas: SQL_FACTURAS_ANULADAS,
    todas: 'TRUE',
};

const MS_DIA = 86400000;
const aUtc = (dia) => Date.parse(`${dia}T00:00:00Z`);
/** Dias de b menos a (dos fechas YYYY-MM-DD). */
const diasEntreFechas = (a, b) => Math.round((aUtc(b) - aUtc(a)) / MS_DIA);

/** Fecha de la base o de la peticion a 'YYYY-MM-DD', o null. Acepta Date (medianoche UTC de node-pg no se usa: las consultas usan to_char). */
function aDia(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    const texto = String(v).slice(0, 10);
    return esDiaValido(texto) ? texto : null;
}

const anulada = (f) => typeof f.anulada_nc === 'string' ? f.anulada_nc.trim() !== '' : f.anulada_nc !== null && f.anulada_nc !== undefined;

/** Hoy en Santiago como 'YYYY-MM-DD'. */
function hoySantiago(ahora = new Date()) {
    return diaSantiago(ahora);
}

/**
 * Estado de cobranza de una factura.
 * @param {{fecha_vencimiento?, fecha_pago?, anulada_nc?}} factura
 * @param {string} hoy 'YYYY-MM-DD' (Santiago)
 */
function estadoCobranza(factura, hoy = hoySantiago()) {
    const f = factura || {};
    if (anulada(f)) return 'anulada';
    if (aDia(f.fecha_pago)) return 'pagada';
    const venc = aDia(f.fecha_vencimiento);
    if (!venc) return 'sin_vencimiento';
    const faltan = diasEntreFechas(hoy, venc);
    if (faltan < 0) return 'vencida';
    if (faltan <= DIAS_PROXIMA) return 'proxima';
    return 'al_dia';
}

/**
 * Dias de mora: de la vencida, hoy menos vencimiento; de la pagada tarde, pago menos vencimiento; en el
 * resto (anulada, a tiempo, sin vencimiento), 0.
 */
function diasMora(factura, hoy = hoySantiago()) {
    const f = factura || {};
    if (anulada(f)) return 0;
    const venc = aDia(f.fecha_vencimiento);
    if (!venc) return 0;
    const pago = aDia(f.fecha_pago);
    const hasta = pago || hoy;
    return Math.max(0, diasEntreFechas(venc, hasta));
}

/** Dias que faltan para el vencimiento de una factura por cobrar (0 = vence hoy); null si no aplica o ya vencio. */
function diasParaVencer(factura, hoy = hoySantiago()) {
    const estado = estadoCobranza(factura, hoy);
    if (estado !== 'proxima' && estado !== 'al_dia') return null;
    return diasEntreFechas(hoy, aDia(factura.fecha_vencimiento));
}

/**
 * Vencimiento que se propone al subir una factura.
 *   - Con fecha en el PDF: esa (es la del documento emitido en el SII). Si el cliente tiene plazo habitual y
 *     emision + plazo no da lo mismo, `coincide` es false y `alternativa` trae la fecha del plazo: el panel
 *     muestra las dos opciones con la del PDF preseleccionada (no bloquea).
 *   - Sin fecha en el PDF: emision + plazo del cliente.
 *   - Sin ninguna: null (el campo queda vacio y es opcional).
 * @returns {{propuesta: string|null, origen: 'pdf'|'plazo_cliente'|null, alternativa: string|null,
 *            coincide: boolean|null, dias_pdf: number|null, plazo_cliente_dias: number|null}}
 */
function vencimientoPropuesto({ emision, vencimientoPdf, plazoCliente } = {}) {
    const em = aDia(emision);
    const vpdf = aDia(vencimientoPdf);
    const plazo = Number.isInteger(plazoCliente) && plazoCliente >= 0 && plazoCliente <= PLAZO_MAXIMO ? plazoCliente : null;
    const desdePlazo = em && plazo !== null ? sumarDias(em, plazo) : null;
    const diasPdf = em && vpdf ? diasEntreFechas(em, vpdf) : null;
    if (vpdf) {
        const coincide = desdePlazo === null ? null : desdePlazo === vpdf;
        return {
            propuesta: vpdf, origen: 'pdf', alternativa: coincide === false ? desdePlazo : null,
            coincide, dias_pdf: diasPdf, plazo_cliente_dias: plazo,
        };
    }
    if (desdePlazo) {
        return { propuesta: desdePlazo, origen: 'plazo_cliente', alternativa: null, coincide: null, dias_pdf: null, plazo_cliente_dias: plazo };
    }
    return { propuesta: null, origen: null, alternativa: null, coincide: null, dias_pdf: null, plazo_cliente_dias: plazo };
}

const vacio = (v) => v === undefined || v === null || v === '';
const ddmmaaaa = (dia) => `${dia.slice(8, 10)}-${dia.slice(5, 7)}-${dia.slice(0, 4)}`;

/** Texto del aviso cuando el vencimiento del PDF no coincide con el plazo habitual del cliente. */
function textoAvisoPlazo(v) {
    const dias = v.dias_pdf === null ? '' : ` (${v.dias_pdf} días)`;
    return `La fecha de vencimiento de la factura (${ddmmaaaa(v.propuesta)}${dias}) no coincide con el plazo habitual del cliente `
        + `(${v.plazo_cliente_dias} días, ${ddmmaaaa(v.alternativa)}). Elige cuál guardar.`;
}

/**
 * Valida las fechas de una factura (las que vienen; las ausentes no se revisan). Reglas: dia real; emision
 * entre 2000 y mañana; vencimiento desde 2000, no anterior a la emision y a lo mas un año despues de ella.
 * @returns {{fecha_emision: string|null, fecha_vencimiento: string|null} | {error: string}}
 */
function validarFechasFactura({ fecha_emision, fecha_vencimiento } = {}, hoy = hoySantiago()) {
    const res = { fecha_emision: null, fecha_vencimiento: null };
    if (!vacio(fecha_emision)) {
        if (!esDiaValido(fecha_emision)) return { error: 'fecha_emision debe ser una fecha válida (AAAA-MM-DD)' };
        if (fecha_emision < FECHA_MINIMA || fecha_emision > sumarDias(hoy, 1)) {
            return { error: 'La fecha de emisión no puede ser futura ni anterior al año 2000' };
        }
        res.fecha_emision = fecha_emision;
    }
    if (!vacio(fecha_vencimiento)) {
        if (!esDiaValido(fecha_vencimiento)) return { error: 'fecha_vencimiento debe ser una fecha válida (AAAA-MM-DD)' };
        if (fecha_vencimiento < FECHA_MINIMA) return { error: 'La fecha de vencimiento no puede ser anterior al año 2000' };
        if (res.fecha_emision && fecha_vencimiento < res.fecha_emision) {
            return { error: 'La fecha de vencimiento no puede ser anterior a la emisión' };
        }
        const tope = res.fecha_emision ? sumarDias(res.fecha_emision, PLAZO_MAXIMO + 1) : sumarDias(hoy, 2 * PLAZO_MAXIMO);
        if (fecha_vencimiento > tope) return { error: 'La fecha de vencimiento está demasiado lejos de la emisión' };
        res.fecha_vencimiento = fecha_vencimiento;
    }
    return res;
}

/** Fecha de pago: dia real, desde el año 2000 y no futura. null o '' = deshacer el pago. */
function validarFechaPago(fecha, hoy = hoySantiago()) {
    if (vacio(fecha)) return { fecha_pago: null };
    if (!esDiaValido(fecha)) return { error: 'fecha_pago debe ser una fecha válida (AAAA-MM-DD)' };
    if (fecha < FECHA_MINIMA) return { error: 'La fecha de pago no puede ser anterior al año 2000' };
    if (fecha > hoy) return { error: 'La fecha de pago no puede ser futura' };
    return { fecha_pago: fecha };
}

/** Folio de la nota de credito: como un folio (letras, numeros, punto, guion, barra, espacio; hasta 50). null o '' = deshacer. */
function validarFolioNotaCredito(folio) {
    if (vacio(folio)) return { anulada_nc: null };
    if (typeof folio !== 'string' && typeof folio !== 'number') return { error: 'El folio de la nota de crédito debe ser texto' };
    const texto = String(folio).trim();
    if (!/^[\w.\-/ ]{1,50}$/.test(texto)) {
        return { error: 'El folio de la nota de crédito solo admite letras, números, punto, guion, barra y espacios (hasta 50 caracteres)' };
    }
    return { anulada_nc: texto };
}

/**
 * Avisos de la precarga de una factura (POST /api/facturacion/detectar): el panel los muestra y el
 * administrativo confirma o corrige. `leido` es la salida de parsearFactura y `vencimiento` la de
 * vencimientoPropuesto. Cada aviso es { codigo, mensaje }.
 */
function avisosPrecarga(leido, vencimiento) {
    const avisos = [];
    if (leido.varias_cuotas) {
        avisos.push({ codigo: 'varias_cuotas', mensaje: 'La factura trae varias fechas de pago (cuotas): se tomó la última como vencimiento.' });
    }
    if (vencimiento.coincide === false) {
        avisos.push({ codigo: 'vencimiento_distinto_plazo', mensaje: textoAvisoPlazo(vencimiento) });
    }
    if (vencimiento.origen === 'plazo_cliente') {
        avisos.push({
            codigo: 'vencimiento_desde_plazo',
            mensaje: `La factura no trae fecha de pago: el vencimiento se calculó con el plazo habitual del cliente (${vencimiento.plazo_cliente_dias} días).`,
        });
    }
    const t = leido.traslado_detectado;
    if (t && t.concepto === 'entrega_y_retiro') {
        avisos.push({ codigo: 'traslado_dividido', mensaje: 'La factura dice entrega y retiro: el traslado se dividió en partes iguales. Corrígelo si no es así.' });
    } else if (t && t.concepto === 'sin_detalle') {
        avisos.push({ codigo: 'traslado_sin_detalle', mensaje: 'La factura no dice si el traslado es de entrega o de retiro: se tomó como un solo monto.' });
    } else if (t && t.concepto === 'varias_lineas') {
        avisos.push({ codigo: 'traslado_varias_lineas', mensaje: 'La factura trae varias líneas de traslado: cada una se asignó a su concepto. Revísalo.' });
    }
    if (t && leido.monto_neto_detectado !== null && t.total > leido.monto_neto_detectado) {
        avisos.push({ codigo: 'traslado_mayor_que_neto', mensaje: 'El traslado leído es mayor que el monto neto: revisa los montos antes de guardar.' });
    }
    return avisos;
}

module.exports = {
    DIAS_PROXIMA,
    ESTADOS,
    FILTROS_ESTADO,
    SQL_HOY,
    SQL_FACTURAS_POR_COBRAR,
    SQL_FACTURAS_VENCIDAS,
    SQL_FACTURAS_PROXIMAS,
    SQL_FACTURAS_PAGADAS,
    SQL_FACTURAS_ANULADAS,
    hoySantiago,
    estadoCobranza,
    diasMora,
    diasParaVencer,
    vencimientoPropuesto,
    textoAvisoPlazo,
    avisosPrecarga,
    validarFechasFactura,
    validarFechaPago,
    validarFolioNotaCredito,
};
