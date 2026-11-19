const test = require('node:test');
const assert = require('node:assert/strict');
const { validarFichaCliente, validarFichaPropia, fichaDeFila, diferenciasFicha } = require('../src/utils/fichaCliente');

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

// ---- ficha propia (PATCH /api/clientes/mia) ----

test('ficha propia: acepta solo los campos de la lista blanca y los normaliza', () => {
    const r = validarFichaPropia({
        email: ' Ana@Empresa.CL ', telefono: '+56 9 1234 5678', direccion: ' Calle 1 ',
        horario_trabajo: '08:00-18:00', horario_colacion: '  ',
    });
    assert.deepEqual(r, {
        cambios: {
            email: 'ana@empresa.cl', telefono: '+56 9 1234 5678', direccion: 'Calle 1',
            horario_trabajo: '08:00-18:00', horario_colacion: null,
        },
    });
    // telefono y direccion si pueden quedar vacios
    assert.deepEqual(validarFichaPropia({ telefono: '', direccion: null }).cambios, { telefono: null, direccion: null });
});

test('ficha propia: rechaza lo que solo cambia GOMAQ, ids y claves desconocidas (no las ignora)', () => {
    for (const clave of ['nombre', 'rut', 'giro', 'plazo_pago_dias', 'ejecutivo_id', 'id', 'cliente_id', 'created_at', 'otra', '__proto__x']) {
        const r = validarFichaPropia({ email: 'a@b.cl', [clave]: 'x' });
        assert.equal(r.error, 'Ese dato lo actualiza GOMAQ', clave);
        assert.equal(r.cambios, undefined, clave);
    }
});

test('ficha propia: el correo no puede quedar vacio ni mal escrito', () => {
    for (const email of ['', '   ', null]) assert.ok(validarFichaPropia({ email }).error, String(email));
    for (const email of ['sin-arroba', 'a@b', 'a b@c.cl', 5, ['a@b.cl']]) assert.ok(validarFichaPropia({ email }).error, String(email));
    assert.ok(validarFichaPropia({ email: 'x'.repeat(150) + '@a.cl' }).error, 'mas de 150 caracteres');
});

test('ficha propia: maximos de texto y de horarios', () => {
    assert.ok(validarFichaPropia({ telefono: '1'.repeat(31) }).error);
    assert.ok(validarFichaPropia({ direccion: 'x'.repeat(301) }).error);
    assert.equal(validarFichaPropia({ horario_trabajo: 'x'.repeat(100) }).cambios.horario_trabajo.length, 100);
    assert.ok(validarFichaPropia({ horario_trabajo: 'x'.repeat(101) }).error);
    assert.ok(validarFichaPropia({ horario_colacion: 'x'.repeat(101) }).error);
    assert.ok(validarFichaPropia({ horario_trabajo: 8 }).error);
    assert.ok(validarFichaPropia({ direccion: 8 }).error);
});

test('ficha propia: las coordenadas van las dos o ninguna; null y null las borran', () => {
    assert.deepEqual(validarFichaPropia({ latitud: -38.7359123, longitud: -72.5904 }).cambios, { latitud: -38.735912, longitud: -72.5904 });
    assert.deepEqual(validarFichaPropia({ latitud: null, longitud: null }).cambios, { latitud: null, longitud: null });
    assert.ok(validarFichaPropia({ latitud: -38.7 }).error);
    assert.ok(validarFichaPropia({ longitud: -72.5 }).error);
    assert.ok(validarFichaPropia({ latitud: -38.7, longitud: null }).error);
    assert.ok(validarFichaPropia({ latitud: 91, longitud: 0 }).error);
    assert.ok(validarFichaPropia({ latitud: '-38.7', longitud: '-72.5' }).error);
});

test('ficha propia: un cuerpo vacio o que no es un objeto no cambia nada', () => {
    for (const cuerpo of [{}, undefined, null, 'x', [], 5]) assert.ok(validarFichaPropia(cuerpo).error, String(cuerpo));
});

test('fichaDeFila copia solo los campos de la ficha y pasa las coordenadas a numero', () => {
    const f = fichaDeFila({
        id: 3, nombre: 'Ana SpA', rut: '76.809.295-8', giro: 'Obras', email: 'a@b.cl', telefono: null, direccion: 'Calle 1',
        horario_trabajo: null, horario_colacion: null, plazo_pago_dias: 30, latitud: '-38.735900', longitud: '-72.590400',
        ejecutivo_id: 9, created_at: new Date(),
    });
    assert.deepEqual(Object.keys(f).sort(), [
        'direccion', 'email', 'giro', 'horario_colacion', 'horario_trabajo', 'latitud', 'longitud',
        'nombre', 'plazo_pago_dias', 'rut', 'telefono',
    ]);
    assert.equal(f.latitud, -38.7359);
    assert.equal(f.ejecutivo_id, undefined);
    assert.equal(fichaDeFila({ latitud: null, longitud: null }).latitud, null);
});

test('diferenciasFicha deja solo lo que cambia, con su valor de antes y de despues', () => {
    const antes = { email: 'a@b.cl', telefono: null, direccion: 'Calle 1', latitud: '-38.735900', longitud: '-72.590400' };
    assert.deepEqual(
        diferenciasFicha(antes, { email: 'a@b.cl', telefono: '+56 9 1234 5678', latitud: -38.7359, longitud: -72.59 }),
        { telefono: { antes: null, despues: '+56 9 1234 5678' }, longitud: { antes: -72.5904, despues: -72.59 } }
    );
    assert.deepEqual(diferenciasFicha(antes, { email: 'a@b.cl', latitud: -38.7359 }), {});
});
