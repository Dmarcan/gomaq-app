const test = require('node:test');
const assert = require('node:assert/strict');
const { validarFichaCliente } = require('../src/utils/fichaCliente');

test('solo cambia los campos que vienen', () => {
    assert.deepEqual(validarFichaCliente({ email: ' Ana@Empresa.CL ' }), { cambios: { email: 'ana@empresa.cl' } });
    assert.deepEqual(
        validarFichaCliente({ telefono: '+56 9 1234 5678', direccion: 'Calle 1' }).cambios,
        { telefono: '+56 9 1234 5678', direccion: 'Calle 1' }
    );
});

test('un campo vacio se guarda como null, menos el nombre', () => {
    assert.deepEqual(
        validarFichaCliente({ email: '', telefono: '  ', rut: null, direccion: '' }).cambios,
        { email: null, telefono: null, rut: null, direccion: null }
    );
    assert.ok(validarFichaCliente({ nombre: '   ' }).error);
});

test('rechaza correo, RUT y tipos invalidos', () => {
    for (const email of ['sin-arroba', 'a@b', 'a b@c.cl']) assert.ok(validarFichaCliente({ email }).error, email);
    assert.ok(validarFichaCliente({ rut: '76.809.295-0' }).error);
    assert.equal(validarFichaCliente({ rut: '76.809.295-8' }).cambios.rut, '76.809.295-8');
    assert.ok(validarFichaCliente({ nombre: 123 }).error);
    assert.ok(validarFichaCliente({ email: ['a@b.cl'] }).error);
});

test('rechaza textos demasiado largos y cuerpos sin cambios', () => {
    assert.ok(validarFichaCliente({ nombre: 'x'.repeat(151) }).error);
    assert.ok(validarFichaCliente({ telefono: '1'.repeat(31) }).error);
    assert.ok(validarFichaCliente({}).error);
    assert.ok(validarFichaCliente(null).error);
    assert.ok(validarFichaCliente({ id: 5, latitud: 1 }).error, 'los campos desconocidos se ignoran');
});
