const test = require('node:test');
const assert = require('node:assert/strict');
const { rutValido } = require('../src/utils/rut');
const { normalizarCorreo } = require('../src/utils/correo');

test('RUT validos con y sin puntos', () => {
    for (const r of ['76.123.456-0', '76123456-0', '761234560', '85.275.700-0', '76.809.295-8', '77.089.584-7', '85.275.700- 0']) {
        assert.equal(rutValido(r), true, r);
    }
});

test('RUT con K, mayuscula o minuscula', () => {
    assert.equal(rutValido('KRUT'), false);
    assert.equal(rutValido('10.000.013-K'), true);
    assert.equal(rutValido('10000013-k'), true);
    assert.equal(rutValido('10.000.013-0'), false);
});

test('RUT invalidos', () => {
    for (const r of ['76.123.456-7', 'abc', '', '   ', null, undefined, 123, '1-9', '76.123.456-X']) {
        assert.equal(rutValido(r), false, String(r));
    }
});

test('normalizarCorreo pasa a minusculas y recorta', () => {
    assert.equal(normalizarCorreo('  Ana@Empresa.CL '), 'ana@empresa.cl');
    assert.equal(normalizarCorreo(undefined), '');
});
