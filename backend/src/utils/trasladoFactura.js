// Parte de una factura que corresponde a traslado (migraciones 033 y 038). Funciones puras.
//
// Todos los montos de traslado son NETOS, como aparecen en la linea de la factura. `monto_traslado` es el
// total y la unica cifra que usa la rentabilidad. `traslado_entrega` y `traslado_retiro` (038) guardan la
// division que confirma el administrativo; nulos los dos = "un solo monto, sin dividir". Un trigger de la
// base deja las dos partes en NULL si su suma no es igual a monto_traslado.

const { montoEnteroONulo } = require('./auditoriaLinea');
const { vacio } = require('./valores');

const ERROR_ENTERO = (campo) => `${campo} debe ser un número entero de pesos, sin puntos ni decimales, de hasta 10 dígitos`;

/**
 * Valida el traslado de una factura contra su monto total y, si lo hay, contra su monto neto. Un traslado
 * vacio vale 0. Devuelve { traslado } (entero en pesos) o { error }.
 * `monto` es el monto final de la factura (nuevo o el ya guardado); puede ser nulo. `neto` es opcional.
 */
function validarTraslado(monto, traslado, neto) {
    if (vacio(traslado)) return { traslado: 0 };
    const valor = montoEnteroONulo(traslado);
    if (valor === null) {
        return { error: ERROR_ENTERO('El traslado') };
    }
    if (valor === 0) return { traslado: 0 };
    const total = vacio(monto) ? null : montoEnteroONulo(monto);
    if (total === null) return { error: 'Para indicar un traslado la factura debe tener monto' };
    if (valor > total) return { error: 'El traslado no puede ser mayor que el monto de la factura' };
    const netoValor = vacio(neto) ? null : montoEnteroONulo(neto);
    if (netoValor !== null && valor > netoValor) return { error: 'El traslado no puede ser mayor que el monto neto de la factura' };
    return { traslado: valor };
}

/**
 * Monto neto de la factura: entero en pesos y no mayor que el total (el total es neto + impuestos).
 * Vacio = sin neto (null). Devuelve { neto } o { error }.
 */
function validarNeto(monto, neto) {
    if (vacio(neto)) return { neto: null };
    const valor = montoEnteroONulo(neto);
    if (valor === null) return { error: ERROR_ENTERO('El monto neto') };
    const total = vacio(monto) ? null : montoEnteroONulo(monto);
    if (total !== null && valor > total) return { error: 'El monto neto no puede ser mayor que el monto total de la factura' };
    return { neto: valor };
}

/**
 * Division propuesta de un traslado segun lo que dice la factura (regla del negocio):
 *   entrega_y_retiro  mitad y mitad; si el monto es impar, entrega lleva el peso que sobra
 *   entrega / retiro  todo a ese concepto
 *   otro              null (un solo monto, sin dividir)
 */
function dividirTraslado(total, concepto) {
    const t = Number(total);
    if (!Number.isSafeInteger(t) || t < 0) return null;
    if (concepto === 'entrega_y_retiro') {
        const entrega = Math.ceil(t / 2);
        return { entrega, retiro: t - entrega };
    }
    if (concepto === 'entrega') return { entrega: t, retiro: 0 };
    if (concepto === 'retiro') return { entrega: 0, retiro: t };
    return null;
}

/**
 * Valida una division contra el total. Las dos partes vacias = sin division. Una parte vacia junto a otra
 * con valor cuenta como 0. Si el total viene, la suma debe ser igual. Una division que suma 0 no se guarda.
 * Devuelve { entrega, retiro } (enteros o los dos null) o { error }.
 */
function validarDivision(total, entrega, retiro) {
    if (vacio(entrega) && vacio(retiro)) return { entrega: null, retiro: null };
    const e = vacio(entrega) ? 0 : montoEnteroONulo(entrega);
    const r = vacio(retiro) ? 0 : montoEnteroONulo(retiro);
    if (e === null) return { error: ERROR_ENTERO('El traslado de entrega') };
    if (r === null) return { error: ERROR_ENTERO('El traslado de retiro') };
    if (!vacio(total)) {
        const t = montoEnteroONulo(total);
        if (t === null) return { error: ERROR_ENTERO('El traslado') };
        if (e + r !== t) return { error: 'El traslado de entrega más el de retiro debe ser igual al traslado total' };
    }
    if (e + r === 0) return { entrega: null, retiro: null };
    return { entrega: e, retiro: r };
}

/**
 * Resuelve el traslado de una factura a partir de lo que llega en la peticion: el total, las partes, o
 * los tres. Si llegan las partes sin total, el total es su suma; si llegan los tres deben cuadrar. Valida
 * el total contra el monto y el neto (validarTraslado).
 * @returns {{traslado: number, entrega: number|null, retiro: number|null} | {error: string}}
 */
function resolverTraslado({ monto, neto, monto_traslado, traslado_entrega, traslado_retiro }) {
    const conPartes = !vacio(traslado_entrega) || !vacio(traslado_retiro);
    const division = validarDivision(monto_traslado, traslado_entrega, traslado_retiro);
    if (division.error) return { error: division.error };
    let total = monto_traslado;
    if (conPartes && vacio(monto_traslado)) total = (division.entrega || 0) + (division.retiro || 0);
    const v = validarTraslado(monto, total, neto);
    if (v.error) return { error: v.error };
    if (v.traslado === 0) return { traslado: 0, entrega: null, retiro: null };
    return { traslado: v.traslado, entrega: division.entrega, retiro: division.retiro };
}

/** Ingreso por arriendo de una factura: el monto sin el traslado, nunca menor que 0. */
function ingresoSinTraslado(monto, traslado) {
    const total = Number(monto);
    if (isNaN(total)) return null;
    const t = Number(traslado);
    return Math.max(0, total - (isNaN(t) || t < 0 ? 0 : t));
}

module.exports = { validarTraslado, validarNeto, dividirTraslado, validarDivision, resolverTraslado, ingresoSinTraslado };
