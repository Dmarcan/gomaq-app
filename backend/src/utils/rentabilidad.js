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

const { calcularInicioCobro, diaCalendarioUtc } = require('./diasArriendo');

const MS_DIA = 24 * 60 * 60 * 1000;

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

/**
 * Dias que un equipo estuvo arrendado dentro de [desde, hasta].
 *
 * Usa la misma regla que la facturacion (utils/diasArriendo): el dia de despacho cuenta solo si
 * salio antes de la hora de corte, y el dia de la recepcion cuenta completo. Asi la utilizacion
 * que se ve aca coincide con lo que se le cobra al cliente. Un despacho sin recepcion sigue
 * arrendado hasta el final del periodo. Las guias fallidas no cuentan: el equipo no salio.
 *
 * @param {Array<{tipo: string, fecha: string|Date, fallido?: boolean}>} guias del equipo
 */
function calcularDiasArrendado(guias, desde, hasta) {
    if (!Array.isArray(guias)) return 0;
    const desdeDia = diaCalendarioUtc(new Date(desde));
    const hastaDia = diaCalendarioUtc(new Date(hasta));
    let dias = 0;

    const sumar = (inicio, fin) => {
        const finDia = fin ? diaCalendarioUtc(fin) : hastaDia;
        const a = Math.max(diaCalendarioUtc(inicio), desdeDia);
        const b = Math.min(finDia, hastaDia);
        if (b >= a) dias += (b - a) / MS_DIA + 1;
    };

    const ordenadas = guias
        .filter((g) => g && !g.fallido)
        .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
    let abierto = null; // inicio de cobro del arriendo en curso
    for (const guia of ordenadas) {
        if (guia.tipo === 'despacho') {
            // un segundo despacho sin recepcion en medio es un dato repetido, no otro arriendo
            if (!abierto) abierto = calcularInicioCobro(guia.fecha);
        } else if (guia.tipo === 'recepcion' && abierto) {
            sumar(abierto, new Date(guia.fecha));
            abierto = null;
        }
    }
    if (abierto) sumar(abierto, null);
    return dias;
}

/**
 * Horas de uso de un equipo en el periodo, a partir de sus lecturas de horometro: la ultima
 * lectura hasta `hasta` menos la ultima anterior a `desde` (o la primera del periodo, si el
 * equipo no tenia lecturas antes). Devuelve null cuando no hay dos lecturas distintas o cuando
 * el resultado no es positivo: un horometro reemplazado o un dato mal ingresado no debe
 * producir un costo por hora inventado.
 */
function calcularHorasEnPeriodo(lecturas, desde, hasta) {
    if (!Array.isArray(lecturas)) return null;
    const puntos = lecturas
        .filter((l) => l && l.valor !== null && l.valor !== undefined && Number.isFinite(Number(l.valor)))
        .map((l) => ({ valor: Number(l.valor), t: new Date(l.fecha).getTime() }))
        .sort((a, b) => a.t - b.t);
    const t0 = new Date(desde).getTime();
    const t1 = new Date(hasta).getTime();

    const hastaHasta = puntos.filter((p) => p.t <= t1);
    if (hastaHasta.length === 0) return null;
    const fin = hastaHasta[hastaHasta.length - 1];
    const antes = puntos.filter((p) => p.t <= t0);
    const base = antes.length > 0 ? antes[antes.length - 1] : hastaHasta[0];
    if (base === fin) return null;
    const horas = fin.valor - base.valor;
    return horas > 0 ? horas : null;
}

/** Clasificacion de un equipo segun su resultado en el periodo (los filtros de la pantalla). */
function clasificarResultado({ gasto, ingreso, lineas_sin_precio = 0 }) {
    if (gasto === 0 && ingreso === 0 && lineas_sin_precio === 0) return 'sin_movimiento';
    const margen = ingreso - gasto;
    if (margen < 0) return 'a_perdida';
    if (margen > 0) return 'con_ganancia';
    return 'equilibrio';
}

/**
 * Totales de la flota para las cifras de arriba. `utilizacion_flota` es dias arrendados sobre
 * dias posibles de TODOS los equipos: un equipo que nunca sale tambien baja el promedio, que es
 * justamente lo que hay que ver.
 */
function resumirFlota(equipos, { diasPeriodo }) {
    const resumen = {
        gasto_total: 0,
        ingreso_total: 0,
        margen_total: 0,
        a_perdida: 0,
        con_ganancia: 0,
        sin_movimiento: 0,
        lineas_sin_precio: 0,
        utilizacion_flota: null,
    };
    let diasArrendados = 0;
    for (const e of equipos) {
        resumen.gasto_total += e.gasto;
        resumen.ingreso_total += e.ingreso;
        resumen.lineas_sin_precio += e.lineas_sin_precio || 0;
        if (e.resultado === 'a_perdida') resumen.a_perdida++;
        if (e.resultado === 'con_ganancia') resumen.con_ganancia++;
        if (e.resultado === 'sin_movimiento') resumen.sin_movimiento++;
        diasArrendados += e.dias_arrendado || 0;
    }
    resumen.margen_total = resumen.ingreso_total - resumen.gasto_total;
    const posibles = equipos.length * diasPeriodo;
    resumen.utilizacion_flota = posibles > 0 ? Math.min(100, (diasArrendados / posibles) * 100) : null;
    return resumen;
}

/** Dias de calendario del periodo, contando los dos extremos. */
function diasDelPeriodo(desde, hasta) {
    const n = (diaCalendarioUtc(new Date(hasta)) - diaCalendarioUtc(new Date(desde))) / MS_DIA + 1;
    return Number.isFinite(n) && n > 0 ? n : 0;
}

const PRIORIDAD_RESULTADO = { a_perdida: 0, equilibrio: 1, con_ganancia: 2, sin_movimiento: 3 };
const collator = new Intl.Collator('es', { numeric: true });

/**
 * Orden por defecto de la tabla de costos: lo que hay que decidir primero. Las perdidas arriba,
 * de la mayor a la menor; despues las ganancias, de la mayor a la menor; y al final los equipos
 * sin movimiento, que son la mayoria y no piden ninguna decision. Ordenar solo por margen los
 * dejaba a todos (margen 0) en el medio, tapando a los que si ganan.
 */
function compararPorRelevancia(a, b) {
    const grupo = PRIORIDAD_RESULTADO[a.resultado] - PRIORIDAD_RESULTADO[b.resultado];
    if (grupo !== 0) return grupo;
    if (a.resultado === 'a_perdida') return a.margen - b.margen || collator.compare(a.codigo, b.codigo);
    if (a.resultado === 'con_ganancia') return b.margen - a.margen || collator.compare(a.codigo, b.codigo);
    return collator.compare(a.codigo, b.codigo);
}

module.exports = {
    diasDelPeriodo,
    compararPorRelevancia,
    calcularGasto,
    calcularIngreso,
    calcularRentabilidad,
    calcularDiasArrendado,
    calcularHorasEnPeriodo,
    clasificarResultado,
    resumirFlota,
};
