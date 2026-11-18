// Periodos de facturacion de un arriendo. Funciones puras sobre dias de calendario
// 'YYYY-MM-DD', sin zona horaria ni base de datos.
//
// Un arriendo va del inicio de cobro de su despacho hasta su fin (el dia en que sale del cliente si
// eso ocurre desde la hora de corte, o el dia anterior si ocurre antes: ver finCobroDia). Se factura por periodos que terminan en el "fin de
// periodo" de cada mes: el dia de corte (corteCierraPeriodo = true) o el dia anterior al corte
// (false). El ultimo periodo termina en el fin del arriendo. El aviso de que hay un periodo por
// facturar aparece desde el propio dia de corte en ambos casos.

const { sumarDias, diasEntre, proximoCorte } = require('./diasArriendo');

const comparar = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // 'YYYY-MM-DD' ordena como texto

const diaDelMes = (anio, mes, dia) => `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

/**
 * Fines de periodo dentro de [desde, hasta], ambos inclusive y en orden.
 * Con corteCierraPeriodo = true el fin es el dia de corte; con false, el dia anterior.
 */
function finesDePeriodo(desde, hasta, diaFacturacion, corteCierraPeriodo = true) {
    const fines = [];
    if (comparar(desde, hasta) > 0) return fines;
    // un fin puede caer un dia antes del corte, que es del mes siguiente: se parte un mes antes
    let [anio, mes] = sumarDias(desde, -31).split('-').map(Number);
    const [anioFin, mesFin] = sumarDias(hasta, 31).split('-').map(Number);
    while (anio < anioFin || (anio === anioFin && mes <= mesFin)) {
        const corte = diaDelMes(anio, mes, diaFacturacion);
        const fin = corteCierraPeriodo ? corte : sumarDias(corte, -1);
        if (comparar(fin, desde) >= 0 && comparar(fin, hasta) <= 0) fines.push(fin);
        mes += 1;
        if (mes > 12) { mes = 1; anio += 1; }
    }
    return fines;
}

/** Fines de periodo ya vencidos a `hoy`: su dia de corte ya llego. */
function finesVencidos(desde, hoy, diaFacturacion, corteCierraPeriodo = true) {
    const limite = corteCierraPeriodo ? hoy : sumarDias(hoy, -1);
    return finesDePeriodo(desde, limite, diaFacturacion, corteCierraPeriodo);
}

/**
 * Propuesta del proximo periodo a facturar de un arriendo.
 *
 * @param {object} p
 * @param {string} p.inicioCobro dia en que parte el cobro del despacho
 * @param {string|null} p.facturadoHasta ultimo dia ya facturado (periodo_hasta mas alto), si hay
 * @param {string|null} p.fin ultimo dia del arriendo si ya termino (recepcion o siguiente despacho), o null si sigue en curso
 * @param {string} p.hoy dia actual en Santiago
 * @param {number} p.diaFacturacion
 * @param {boolean} [p.corteCierraPeriodo=true]
 * @returns {{desde: string, opciones_hasta: string[], hasta_sugerido: string|null, dias: number,
 *   es_final: boolean, nada_que_facturar: boolean, facturado_de_mas: boolean}}
 */
function proponerPeriodo({ inicioCobro, facturadoHasta = null, fin = null, hoy, diaFacturacion, corteCierraPeriodo = true }) {
    const desde = facturadoHasta ? sumarDias(facturadoHasta, 1) : inicioCobro;
    const facturadoDeMas = fin !== null && facturadoHasta !== null && comparar(facturadoHasta, fin) > 0;
    let opciones;
    if (fin !== null) {
        // arriendo terminado: cada fin de periodo hasta el fin, y el propio fin (ultimo periodo)
        opciones = comparar(desde, fin) > 0 ? [] : finesDePeriodo(desde, fin, diaFacturacion, corteCierraPeriodo);
        if (comparar(desde, fin) <= 0 && opciones[opciones.length - 1] !== fin) opciones.push(fin);
    } else {
        // arriendo en curso: solo los periodos cuyo corte ya llego
        opciones = finesVencidos(desde, hoy, diaFacturacion, corteCierraPeriodo);
    }
    const hastaSugerido = opciones.length > 0 ? opciones[0] : null;
    return {
        desde,
        opciones_hasta: opciones,
        hasta_sugerido: hastaSugerido,
        dias: hastaSugerido ? diasEntre(desde, hastaSugerido) : 0,
        es_final: fin !== null && hastaSugerido === fin,
        nada_que_facturar: opciones.length === 0,
        facturado_de_mas: facturadoDeMas,
    };
}

/**
 * Valida el periodo que pide el administrativo contra la propuesta vigente.
 * Devuelve { ok: true, es_final } o { ok: false, codigo, estado, mensaje }.
 */
function validarPeriodo({ desde, hasta }, propuesta) {
    if (propuesta.nada_que_facturar) {
        return { ok: false, codigo: 'nada_que_facturar', estado: 409, mensaje: 'No hay días por facturar en este arriendo' };
    }
    if (desde !== propuesta.desde) {
        return {
            ok: false, codigo: 'periodo_desactualizado', estado: 409,
            mensaje: 'El período cambió desde que se abrió la pantalla: revisa la propuesta actualizada',
        };
    }
    if (!propuesta.opciones_hasta.includes(hasta)) {
        return { ok: false, codigo: 'hasta_invalido', estado: 400, mensaje: 'La fecha final no es un fin de período válido para este arriendo' };
    }
    return { ok: true };
}

/**
 * Estado de un arriendo en curso (sin recepcion): desde cuando se cuenta, cuantos dias van y
 * cuantos periodos (fines de periodo vencidos) llevan sin facturar. El aviso aparece desde el dia
 * de corte, tambien cuando el corte no cierra el periodo (el fin cae un dia antes).
 */
function resumirArriendoEnCurso({ inicioCobro, ultimoPeriodoHasta = null, hoy, diaFacturacion, corteCierraPeriodo = true }) {
    const desde = ultimoPeriodoHasta ? sumarDias(ultimoPeriodoHasta, 1) : inicioCobro;
    const periodos = finesVencidos(desde, hoy, diaFacturacion, corteCierraPeriodo).length;
    return {
        desde,
        dias: diasEntre(desde, hoy),
        periodos_sin_facturar: periodos,
        proximo_corte: proximoCorte(hoy, diaFacturacion),
        aviso: periodos > 0,
    };
}

module.exports = { finesDePeriodo, finesVencidos, proponerPeriodo, validarPeriodo, resumirArriendoEnCurso };
