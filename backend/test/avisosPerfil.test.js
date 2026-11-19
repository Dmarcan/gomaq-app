const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { CATALOGO, avisosDelRol, armarAvisos, validarCambioAvisos, aplicarCambioAvisos } = require('../src/utils/avisosPerfil');
const { DESTINOS_PUSH, motivoDescarte } = require('../src/utils/push');

const tipos = (lista) => lista.map((a) => a.tipo);

describe('catalogo de avisos', () => {
    test('cada tipo de push tiene su titulo y explicacion (un tipo nuevo sin catalogo no se puede configurar)', () => {
        for (const tipo of Object.keys(DESTINOS_PUSH)) {
            const a = CATALOGO.find((c) => c.tipo === tipo);
            assert.ok(a, `falta ${tipo} en CATALOGO de utils/avisosPerfil.js`);
            assert.ok(a.titulo.length > 0 && a.descripcion.length > 0);
        }
    });
    test('el catalogo no tiene tipos que ya no existen ni repetidos', () => {
        const todos = tipos(CATALOGO);
        assert.equal(new Set(todos).size, todos.length);
        for (const t of todos) assert.ok(DESTINOS_PUSH[t], `${t} ya no tiene push`);
    });
});

describe('avisosDelRol', () => {
    test('cada rol ve solo los avisos que le llegan', () => {
        assert.deepEqual(tipos(avisosDelRol('mecanico')), ['ot_asignada', 'ot_reasignada', 'ot_disponible']);
        assert.deepEqual(tipos(avisosDelRol('administrativo')), ['ot_por_valorizar', 'asistencia_nueva', 'mantencion_proxima']);
        assert.deepEqual(tipos(avisosDelRol('gerente')), [
            'ot_por_valorizar', 'asistencia_nueva', 'mantencion_proxima', 'factura_anulada', 'ajuste_inventario',
        ]);
        assert.deepEqual(tipos(avisosDelRol('cliente')), ['mecanico_asignado', 'ot_finalizada']);
    });
    test('un rol desconocido no ve ninguno', () => {
        assert.deepEqual(avisosDelRol('otro'), []);
    });
});

describe('armarAvisos', () => {
    test('por defecto todo activo, salvo la mantencion, que depende de recibe_alertas_mantencion', () => {
        const l = armarAvisos('administrativo', { avisos_silenciados: [], recibe_alertas_mantencion: false });
        assert.deepEqual(l.map((a) => [a.tipo, a.activo]), [['ot_por_valorizar', true], ['asistencia_nueva', true], ['mantencion_proxima', false]]);
    });
    test('lo silenciado sale apagado y la mantencion encendida sale activa', () => {
        const l = armarAvisos('gerente', { avisos_silenciados: ['factura_anulada'], recibe_alertas_mantencion: true });
        const por = Object.fromEntries(l.map((a) => [a.tipo, a.activo]));
        assert.equal(por.factura_anulada, false);
        assert.equal(por.mantencion_proxima, true);
        assert.equal(por.ajuste_inventario, true);
    });
    test('tolera un usuario sin los campos', () => {
        assert.equal(armarAvisos('mecanico', undefined).every((a) => a.activo), true);
    });
});

describe('validarCambioAvisos', () => {
    test('acepta tipos del rol con true o false', () => {
        const r = validarCambioAvisos('administrativo', { ot_por_valorizar: false, mantencion_proxima: true });
        assert.deepEqual(r, { cambios: { ot_por_valorizar: false, mantencion_proxima: true } });
    });
    test('rechaza un tipo de otro rol, uno inventado y valores que no son booleanos', () => {
        assert.match(validarCambioAvisos('administrativo', { factura_anulada: false }).error, /no existe para tu perfil/);
        assert.match(validarCambioAvisos('mecanico', { ot_por_valorizar: false }).error, /no existe para tu perfil/);
        assert.match(validarCambioAvisos('gerente', { inventado: false }).error, /no existe/);
        assert.match(validarCambioAvisos('gerente', { factura_anulada: 'no' }).error, /true o false/);
        assert.match(validarCambioAvisos('gerente', { factura_anulada: 0 }).error, /true o false/);
    });
    test('rechaza lo que no es un objeto', () => {
        for (const malo of [null, [], 'x', 5, true]) assert.ok(validarCambioAvisos('gerente', malo).error, JSON.stringify(malo));
    });
    test('un objeto vacio es valido y no cambia nada', () => {
        assert.deepEqual(validarCambioAvisos('gerente', {}), { cambios: {} });
    });
    test('no se puede colar __proto__ ni claves heredadas', () => {
        assert.ok(validarCambioAvisos('gerente', JSON.parse('{"__proto__": true}')).error);
        assert.ok(validarCambioAvisos('gerente', { toString: false }).error);
    });
});

describe('aplicarCambioAvisos', () => {
    test('apagar agrega a los silenciados; encender los saca; sin repetidos y ordenado', () => {
        let r = aplicarCambioAvisos([], { ot_por_valorizar: false, asistencia_nueva: false });
        assert.deepEqual(r.avisosSilenciados, ['asistencia_nueva', 'ot_por_valorizar']);
        r = aplicarCambioAvisos(r.avisosSilenciados, { ot_por_valorizar: true, asistencia_nueva: false });
        assert.deepEqual(r.avisosSilenciados, ['asistencia_nueva']);
        assert.equal(r.recibeMantencion, undefined);
    });
    test('la mantencion no va a los silenciados: cambia recibe_alertas_mantencion', () => {
        const r = aplicarCambioAvisos(['factura_anulada'], { mantencion_proxima: true });
        assert.deepEqual(r.avisosSilenciados, ['factura_anulada']);
        assert.equal(r.recibeMantencion, true);
        assert.equal(aplicarCambioAvisos([], { mantencion_proxima: false }).recibeMantencion, false);
    });
    test('tolera nulo como lista actual', () => {
        assert.deepEqual(aplicarCambioAvisos(null, { ot_asignada: false }).avisosSilenciados, ['ot_asignada']);
    });
});

describe('motivoDescarte: un aviso ya encolado que el usuario silencio despues', () => {
    const dispositivo = (extra = {}) => ({ activo: true, usuario_id: 7, estado_cuenta: 'activo', app: 'panel', rol: 'administrativo', avisos_silenciados: [], ...extra });
    const aviso = { tipo: 'ot_por_valorizar', usuario_id: 7, created_at: new Date() };
    test('se cancela si el tipo esta silenciado', () => {
        assert.equal(motivoDescarte({ aviso, dispositivo: dispositivo({ avisos_silenciados: ['ot_por_valorizar'] }) }), 'El usuario silencio este aviso');
    });
    test('sigue vigente si lo silenciado es otro tipo, o si el dato no viene (worker antiguo)', () => {
        assert.equal(motivoDescarte({ aviso, dispositivo: dispositivo({ avisos_silenciados: ['asistencia_nueva'] }) }), null);
        assert.equal(motivoDescarte({ aviso, dispositivo: dispositivo({ avisos_silenciados: undefined }) }), null);
    });
});
