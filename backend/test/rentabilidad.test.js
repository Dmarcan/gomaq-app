const { test, describe } = require('node:test');
const assert = require('node:assert');

const { calcularGasto, calcularIngreso, calcularRentabilidad } = require('../src/utils/rentabilidad');

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
