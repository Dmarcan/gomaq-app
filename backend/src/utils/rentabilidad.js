// Costo real y rentabilidad por equipo.
//
// Entrevista con el jefe de taller del 21 de julio de 2026, punto 1: hoy no hay forma de saber si una
// maquina "sale a perdida" - textual: "no sabemos si en los tres meses que estuvo la maquina
// se gasto mas plata de la que dejaba el arriendo". Esto responde esa pregunta.
//
// Regla clave de esa misma entrevista: el gasto cuenta TODAS las lineas de repuesto, se hayan
// cobrado al cliente o no. A el jefe de taller le interesa el costo real para GOMAQ, no lo facturado.
// Por eso aca no aparece `facturable` por ningun lado: es deliberado, no un olvido.
//
// Alcance acordado: solo repuestos. Los traslados se cobran en la guia pero `guias` no guarda
// el monto, y las horas de trabajo existen como tramos pero no hay ningun valor hora definido
// en el negocio. Ambos quedan fuera hasta que esos datos existan.

/**
 * Gasto en repuestos de un equipo.
 *
 * Las lineas sin precio cargado no suman, pero se cuentan aparte: un total bajo porque nadie
 * puso los precios no es lo mismo que un equipo barato, y sin ese aviso el informe engaña.
 */
function calcularGasto(lineas) {
    if (!Array.isArray(lineas)) return { total: 0, lineas_sin_precio: 0 };
    let total = 0;
    let sinPrecio = 0;
    for (const linea of lineas) {
        if (!linea) continue;
        const cantidad = Number(linea.cantidad);
        const precio = Number(linea.precio_unitario);
        if (isNaN(cantidad) || linea.precio_unitario === null || linea.precio_unitario === undefined || isNaN(precio)) {
            sinPrecio++;
            continue;
        }
        total += cantidad * precio;
    }
    return { total, lineas_sin_precio: sinPrecio };
}

/** Ingreso facturado del equipo: arriendos y reparaciones, ambos ya resueltos por la consulta. */
function calcularIngreso(facturas) {
    if (!Array.isArray(facturas)) return 0;
    return facturas.reduce((total, factura) => {
        const monto = Number(factura && factura.monto);
        return isNaN(monto) ? total : total + monto;
    }, 0);
}

/**
 * Resumen de un equipo. `margen` negativo es exactamente el caso que el jefe de taller quiere detectar
 * para decidir si le sube el precio al cliente o deja de arrendarle ese equipo.
 */
function calcularRentabilidad({ lineas, facturas }) {
    const gasto = calcularGasto(lineas);
    const ingreso = calcularIngreso(facturas);
    return {
        gasto: gasto.total,
        lineas_sin_precio: gasto.lineas_sin_precio,
        ingreso,
        margen: ingreso - gasto.total,
        // sin ingreso el porcentaje no significa nada: se informa null en vez de dividir por cero
        margen_porcentaje: ingreso > 0 ? ((ingreso - gasto.total) / ingreso) * 100 : null,
        sale_a_perdida: ingreso - gasto.total < 0,
    };
}

module.exports = { calcularGasto, calcularIngreso, calcularRentabilidad };
