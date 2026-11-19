const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { vacio, num, numSinVacio, numValido } = require('../src/utils/valores');

describe('conversion de valores sueltos', () => {
    test('vacio: ausente, null y texto vacio; el cero y el texto con contenido no', () => {
        assert.equal(vacio(undefined), true);
        assert.equal(vacio(null), true);
        assert.equal(vacio(''), true);
        assert.equal(vacio(0), false);
        assert.equal(vacio('0'), false);
        assert.equal(vacio(' '), false);
    });

    test('num: null y undefined dan null; el texto numerico de Postgres se convierte', () => {
        assert.equal(num(null), null);
        assert.equal(num(undefined), null);
        assert.equal(num('1500.50'), 1500.5);
        assert.equal(num(7), 7);
        assert.equal(num(0), 0);
    });

    test('num: el texto vacio da 0 y el no numerico NaN (por eso existen las otras dos variantes)', () => {
        assert.equal(num(''), 0);
        assert.ok(Number.isNaN(num('abc')));
    });

    test('numSinVacio: como num, pero el texto vacio da null', () => {
        assert.equal(numSinVacio(''), null);
        assert.equal(numSinVacio(null), null);
        assert.equal(numSinVacio('12'), 12);
        assert.ok(Number.isNaN(numSinVacio('abc')));
    });

    test('numValido: ausente, vacio o no numerico dan null, nunca NaN', () => {
        assert.equal(numValido(undefined), null);
        assert.equal(numValido(''), null);
        assert.equal(numValido('abc'), null);
        assert.equal(numValido('12.5'), 12.5);
        assert.equal(numValido(0), 0);
    });
});
