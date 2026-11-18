// Inventario por ubicacion (patron "van stock": bodega central + el furgon de cada mecanico): cada mecanico
// lleva en su furgon su stock de repuestos.
//
// `insumos.stock_actual` no se elimina: es el TOTAL de todas las ubicaciones, para que la pantalla de
// Insumos del panel y GET /api/insumos sigan funcionando sin cambios.
//
// Funciones puras: la regla queda testeable sin base de datos.

/**
 * Cantidad resultante de aplicar un movimiento sobre una existencia.
 *
 * Se permite quedar en negativo a proposito. Si el mecanico instalo un repuesto que el sistema
 * no tenia registrado en su furgon, bloquear el registro solo logra que el dato se pierda: la
 * pieza ya esta puesta. El descuadre queda visible para que bodega lo cuadre.
 */
function aplicarMovimiento(cantidadActual, delta) {
    const actual = Number(cantidadActual) || 0;
    const cambio = Number(delta);
    if (isNaN(cambio)) return actual;
    return actual + cambio;
}

/** Una existencia esta descuadrada cuando quedo bajo cero: falta explicar de donde salio. */
function hayDescuadre(cantidad) {
    return (Number(cantidad) || 0) < 0;
}

/** Total de un insumo sumando todas sus ubicaciones. Es lo que se guarda en stock_actual. */
function totalPorInsumo(existencias) {
    if (!Array.isArray(existencias)) return 0;
    return existencias.reduce((total, e) => {
        const cantidad = Number(e && e.cantidad);
        return isNaN(cantidad) ? total : total + cantidad;
    }, 0);
}

/**
 * Valida una transferencia entre ubicaciones antes de aplicarla.
 *
 * A diferencia del consumo, aca si se rechaza sacar mas de lo que hay: una transferencia ocurre
 * en el taller, con la bodega a la vista y con señal, asi que un descuadre ahi es un error de
 * tipeo y no un hecho consumado en terreno.
 */
function validarTransferencia({ cantidad, disponibleOrigen, origenId, destinoId }) {
    const monto = Number(cantidad);
    if (isNaN(monto) || monto <= 0) {
        return { valida: false, error: 'La cantidad debe ser un número mayor a 0' };
    }
    if (!origenId || !destinoId) {
        return { valida: false, error: 'Se requiere ubicación de origen y de destino' };
    }
    if (origenId === destinoId) {
        return { valida: false, error: 'El origen y el destino no pueden ser la misma ubicación' };
    }
    if (monto > (Number(disponibleOrigen) || 0)) {
        return { valida: false, error: 'No hay suficiente stock en la bodega' };
    }
    return { valida: true };
}


// Ajustes de inventario (conteo fisico) y descuadres (migracion 025)

/** Motivos de un ajuste de inventario (o de un traspaso no registrado) y su texto para el panel. */
const MOTIVOS_AJUSTE = Object.freeze({
    traspaso_no_registrado: 'Traspaso no registrado',
    compra_no_ingresada: 'Compra no ingresada',
    error_registro: 'Error de registro',
    diferencia_conteo: 'Diferencia de conteo',
    danio_merma: 'Daño o merma',
    perdida_robo: 'Pérdida o robo',
});

/**
 * Motivos que se pueden usar al CONTAR. 'traspaso_no_registrado' no esta: ese caso se cuadra con un
 * traspaso desde la bodega (que baja la bodega). Un conteo solo cambia la existencia de UNA
 * ubicacion, asi que usarlo para una pieza que salio de bodega crearia stock de la nada.
 */
const MOTIVOS_CONTEO = Object.freeze(
    Object.fromEntries(Object.entries(MOTIVOS_AJUSTE).filter(([codigo]) => codigo !== 'traspaso_no_registrado'))
);

/** Un motivo es valido solo si es uno de la lista cerrada (o de la lista dada). */
function validarMotivoAjuste(codigo, lista = MOTIVOS_AJUSTE) {
    if (typeof codigo !== 'string' || !Object.prototype.hasOwnProperty.call(lista, codigo)) {
        return { valido: false, error: 'Elige un motivo de la lista' };
    }
    return { valido: true };
}

/** Mayor valor que admite NUMERIC(12,2). */
const TOPE_CANTIDAD = 9999999999.99;

/**
 * Cantidad escrita por el cliente, estricta: un numero finito o un texto decimal ("12", "-3.5").
 * Rechaza booleanos, arreglos, hexadecimales ("0x10"), notacion cientifica, Infinity y todo lo que
 * desborde la columna. Devuelve el numero o null.
 */
function leerCantidadEstricta(valor) {
    let n;
    if (typeof valor === 'number') n = valor;
    else if (typeof valor === 'string' && /^-?\d+(\.\d+)?$/.test(valor.trim())) n = Number(valor.trim());
    else return null;
    if (!Number.isFinite(n) || Math.abs(n) > TOPE_CANTIDAD) return null;
    return n;
}

const redondear2 = (n) => Math.round(n * 100) / 100;

/**
 * Diferencia que genera un conteo fisico sobre la existencia del sistema.
 *
 * `esperada` es la cantidad que el administrativo vio en pantalla cuando empezo a contar: si el
 * sistema cambio mientras tanto (un consumo sincronizado, un traspaso), el ajuste se calcularia
 * sobre un dato distinto al que tuvo a la vista y se rechaza con 409 para que cuente de nuevo.
 */
function calcularAjuste({ contada, sistema, esperada }) {
    const conteo = leerCantidadEstricta(contada);
    if (conteo === null || conteo < 0) {
        return { ok: false, status: 400, error: 'La cantidad contada debe ser un número igual o mayor a 0' };
    }
    const visto = leerCantidadEstricta(esperada);
    if (visto === null) {
        return { ok: false, status: 400, error: 'Falta la cantidad que viste en pantalla (cantidad_esperada)' };
    }
    const actual = Number(sistema) || 0;
    if (redondear2(visto) !== redondear2(actual)) {
        return { ok: false, status: 409, error: 'El stock cambió mientras contabas: vuelve a abrir el conteo' };
    }
    return { ok: true, delta: redondear2(conteo - actual) };
}

/**
 * Desde cuando una existencia esta negativa, reconstruido con sus movimientos.
 *
 * `eventos` son los cambios de esa ubicacion e insumo: `{ at, delta }`, con delta positivo si
 * suma y negativo si resta (el origen de un movimiento resta en `created_at`, el destino suma, y
 * una linea anulada suma de vuelta en `anulada_at`). Se recorre desde el presente hacia atras para
 * no depender de un saldo inicial sembrado: `negativo_desde` es el primer evento despues del cual el
 * saldo ya no volvio a ser 0 o mas. `sin_origen` indica que ningun movimiento explica el negativo
 * (el saldo ya era negativo antes del primer evento registrado, o no hay eventos).
 */
function reconstruirDescuadre(cantidadActual, eventos) {
    const lista = (Array.isArray(eventos) ? eventos : [])
        .map((e, i) => ({ at: e.at, delta: Number(e.delta) || 0, i, t: new Date(e.at).getTime() }))
        .sort((a, b) => a.t - b.t || a.i - b.i);
    const resultado = { negativo_desde: null, ultimo_movimiento_at: null, sin_origen: false };
    if (lista.length === 0) return { ...resultado, sin_origen: true };
    resultado.ultimo_movimiento_at = lista[lista.length - 1].at;

    let saldo = redondear2(Number(cantidadActual) || 0); // saldo despues del evento k
    let desde = null;
    for (let k = lista.length - 1; k >= 0; k--) {
        if (saldo >= 0) break;
        desde = lista[k].at;
        saldo = redondear2(saldo - lista[k].delta); // saldo antes del evento k
        if (k === 0 && saldo < 0) resultado.sin_origen = true;
    }
    resultado.negativo_desde = desde;
    return resultado;
}

module.exports = {
    aplicarMovimiento, hayDescuadre, totalPorInsumo, validarTransferencia,
    MOTIVOS_AJUSTE, MOTIVOS_CONTEO, validarMotivoAjuste, leerCantidadEstricta, calcularAjuste, reconstruirDescuadre,
};
