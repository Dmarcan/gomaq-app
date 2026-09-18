// Lectura del uuid_cliente con que la cola offline marca cada tarea (utils/idempotencia.js).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { leerUuidCliente, esUuidDuplicado } = require('../src/utils/idempotencia');

describe('leerUuidCliente', () => {
    test('es opcional: el panel y los APK anteriores no lo envian', () => {
        assert.deepEqual(leerUuidCliente({}), { valido: true, uuid: null });
        assert.deepEqual(leerUuidCliente({ uuid_cliente: null }), { valido: true, uuid: null });
        assert.deepEqual(leerUuidCliente({ uuid_cliente: '' }), { valido: true, uuid: null });
        assert.deepEqual(leerUuidCliente(undefined), { valido: true, uuid: null });
    });

    test('acepta un UUID y lo normaliza a minusculas', () => {
        const r = leerUuidCliente({ uuid_cliente: '3F2504E0-4F89-41D3-9A0C-0305E82C3301' });
        assert.deepEqual(r, { valido: true, uuid: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' });
    });

    test('rechaza valores malformados antes de que lleguen a Postgres', () => {
        for (const malo of ['no-es-uuid', '1234', 42, { a: 1 }, "'; DROP TABLE x; --"]) {
            assert.equal(leerUuidCliente({ uuid_cliente: malo }).valido, false, String(malo));
        }
    });
});

describe('esUuidDuplicado', () => {
    test('reconoce solo el choque con la restriccion de uuid_cliente', () => {
        assert.equal(esUuidDuplicado({ code: '23505', constraint: 'movimientos_insumo_uuid_cliente_key' }), true);
        assert.equal(esUuidDuplicado({ code: '23505', constraint: 'vehiculos_patente_key' }), false);
        assert.equal(esUuidDuplicado({ code: '23503', constraint: 'x_uuid_cliente_key' }), false);
        assert.equal(esUuidDuplicado(null), false);
    });
});
