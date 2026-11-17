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

test('giro: texto de hasta 150, vacio es null', () => {
    assert.equal(validarFichaCliente({ giro: ' Construccion ' }).cambios.giro, 'Construccion');
    assert.equal(validarFichaCliente({ giro: '' }).cambios.giro, null);
    assert.ok(validarFichaCliente({ giro: 'x'.repeat(151) }).error);
    assert.ok(validarFichaCliente({ giro: 5 }).error);
});

test('plazo de pago: entero de 0 a 365, texto de digitos o nulo', () => {
    const plazo = (v) => validarFichaCliente({ plazo_pago_dias: v });
    for (const [entrada, esperado] of [[0, 0], [30, 30], [365, 365], ['45', 45], [' 7 ', 7], [null, null], ['', null], ['0', 0]]) {
        assert.equal(plazo(entrada).cambios.plazo_pago_dias, esperado, String(entrada));
    }
    for (const malo of [366, -1, 1.5, '1.5', '-3', 'treinta', '1e2', NaN, Infinity, true, [30], {}, '99999']) {
        assert.ok(plazo(malo).error, String(malo));
    }
});

test('el plazo solo viaja si viene en el cuerpo', () => {
    assert.deepEqual(validarFichaCliente({ nombre: 'Ana' }).cambios, { nombre: 'Ana' });
    assert.deepEqual(validarFichaCliente({ plazo_pago_dias: 0 }), { cambios: { plazo_pago_dias: 0 } });
});
