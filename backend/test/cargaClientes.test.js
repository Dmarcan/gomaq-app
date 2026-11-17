const test = require('node:test');
const assert = require('node:assert/strict');
const {
    EJECUTIVOS_A_CREAR, normalizarRut, sinAcentos, validarCliente, validarArchivo, resolverEjecutivo, plazoConstante,
} = require('../src/utils/cargaClientes');

const base = { rut: '11111111-1', nombre: 'Empresa Ficticia SpA', direccion: 'Calle 1', giro: 'Servicios', ejecutivo: null, plazo_pago_dias: null };

test('normalizarRut quita puntos y espacios y deja el guion', () => {
    assert.equal(normalizarRut('11.111.111-1'), '11111111-1');
    assert.equal(normalizarRut(' 111111111 '), '11111111-1');
    assert.equal(normalizarRut('10.000.013-k'), '10000013-K');
});

test('normalizarRut rechaza digito verificador malo o formato roto', () => {
    for (const r of ['11111111-2', '', 'abc', null, undefined, 11111111, '1-9']) assert.equal(normalizarRut(r), null, String(r));
});

test('un registro correcto no trae errores, con y sin datos opcionales', () => {
    assert.deepEqual(validarCliente(base), []);
    assert.deepEqual(validarCliente({ rut: '22222222-2', nombre: 'X' }), []);
});

test('rechaza cualquier registro con correo, telefono o contacto', () => {
    for (const campo of ['email', 'correo', 'telefono', 'contacto']) {
        assert.ok(validarCliente({ ...base, [campo]: null }).length > 0, campo);
        assert.ok(validarCliente({ ...base, [campo]: 'x' }).length > 0, campo);
    }
});

test('valida largos, ejecutivo y plazo', () => {
    assert.ok(validarCliente({ ...base, nombre: '' }).length);
    assert.ok(validarCliente({ ...base, nombre: 'a'.repeat(151) }).length);
    assert.ok(validarCliente({ ...base, nombre: ' con espacios ' }).length);
    assert.ok(validarCliente({ ...base, giro: 'a'.repeat(151) }).length);
    assert.ok(validarCliente({ ...base, direccion: 'a'.repeat(301) }).length);
    assert.ok(validarCliente({ ...base, ejecutivo: 'Carlos' }).length);
    assert.deepEqual(validarCliente({ ...base, ejecutivo: 'Oscar' }), []);
    for (const p of [-1, 366, 1.5, '30']) assert.ok(validarCliente({ ...base, plazo_pago_dias: p }).length, String(p));
    for (const p of [0, 30, 365]) assert.deepEqual(validarCliente({ ...base, plazo_pago_dias: p }), [], String(p));
    assert.ok(validarCliente({ ...base, rut: '11.111.111-1' }).length, 'el RUT debe venir normalizado');
    assert.ok(validarCliente({ ...base, rut: '11111111-2' }).length);
    assert.ok(validarCliente({ ...base, extra: 1 }).length);
});

test('validarArchivo detecta RUT repetidos aunque vengan escritos distinto', () => {
    const r = validarArchivo([base, { ...base, nombre: 'Otra' }]);
    assert.deepEqual(r.repetidos, ['11111111-1']);
    assert.ok(r.errores.length >= 1);
    assert.deepEqual(validarArchivo([base, { ...base, rut: '22222222-2' }]).errores, []);
    assert.ok(validarArchivo({}).errores.length);
});

test('resolverEjecutivo: ninguno, uno y ambiguo, sin acentos ni mayusculas', () => {
    const lista = [{ id: 1, nombre: 'Freddy Soto' }, { id: 2, nombre: 'ALEJANDRA' }, { id: 3, nombre: 'Oscar Pérez' }, { id: 4, nombre: 'Oscar Díaz' }];
    assert.deepEqual(resolverEjecutivo('Freddy', lista), { estado: 'uno', id: 1 });
    assert.deepEqual(resolverEjecutivo('alejandra', lista), { estado: 'uno', id: 2 });
    assert.deepEqual(resolverEjecutivo('Oscar', lista), { estado: 'ambiguo', id: null });
    assert.deepEqual(resolverEjecutivo('Wenceslao', lista), { estado: 'ninguno', id: null });
    assert.deepEqual(resolverEjecutivo('Fred', lista), { estado: 'ninguno', id: null });
    assert.deepEqual(resolverEjecutivo('', lista), { estado: 'ninguno', id: null });
    assert.deepEqual(resolverEjecutivo('Freddy', []), { estado: 'ninguno', id: null });
});

test('plazoConstante: solo si todas las facturas tuvieron el mismo plazo', () => {
    assert.equal(plazoConstante([30, 30, 30]), 30);
    assert.equal(plazoConstante([0]), 0);
    assert.equal(plazoConstante([30, 45]), null);
    assert.equal(plazoConstante([]), null);
    assert.equal(plazoConstante([30, -2]), null);
    assert.equal(plazoConstante(undefined), null);
});

test('la lista de ejecutivos a crear no incluye a Carlos ni a el jefe de taller', () => {
    assert.deepEqual(EJECUTIVOS_A_CREAR, ['Freddy', 'Alejandra', 'Wenceslao', 'Oscar']);
    assert.equal(sinAcentos('  ÁÉ  Íó '), 'ae io');
});
