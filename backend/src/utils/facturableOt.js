// Facturable de una Orden de Trabajo, derivado de sus lineas de repuesto.
//
// En el talonario de papel el "FACTURABLE" no es de la orden: es una columna con tres casillas
// (SI / NO / ?) en CADA linea de repuesto. Por eso la fuente de verdad es la linea y el campo de la
// OT queda derivado.
//
// Mantenerlo derivado, en vez de borrarlo, deja intactos los consumidores que ya existen:
// routes/facturacion.js (pendientes de valorizar / listas para facturar) y routes/dashboard.js
// siguen leyendo ordenes_trabajo.facturable sin enterarse del cambio.
//
// Regla: sin repuestos no se cobra. Un trabajo que no llevo ninguna
// linea marcada 'si' no genera cobro, aunque haya tomado horas de mano de obra.

/** Una OT es facturable si al menos una de sus lineas quedo marcada como cobrable. */
function calcularFacturableOt(lineas) {
    if (!Array.isArray(lineas)) return false;
    return lineas.some((linea) => linea && linea.facturable === 'si');
}

/**
 * Lineas cuyo cobro todavia no se decide (el "?" del papel). Son las que se le muestran al
 * gerente para que resuelva: el caso de los clientes antiguos a los que se decide despues
 * si se les cobra o no.
 */
function lineasPendientesDeDecision(lineas) {
    if (!Array.isArray(lineas)) return [];
    return lineas.filter((linea) => linea && linea.facturable === 'pendiente');
}

/** Total cobrable de la OT: solo las lineas en 'si', por cantidad y precio unitario. */
function calcularTotalFacturable(lineas) {
    if (!Array.isArray(lineas)) return 0;
    return lineas
        .filter((linea) => linea && linea.facturable === 'si')
        .reduce((total, linea) => {
            const cantidad = Number(linea.cantidad);
            const precio = Number(linea.precio_unitario);
            // una linea sin precio cargado todavia no suma; el gerente la valoriza despues
            if (isNaN(cantidad) || isNaN(precio)) return total;
            return total + cantidad * precio;
        }, 0);
}

module.exports = { calcularFacturableOt, lineasPendientesDeDecision, calcularTotalFacturable };
