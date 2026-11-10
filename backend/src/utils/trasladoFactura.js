// Parte de una factura que corresponde a traslado (ver migracion 033). Funciones puras.

const { montoEnteroONulo } = require('./auditoriaLinea');

const vacio = (v) => v === undefined || v === null || v === '';

/**
 * Valida el traslado de una factura contra su monto total. Un traslado vacio vale 0. Devuelve
 * { traslado } (entero en pesos) o { error }.
 * `monto` es el monto final de la factura (nuevo o el ya guardado); puede ser nulo.
 */
function validarTraslado(monto, traslado) {
    if (vacio(traslado)) return { traslado: 0 };
    const valor = montoEnteroONulo(traslado);
    if (valor === null) {
        return { error: 'El traslado debe ser un número entero de pesos, sin puntos ni decimales, de hasta 10 dígitos' };
    }
    if (valor === 0) return { traslado: 0 };
    const total = vacio(monto) ? null : montoEnteroONulo(monto);
    if (total === null) return { error: 'Para indicar un traslado la factura debe tener monto' };
    if (valor > total) return { error: 'El traslado no puede ser mayor que el monto de la factura' };
    return { traslado: valor };
}

/** Ingreso por arriendo de una factura: el monto sin el traslado, nunca menor que 0. */
function ingresoSinTraslado(monto, traslado) {
    const total = Number(monto);
    if (isNaN(total)) return null;
    const t = Number(traslado);
    return Math.max(0, total - (isNaN(t) || t < 0 ? 0 : t));
}

module.exports = { validarTraslado, ingresoSinTraslado };
