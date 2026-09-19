const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
    calcularGasto,
    calcularIngreso,
    calcularRentabilidad,
    calcularDiasArrendado,
    calcularHorasEnPeriodo,
    clasificarResultado,
    resumirFlota,
    diasDelPeriodo,
    compararPorRelevancia,
} = require('../src/utils/rentabilidad');

const linea = (cantidad, precio, facturable = 'si') => ({
    cantidad,
    precio_unitario: precio,
    facturable,
});

describe('calcularGasto', () => {
    test('suma cantidad por precio de cada linea', () => {
        assert.deepStrictEqual(calcularGasto([linea(2, 15000), linea(1, 5000)]), {
            total: 35000,
            lineas_sin_precio: 0,
        });
    });

    test('cuenta el gasto aunque la linea no se le cobre al cliente', () => {
        // regla de la entrevista: a el jefe de taller le importa el costo real para GOMAQ, no lo facturado
        const lineas = [linea(1, 15000, 'no'), linea(1, 5000, 'pendiente')];
        assert.strictEqual(calcularGasto(lineas).total, 20000);
    });

    test('las lineas sin precio no suman pero se informan', () => {
        const r = calcularGasto([linea(1, 15000), linea(3, null), linea(2, undefined)]);
        assert.strictEqual(r.total, 15000);
        assert.strictEqual(r.lineas_sin_precio, 2);
    });

    test('sin lineas el gasto es cero', () => {
        assert.deepStrictEqual(calcularGasto([]), { total: 0, lineas_sin_precio: 0 });
        assert.deepStrictEqual(calcularGasto(null), { total: 0, lineas_sin_precio: 0 });
    });
});

describe('calcularIngreso', () => {
    test('suma los montos de las facturas del equipo', () => {
        // los dos caminos: arriendo (maquinaria_id) y reparacion (via orden_trabajo_id)
        assert.strictEqual(calcularIngreso([{ monto: 249900 }, { monto: 15000 }]), 264900);
    });

    test('una factura sin monto no rompe la suma', () => {
        assert.strictEqual(calcularIngreso([{ monto: 100 }, { monto: null }]), 100);
    });

    test('sin facturas el ingreso es cero', () => {
        assert.strictEqual(calcularIngreso([]), 0);
        assert.strictEqual(calcularIngreso(null), 0);
    });
});

describe('calcularRentabilidad', () => {
    test('equipo que deja ganancia', () => {
        const r = calcularRentabilidad({
            lineas: [linea(1, 15000)],
            facturas: [{ monto: 249900 }],
        });
        assert.strictEqual(r.gasto, 15000);
        assert.strictEqual(r.ingreso, 249900);
        assert.strictEqual(r.margen, 234900);
        assert.strictEqual(r.sale_a_perdida, false);
    });

    test('equipo que sale a perdida: el caso que el jefe de taller quiere detectar', () => {
        const r = calcularRentabilidad({
            lineas: [linea(3, 120000)],
            facturas: [{ monto: 249900 }],
        });
        assert.strictEqual(r.margen, -110100);
        assert.strictEqual(r.sale_a_perdida, true);
    });

    test('equipo sin movimientos', () => {
        const r = calcularRentabilidad({ lineas: [], facturas: [] });
        assert.strictEqual(r.gasto, 0);
        assert.strictEqual(r.ingreso, 0);
        assert.strictEqual(r.margen, 0);
        assert.strictEqual(r.sale_a_perdida, false);
    });

    test('gasto sin ingreso: no hay porcentaje, pero si perdida', () => {
        const r = calcularRentabilidad({ lineas: [linea(1, 15000)], facturas: [] });
        assert.strictEqual(r.margen, -15000);
        assert.strictEqual(r.margen_porcentaje, null, 'no se divide por cero');
        assert.strictEqual(r.sale_a_perdida, true);
    });

    test('porcentaje de margen sobre el ingreso', () => {
        const r = calcularRentabilidad({ lineas: [linea(1, 25000)], facturas: [{ monto: 100000 }] });
        assert.strictEqual(r.margen_porcentaje, 75);
    });

    test('arrastra el aviso de lineas sin precio', () => {
        const r = calcularRentabilidad({ lineas: [linea(1, null)], facturas: [{ monto: 100 }] });
        assert.strictEqual(r.lineas_sin_precio, 1);
    });
});

// Fechas en hora local (sin "Z"), igual que la regla de facturacion: el corte de las 13:00 se
// evalua con la hora local del servidor.
const f = (texto) => new Date(texto);
const despacho = (fecha, extra = {}) => ({ tipo: 'despacho', fecha: f(fecha), ...extra });
const recepcion = (fecha, extra = {}) => ({ tipo: 'recepcion', fecha: f(fecha), ...extra });
const ANIO = [f('2026-01-01T00:00:00'), f('2026-12-31T23:59:59')];

describe('calcularDiasArrendado', () => {
    test('cuenta desde el despacho hasta el dia de la recepcion inclusive', () => {
        const guias = [despacho('2026-03-01T10:00:00'), recepcion('2026-03-05T09:00:00')];
        assert.strictEqual(calcularDiasArrendado(guias, ...ANIO), 5);
    });

    test('un despacho despues de las 13:00 no cuenta ese dia, como en la facturacion', () => {
        const guias = [despacho('2026-03-01T15:00:00'), recepcion('2026-03-05T09:00:00')];
        assert.strictEqual(calcularDiasArrendado(guias, ...ANIO), 4);
    });

    test('un arriendo sin recepcion sigue vigente hasta el final del periodo', () => {
        const guias = [despacho('2026-12-20T09:00:00')];
        assert.strictEqual(calcularDiasArrendado(guias, ...ANIO), 12);
    });

    test('solo cuentan los dias que caen dentro del periodo', () => {
        // arriendo del 25 de dic al 10 de ene, mirando solo enero
        const guias = [despacho('2025-12-25T09:00:00'), recepcion('2026-01-10T09:00:00')];
        assert.strictEqual(calcularDiasArrendado(guias, f('2026-01-01T00:00:00'), f('2026-01-31T23:59:59')), 10);
    });

    test('un arriendo anterior al periodo y ya devuelto no suma nada', () => {
        const guias = [despacho('2025-05-01T09:00:00'), recepcion('2025-05-10T09:00:00')];
        assert.strictEqual(calcularDiasArrendado(guias, ...ANIO), 0);
    });

    test('un despacho anterior al periodo y aun abierto cuenta el periodo completo', () => {
        const guias = [despacho('2025-11-01T09:00:00')];
        assert.strictEqual(calcularDiasArrendado(guias, f('2026-01-01T00:00:00'), f('2026-01-31T23:59:59')), 31);
    });

    test('las guias fallidas no cuentan: el equipo no salio', () => {
        const guias = [despacho('2026-03-01T10:00:00', { fallido: true }), recepcion('2026-03-05T09:00:00', { fallido: true })];
        assert.strictEqual(calcularDiasArrendado(guias, ...ANIO), 0);
    });

    test('un despacho fallido y uno bueno despues: solo cuenta el bueno', () => {
        const guias = [
            despacho('2026-03-01T10:00:00', { fallido: true }),
            despacho('2026-03-10T10:00:00'),
            recepcion('2026-03-12T09:00:00'),
        ];
        assert.strictEqual(calcularDiasArrendado(guias, ...ANIO), 3);
    });

    test('dos arriendos en el periodo se suman', () => {
        const guias = [
            despacho('2026-02-01T09:00:00'), recepcion('2026-02-03T09:00:00'),
            despacho('2026-06-01T09:00:00'), recepcion('2026-06-02T09:00:00'),
        ];
        assert.strictEqual(calcularDiasArrendado(guias, ...ANIO), 5);
    });

    test('un despacho repetido sin recepcion en medio no cuenta dos veces', () => {
        const guias = [despacho('2026-03-01T09:00:00'), despacho('2026-03-02T09:00:00'), recepcion('2026-03-04T09:00:00')];
        assert.strictEqual(calcularDiasArrendado(guias, ...ANIO), 4);
    });

    test('las guias llegan desordenadas y se ordenan por fecha', () => {
        const guias = [recepcion('2026-03-05T09:00:00'), despacho('2026-03-01T10:00:00')];
        assert.strictEqual(calcularDiasArrendado(guias, ...ANIO), 5);
    });

    test('una recepcion suelta, sin despacho, no inventa dias', () => {
        assert.strictEqual(calcularDiasArrendado([recepcion('2026-03-05T09:00:00')], ...ANIO), 0);
    });

    test('sin guias, o algo que no es una lista, son cero dias', () => {
        assert.strictEqual(calcularDiasArrendado([], ...ANIO), 0);
        assert.strictEqual(calcularDiasArrendado(null, ...ANIO), 0);
    });

    test('despachar y recibir el mismo dia despues del corte no cuenta ningun dia', () => {
        const guias = [despacho('2026-03-01T15:00:00'), recepcion('2026-03-01T17:00:00')];
        assert.strictEqual(calcularDiasArrendado(guias, ...ANIO), 0);
    });
});

describe('calcularHorasEnPeriodo', () => {
    const lectura = (valor, fecha) => ({ valor, fecha: f(fecha) });

    test('resta la ultima lectura del periodo y la ultima anterior a su inicio', () => {
        const lecturas = [lectura(100, '2025-12-15T00:00:00'), lectura(180, '2026-03-01T00:00:00'), lectura(260, '2026-09-01T00:00:00')];
        assert.strictEqual(calcularHorasEnPeriodo(lecturas, ...ANIO), 160);
    });

    test('sin lectura anterior usa la primera del periodo como base', () => {
        const lecturas = [lectura(50, '2026-02-01T00:00:00'), lectura(200, '2026-08-01T00:00:00')];
        assert.strictEqual(calcularHorasEnPeriodo(lecturas, ...ANIO), 150);
    });

    test('con una sola lectura no se puede saber cuanto se uso', () => {
        assert.strictEqual(calcularHorasEnPeriodo([lectura(100, '2026-02-01T00:00:00')], ...ANIO), null);
    });

    test('ignora las lecturas posteriores al periodo', () => {
        const lecturas = [lectura(100, '2026-02-01T00:00:00'), lectura(150, '2026-06-01T00:00:00'), lectura(999, '2027-03-01T00:00:00')];
        assert.strictEqual(calcularHorasEnPeriodo(lecturas, ...ANIO), 50);
    });

    test('un horometro que retrocede (reemplazado o mal ingresado) no da horas negativas', () => {
        const lecturas = [lectura(900, '2026-02-01T00:00:00'), lectura(10, '2026-08-01T00:00:00')];
        assert.strictEqual(calcularHorasEnPeriodo(lecturas, ...ANIO), null);
    });

    test('lecturas iguales son cero horas de uso, o sea nada que dividir', () => {
        const lecturas = [lectura(100, '2026-02-01T00:00:00'), lectura(100, '2026-08-01T00:00:00')];
        assert.strictEqual(calcularHorasEnPeriodo(lecturas, ...ANIO), null);
    });

    test('valores que no son numeros se ignoran', () => {
        const lecturas = [lectura(null, '2026-02-01T00:00:00'), lectura('abc', '2026-03-01T00:00:00'), lectura(100, '2026-04-01T00:00:00'), lectura(130, '2026-05-01T00:00:00')];
        assert.strictEqual(calcularHorasEnPeriodo(lecturas, ...ANIO), 30);
    });

    test('sin lecturas, o algo que no es una lista, son null', () => {
        assert.strictEqual(calcularHorasEnPeriodo([], ...ANIO), null);
        assert.strictEqual(calcularHorasEnPeriodo(undefined, ...ANIO), null);
    });
});

describe('clasificarResultado', () => {
    test('a perdida cuando se gasto mas de lo facturado', () => {
        assert.strictEqual(clasificarResultado({ gasto: 1000, ingreso: 400 }), 'a_perdida');
    });

    test('con ganancia cuando se facturo mas de lo gastado', () => {
        assert.strictEqual(clasificarResultado({ gasto: 400, ingreso: 1000 }), 'con_ganancia');
    });

    test('sin movimiento solo si no hubo gasto, ingreso ni repuestos sin precio', () => {
        assert.strictEqual(clasificarResultado({ gasto: 0, ingreso: 0 }), 'sin_movimiento');
        // repuestos sin precio son movimiento aunque no sumen: no es un equipo inactivo
        assert.strictEqual(clasificarResultado({ gasto: 0, ingreso: 0, lineas_sin_precio: 2 }), 'equilibrio');
    });

    test('gasto igual al ingreso es equilibrio, ni ganancia ni perdida', () => {
        assert.strictEqual(clasificarResultado({ gasto: 500, ingreso: 500 }), 'equilibrio');
    });

    test('solo gasto, sin ingreso, es a perdida', () => {
        assert.strictEqual(clasificarResultado({ gasto: 300, ingreso: 0 }), 'a_perdida');
    });
});

describe('resumirFlota', () => {
    const equipo = (gasto, ingreso, dias, extra = {}) => ({
        gasto,
        ingreso,
        dias_arrendado: dias,
        lineas_sin_precio: 0,
        resultado: clasificarResultado({ gasto, ingreso, lineas_sin_precio: extra.lineas_sin_precio || 0 }),
        ...extra,
    });

    test('informa cuantos equipos tiene la flota, incluso los que estan en equilibrio', () => {
        const r = resumirFlota([equipo(100, 300, 0), equipo(500, 500, 0), equipo(0, 0, 0)], { diasPeriodo: 100 });
        assert.strictEqual(r.total, 3);
        // el equilibrio no tiene contador propio: solo cuenta en el total
        assert.strictEqual(r.con_ganancia + r.a_perdida + r.sin_movimiento, 2);
    });

    test('suma gasto, ingreso y margen de toda la flota', () => {
        const r = resumirFlota([equipo(100, 300, 10), equipo(500, 200, 20)], { diasPeriodo: 100 });
        assert.strictEqual(r.gasto_total, 600);
        assert.strictEqual(r.ingreso_total, 500);
        assert.strictEqual(r.margen_total, -100);
    });

    test('cuenta los equipos por resultado', () => {
        const r = resumirFlota([equipo(100, 300, 0), equipo(500, 200, 0), equipo(0, 0, 0), equipo(0, 0, 0)], { diasPeriodo: 100 });
        assert.deepStrictEqual([r.con_ganancia, r.a_perdida, r.sin_movimiento], [1, 1, 2]);
    });

    test('la utilizacion cuenta tambien a los equipos que nunca salieron', () => {
        // 30 dias arrendados sobre 2 equipos x 100 dias posibles
        const r = resumirFlota([equipo(0, 0, 30), equipo(0, 0, 0)], { diasPeriodo: 100 });
        assert.strictEqual(r.utilizacion_flota, 15);
    });

    test('la utilizacion nunca pasa de 100%', () => {
        const r = resumirFlota([equipo(0, 0, 500)], { diasPeriodo: 100 });
        assert.strictEqual(r.utilizacion_flota, 100);
    });

    test('sin equipos no hay utilizacion que calcular', () => {
        assert.strictEqual(resumirFlota([], { diasPeriodo: 100 }).utilizacion_flota, null);
    });

    test('suma las lineas sin precio de todos los equipos', () => {
        const r = resumirFlota([equipo(0, 0, 0, { lineas_sin_precio: 2 }), equipo(0, 0, 0, { lineas_sin_precio: 3 })], { diasPeriodo: 100 });
        assert.strictEqual(r.lineas_sin_precio, 5);
    });
});

describe('compararPorRelevancia', () => {
    const eq = (codigo, resultado, margen) => ({ codigo, resultado, margen });
    const orden = (lista) => [...lista].sort(compararPorRelevancia).map((e) => e.codigo);

    test('las perdidas van primero, de la mayor a la menor', () => {
        assert.deepStrictEqual(orden([eq('A', 'a_perdida', -50), eq('B', 'a_perdida', -500)]), ['B', 'A']);
    });

    test('despues de las perdidas van las ganancias, de la mayor a la menor', () => {
        assert.deepStrictEqual(orden([eq('A', 'con_ganancia', 100), eq('B', 'con_ganancia', 900)]), ['B', 'A']);
    });

    test('los equipos sin movimiento van al final y no tapan a los que si ganan', () => {
        // con solo margen ascendente, los de margen 0 quedaban entre las perdidas y las ganancias
        const lista = [eq('IDLE', 'sin_movimiento', 0), eq('GANA', 'con_ganancia', 10), eq('PIERDE', 'a_perdida', -10)];
        assert.deepStrictEqual(orden(lista), ['PIERDE', 'GANA', 'IDLE']);
    });

    test('el equilibrio va entre las perdidas y las ganancias', () => {
        const lista = [eq('GANA', 'con_ganancia', 10), eq('EQ', 'equilibrio', 0), eq('PIERDE', 'a_perdida', -10)];
        assert.deepStrictEqual(orden(lista), ['PIERDE', 'EQ', 'GANA']);
    });

    test('los codigos empatados se ordenan como numeros: PL-99 antes que PL-602', () => {
        const lista = [eq('PL-602', 'sin_movimiento', 0), eq('PL-1101', 'sin_movimiento', 0), eq('PL-99', 'sin_movimiento', 0)];
        assert.deepStrictEqual(orden(lista), ['PL-99', 'PL-602', 'PL-1101']);
    });
});

describe('diasDelPeriodo', () => {
    test('cuenta los dos extremos', () => {
        assert.strictEqual(diasDelPeriodo(new Date('2026-01-01T00:00:00'), new Date('2026-01-31T23:59:59')), 31);
        assert.strictEqual(diasDelPeriodo(new Date('2026-01-01T00:00:00'), new Date('2026-12-31T23:59:59')), 365);
    });

    test('un periodo al reves no tiene dias', () => {
        assert.strictEqual(diasDelPeriodo(new Date('2026-02-01T00:00:00'), new Date('2026-01-01T00:00:00')), 0);
    });

    test('un mismo dia es un dia', () => {
        assert.strictEqual(diasDelPeriodo(new Date('2026-03-01T08:00:00'), new Date('2026-03-01T20:00:00')), 1);
    });
});
