const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    calcularFacturableOt,
    lineasPendientesDeDecision,
    calcularTotalFacturable,
} = require('../src/utils/facturableOt');

const linea = (facturable, cantidad = 1, precio = null) => ({
    facturable,
    cantidad,
    precio_unitario: precio,
});

describe('calcularFacturableOt', () => {
    test('sin repuestos no se cobra', () => {
        // regla acordada: un trabajo sin lineas no genera cobro aunque haya tomado horas
        assert.strictEqual(calcularFacturableOt([]), false);
    });

    test('una linea marcada si hace facturable la OT', () => {
        assert.strictEqual(calcularFacturableOt([linea('si')]), true);
    });

    test('lineas en no o pendiente no la hacen facturable', () => {
        assert.strictEqual(calcularFacturableOt([linea('no'), linea('pendiente')]), false);
    });

    test('basta una linea si entre varias', () => {
        assert.strictEqual(calcularFacturableOt([linea('no'), linea('si'), linea('pendiente')]), true);
    });

    test('caso real de la OT 00904: una linea facturable', () => {
        // "llave de contacto", cant 01, $15.000, FACTURABLE marcado SI
        const lineas = [{ facturable: 'si', cantidad: 1, precio_unitario: 15000, descripcion: 'Llave de contacto' }];
        assert.strictEqual(calcularFacturableOt(lineas), true);
        assert.strictEqual(calcularTotalFacturable(lineas), 15000);
    });

    test('tolera entradas invalidas sin reventar', () => {
        assert.strictEqual(calcularFacturableOt(null), false);
        assert.strictEqual(calcularFacturableOt(undefined), false);
        assert.strictEqual(calcularFacturableOt([null]), false);
    });
});

describe('lineasPendientesDeDecision', () => {
    test('devuelve solo las que estan en pendiente', () => {
        const lineas = [linea('si'), linea('pendiente'), linea('no'), linea('pendiente')];
        assert.strictEqual(lineasPendientesDeDecision(lineas).length, 2);
    });

    test('sin pendientes devuelve lista vacia', () => {
        assert.deepStrictEqual(lineasPendientesDeDecision([linea('si')]), []);
        assert.deepStrictEqual(lineasPendientesDeDecision(null), []);
    });
});

describe('calcularTotalFacturable', () => {
    test('suma cantidad por precio de las lineas cobrables', () => {
        const lineas = [linea('si', 2, 15000), linea('si', 1, 5000)];
        assert.strictEqual(calcularTotalFacturable(lineas), 35000);
    });

    test('ignora las lineas no cobrables', () => {
        const lineas = [linea('si', 1, 10000), linea('no', 5, 99999), linea('pendiente', 3, 99999)];
        assert.strictEqual(calcularTotalFacturable(lineas), 10000);
    });

    test('una linea sin precio todavia no suma', () => {
        // el mecanico registra el repuesto en terreno; el precio lo carga despues quien valoriza
        assert.strictEqual(calcularTotalFacturable([linea('si', 1, null)]), 0);
    });

    test('cantidades y precios NUMERIC que llegan como texto desde Postgres se suman como numeros', () => {
        // pg devuelve NUMERIC como string ('2.000', '1500.00'); se documenta el comportamiento actual
        const lineas = [
            linea('si', '2.000', '1500.00'),
            linea('no', '1.000', '900.00'),
            linea('si', '1.000', null),
        ];
        assert.strictEqual(calcularTotalFacturable(lineas), 3000);
    });

    test('sin lineas el total es cero', () => {
        assert.strictEqual(calcularTotalFacturable([]), 0);
        assert.strictEqual(calcularTotalFacturable(null), 0);
    });
});
