const test = require('node:test');
const assert = require('node:assert/strict');
const { columnaOtAbierta } = require('../src/utils/otAbiertaEquipo');

test('administrativo y gerente reciben la columna ot_abierta', () => {
    for (const rol of ['administrativo', 'gerente']) {
        const sql = columnaOtAbierta(rol);
        assert.match(sql, /AS ot_abierta/);
        assert.match(sql, /<> 'finalizada'/);
    }
});

test('mecanico y otros roles no la reciben', () => {
    for (const rol of ['mecanico', 'cliente', undefined]) {
        assert.equal(columnaOtAbierta(rol), '');
    }
});
