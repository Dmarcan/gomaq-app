const test = require('node:test');
const assert = require('node:assert/strict');
const { validarTraslado, ingresoSinTraslado } = require('../src/utils/trasladoFactura');
const { calcularIngreso } = require('../src/utils/rentabilidad');

test('traslado vacio, nulo o ausente vale 0', () => {
    for (const v of [undefined, null, '']) assert.deepEqual(validarTraslado(100000, v), { traslado: 0 });
});

test('traslado valido hasta el monto total', () => {
    assert.deepEqual(validarTraslado(249900, '140000'), { traslado: 140000 });
    assert.deepEqual(validarTraslado(100000, 100000), { traslado: 100000 });
    assert.deepEqual(validarTraslado(null, 0), { traslado: 0 });
});

test('traslado invalido se rechaza', () => {
    for (const v of ['-5', '1.5', 'abc', '1.000', -1]) assert.ok(validarTraslado(100000, v).error, String(v));
    assert.ok(validarTraslado(100000, 100001).error);
    assert.match(validarTraslado(null, 5000).error, /monto/);
    assert.match(validarTraslado('', 5000).error, /monto/);
});

test('ingresoSinTraslado resta el traslado y no baja de 0', () => {
    assert.equal(ingresoSinTraslado(249900, 140000), 109900);
    assert.equal(ingresoSinTraslado(100, 500), 0);
    assert.equal(ingresoSinTraslado('100000', null), 100000);
    assert.equal(ingresoSinTraslado('100000.00', '20000.00'), 80000);
    assert.equal(ingresoSinTraslado(null, 0), 0);
    assert.equal(ingresoSinTraslado(undefined, 0), null);
});

test('calcularIngreso cuenta solo el arriendo', () => {
    assert.equal(calcularIngreso([{ monto: '100000', monto_traslado: '20000' }, { monto: 50000 }, { monto: null }]), 130000);
    assert.equal(calcularIngreso([{ monto: 249900, monto_traslado: 140000 }]), 109900);
});
