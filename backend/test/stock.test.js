const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { aplicarMovimiento, hayDescuadre, totalPorInsumo, validarTransferencia } = require('../src/utils/stock');

describe('aplicarMovimiento', () => {
    test('suma lo que entra y resta lo que sale', () => {
        assert.strictEqual(aplicarMovimiento(10, 5), 15);
        assert.strictEqual(aplicarMovimiento(10, -4), 6);
    });

    test('deja el furgon en negativo en vez de bloquear el registro', () => {
        // el repuesto ya se instalo: impedir anotarlo solo hace que el dato se pierda
        assert.strictEqual(aplicarMovimiento(1, -3), -2);
    });

    test('una existencia que no existia parte de cero', () => {
        assert.strictEqual(aplicarMovimiento(null, 5), 5);
        assert.strictEqual(aplicarMovimiento(undefined, 2), 2);
    });

    test('un delta invalido no altera la existencia', () => {
        assert.strictEqual(aplicarMovimiento(10, 'abc'), 10);
    });
});

describe('hayDescuadre', () => {
    test('solo bajo cero hay descuadre', () => {
        assert.strictEqual(hayDescuadre(-1), true);
        assert.strictEqual(hayDescuadre(0), false);
        assert.strictEqual(hayDescuadre(5), false);
    });
});

describe('totalPorInsumo', () => {
    test('el total es la suma de las ubicaciones', () => {
        // es lo que se guarda en insumos.stock_actual, para que el panel siga funcionando
        assert.strictEqual(totalPorInsumo([{ cantidad: 10 }, { cantidad: 4 }, { cantidad: 1 }]), 15);
    });

    test('un furgon en negativo baja el total', () => {
        assert.strictEqual(totalPorInsumo([{ cantidad: 10 }, { cantidad: -2 }]), 8);
    });

    test('sin ubicaciones el total es cero', () => {
        assert.strictEqual(totalPorInsumo([]), 0);
        assert.strictEqual(totalPorInsumo(null), 0);
    });
});

describe('validarTransferencia', () => {
    const base = { cantidad: 5, disponibleOrigen: 10, origenId: 1, destinoId: 2 };

    test('acepta una transferencia con stock suficiente', () => {
        assert.strictEqual(validarTransferencia(base).valida, true);
    });

    test('rechaza sacar mas de lo que hay en bodega', () => {
        // a diferencia del consumo en terreno, esto pasa en el taller y con señal:
        // un descuadre aca es un error de tipeo, no un hecho consumado
        const r = validarTransferencia({ ...base, cantidad: 20 });
        assert.strictEqual(r.valida, false);
        assert.match(r.error, /suficiente/);
    });

    test('rechaza cantidades no positivas', () => {
        assert.strictEqual(validarTransferencia({ ...base, cantidad: 0 }).valida, false);
        assert.strictEqual(validarTransferencia({ ...base, cantidad: -1 }).valida, false);
        assert.strictEqual(validarTransferencia({ ...base, cantidad: 'x' }).valida, false);
    });

    test('rechaza mover a la misma ubicacion', () => {
        const r = validarTransferencia({ ...base, destinoId: 1 });
        assert.strictEqual(r.valida, false);
        assert.match(r.error, /misma ubicaci[oó]n/);
    });

    test('exige origen y destino', () => {
        assert.strictEqual(validarTransferencia({ ...base, origenId: null }).valida, false);
        assert.strictEqual(validarTransferencia({ ...base, destinoId: null }).valida, false);
    });
});
