const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validarSecretoJwt, MIN_LARGO } = require('../src/utils/secretoJwt');

const bueno = '9f3c1a7be04d52a8c6e1b0f7d3a49c25e8b6710f4ad39c5e'; // 48 caracteres variados

describe('validarSecretoJwt', () => {
    test('en produccion acepta un secreto largo y variado', () => {
        assert.deepEqual(validarSecretoJwt(bueno, 'production'), { ok: true });
        assert.deepEqual(validarSecretoJwt('a'.repeat(0) + bueno.slice(0, MIN_LARGO), 'production'), { ok: true });
    });

    test('en produccion rechaza vacio, ausente y no texto', () => {
        for (const v of [undefined, null, '', '   ', 123, {}]) {
            assert.equal(validarSecretoJwt(v, 'production').ok, false, String(v));
        }
    });

    test('en produccion rechaza un secreto corto', () => {
        const r = validarSecretoJwt(bueno.slice(0, MIN_LARGO - 1), 'production');
        assert.equal(r.ok, false);
        assert.match(r.motivo, /31 caracteres/);
    });

    test('en produccion rechaza los valores de ejemplo, aunque sean largos', () => {
        for (const v of [
            'changeme-generar-uno-largo-y-aleatorio',
            'CHANGEME-generar-uno-largo-y-aleatorio',
            'secreto-solo-para-ci-y-pruebas-largo-largo',
            'password-password-password-password-1',
        ]) {
            const r = validarSecretoJwt(v, 'production');
            assert.equal(r.ok, false, v);
            assert.match(r.motivo, /ejemplo/);
        }
    });

    test('en produccion rechaza un secreto de un solo caracter repetido', () => {
        assert.equal(validarSecretoJwt('a'.repeat(64), 'production').ok, false);
        assert.equal(validarSecretoJwt('ab'.repeat(32), 'production').ok, false);
    });

    test('fuera de produccion no exige nada (desarrollo y CI usan secretos de prueba)', () => {
        for (const entorno of [undefined, 'development', 'test', '']) {
            assert.deepEqual(validarSecretoJwt('corto', entorno), { ok: true });
        }
    });
});
