// Inventario por ubicacion (patron "van stock": bodega central + el furgon de cada mecanico).
//
// Entrevista el jefe de taller, punto 3: cada mecanico tiene un furgon asignado y lleva ahi su stock de
// repuestos. Antes existia un unico `insumos.stock_actual` global y consumir en una OT lo
// descontaba de ahi, aunque el repuesto hubiera salido del furgon.
//
// `insumos.stock_actual` no se elimina: pasa a ser el TOTAL de todas las ubicaciones, para que
// la pantalla de Insumos del panel y GET /api/insumos sigan funcionando sin cambios.
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

module.exports = { aplicarMovimiento, hayDescuadre, totalPorInsumo, validarTransferencia };
