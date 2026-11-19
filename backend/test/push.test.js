const test = require('node:test');
const assert = require('node:assert/strict');
const { armarMensajePush, clasificarErrorFcm, motivoDescarte, TIPOS_CON_PUSH } = require('../src/utils/push');

test('los tipos con push son las tres ordenes de trabajo', () => {
    assert.deepEqual([...TIPOS_CON_PUSH], ['ot_asignada', 'ot_reasignada', 'ot_disponible']);
});

test('armarMensajePush: titulo, texto corto y data con solo tipo y orden', () => {
    const m = armarMensajePush({ tipo: 'ot_asignada', orden_trabajo_id: 123, maquinaria_codigo: 'EXC-04' });
    assert.equal(m.titulo, 'Nueva orden asignada');
    assert.equal(m.cuerpo, 'OT #123, equipo EXC-04');
    assert.deepEqual(m.data, { tipo: 'ot_asignada', orden_trabajo_id: '123' });
    assert.equal(m.tag, 'ot-123-ot_asignada');
    assert.equal(armarMensajePush({ tipo: 'ot_reasignada', orden_trabajo_id: '7' }).titulo, 'Orden reasignada');
    assert.equal(armarMensajePush({ tipo: 'ot_disponible', orden_trabajo_id: 7 }).titulo, 'Orden disponible');
});

test('armarMensajePush: sin codigo de equipo solo dice la OT', () => {
    assert.equal(armarMensajePush({ tipo: 'ot_disponible', orden_trabajo_id: 9, maquinaria_codigo: null }).cuerpo, 'OT #9');
    assert.equal(armarMensajePush({ tipo: 'ot_disponible', orden_trabajo_id: 9, maquinaria_codigo: '   ' }).cuerpo, 'OT #9');
});

test('armarMensajePush: lista blanca, nada del resto del payload llega al telefono', () => {
    assert.equal(armarMensajePush({ tipo: 'mecanico_asignado', orden_trabajo_id: 5 }), null, 'un tipo sin push no arma mensaje');
    const completo = armarMensajePush({
        tipo: 'ot_asignada', orden_trabajo_id: 5, maquinaria_codigo: 'EXC-04',
        motivo: 'Cliente Constructora Secreta, falla grave', mecanico_rut: '11.111.111-1', patente: 'AB1234',
        latitud: -33.4, longitud: -70.6, monto: 150000, observacion_final: 'listo', cliente_nombre: 'Constructora Secreta',
    });
    const texto = JSON.stringify(completo);
    for (const prohibido of ['Secreta', '11.111.111-1', 'AB1234', '-33.4', '150000', 'listo']) {
        assert.ok(!texto.includes(prohibido), `no debe filtrar ${prohibido}`);
    }
    assert.deepEqual(Object.keys(completo).sort(), ['cuerpo', 'data', 'tag', 'titulo']);
    assert.deepEqual(Object.keys(completo.data).sort(), ['orden_trabajo_id', 'tipo']);
});

test('armarMensajePush: orden invalida o payload vacio devuelven null', () => {
    for (const p of [null, undefined, {}, { tipo: 'ot_asignada' }, { tipo: 'ot_asignada', orden_trabajo_id: 0 },
        { tipo: 'ot_asignada', orden_trabajo_id: -2 }, { tipo: 'ot_asignada', orden_trabajo_id: 'abc' },
        { tipo: 'ot_asignada', orden_trabajo_id: 1.5 }, { tipo: 'toString', orden_trabajo_id: 1 }]) {
        assert.equal(armarMensajePush(p), null, JSON.stringify(p));
    }
});

test('armarMensajePush: el codigo del equipo se limpia y se acota', () => {
    const m = armarMensajePush({ tipo: 'ot_asignada', orden_trabajo_id: 1, maquinaria_codigo: 'EXC\n\t04' + 'x'.repeat(100) });
    assert.ok(!/[\n\t]/.test(m.cuerpo));
    assert.ok(m.cuerpo.length <= 'OT #1, equipo '.length + 40);
});

const err = (status, errorCode, message = '', estadoTexto) => ({
    status,
    cuerpo: {
        error: {
            code: status, message, status: estadoTexto,
            details: errorCode ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }] : [],
        },
    },
});

test('clasificarErrorFcm: token muerto se descarta', () => {
    assert.equal(clasificarErrorFcm(err(404, 'UNREGISTERED', 'Requested entity was not found.', 'NOT_FOUND')).accion, 'descartar');
    assert.equal(clasificarErrorFcm({ status: 404, cuerpo: null }).accion, 'descartar');
    assert.equal(clasificarErrorFcm(err(400, null, 'The registration token is not a valid FCM registration token', 'INVALID_ARGUMENT')).accion, 'descartar');
    assert.equal(clasificarErrorFcm(err(400, 'INVALID_ARGUMENT', 'Invalid value at message.data', 'INVALID_ARGUMENT')).accion, 'permanente');
});

test('clasificarErrorFcm: credenciales y proyecto son configuracion', () => {
    assert.equal(clasificarErrorFcm(err(403, 'SENDER_ID_MISMATCH')).accion, 'configuracion');
    assert.equal(clasificarErrorFcm(err(401, null, '', 'UNAUTHENTICATED')).accion, 'configuracion');
    assert.equal(clasificarErrorFcm({ status: 403, cuerpo: null }).accion, 'configuracion');
});

test('clasificarErrorFcm: 429 y caidas se reintentan, con Retry-After si lo hay', () => {
    const limite = clasificarErrorFcm({ ...err(429, 'QUOTA_EXCEEDED'), reintentarEn: 120 });
    assert.deepEqual([limite.accion, limite.espera], ['reintentar', 120]);
    assert.equal(clasificarErrorFcm(err(429, 'QUOTA_EXCEEDED')).espera, 60);
    const caido = clasificarErrorFcm(err(503, 'UNAVAILABLE'));
    assert.deepEqual([caido.accion, caido.espera], ['reintentar', 30]);
    assert.equal(clasificarErrorFcm({ status: 500, cuerpo: null }).accion, 'reintentar');
});

test('clasificarErrorFcm: un 400 desconocido es permanente', () => {
    assert.equal(clasificarErrorFcm({ status: 400, cuerpo: { error: { message: 'raro' } } }).accion, 'permanente');
});

const ahora = new Date('2026-11-19T12:00:00Z');
const sano = () => ({
    aviso: { tipo: 'ot_asignada', usuario_id: 4, created_at: new Date('2026-11-19T11:50:00Z') },
    dispositivo: { activo: true, usuario_id: 4, estado_cuenta: 'activo', sesion_id: null, sesion_revocada_at: null, sesion_expira_at: null },
    otSinAsignar: true,
});

test('motivoDescarte: un aviso sano sigue vigente', () => {
    assert.equal(motivoDescarte(sano(), ahora), null);
    const conSesion = sano();
    conSesion.dispositivo.sesion_id = 8;
    conSesion.dispositivo.sesion_expira_at = new Date('2026-12-01T00:00:00Z');
    assert.equal(motivoDescarte(conSesion, ahora), null);
});

test('motivoDescarte: cada causa cancela el aviso', () => {
    const casos = {
        'dispositivo inexistente': (e) => { e.dispositivo = null; },
        'dispositivo inactivo': (e) => { e.dispositivo.activo = false; },
        'otro usuario': (e) => { e.dispositivo.usuario_id = 9; },
        'cuenta inactiva': (e) => { e.dispositivo.estado_cuenta = 'rechazado'; },
        'sesion revocada': (e) => { e.dispositivo.sesion_id = 8; e.dispositivo.sesion_revocada_at = new Date('2026-11-19T11:00:00Z'); },
        'sesion vencida': (e) => { e.dispositivo.sesion_id = 8; e.dispositivo.sesion_expira_at = new Date('2026-11-19T11:00:00Z'); },
        'aviso viejo': (e) => { e.aviso.created_at = new Date('2026-11-19T05:59:00Z'); },
        'ot tomada': (e) => { e.aviso.tipo = 'ot_disponible'; e.otSinAsignar = false; },
    };
    for (const [nombre, mutar] of Object.entries(casos)) {
        const e = sano();
        mutar(e);
        assert.equal(typeof motivoDescarte(e, ahora), 'string', nombre);
    }
});

test('motivoDescarte: ot_asignada no mira si la OT sigue sin asignar; el limite de 6 h es exacto', () => {
    const e = sano();
    e.otSinAsignar = false;
    assert.equal(motivoDescarte(e, ahora), null);
    e.aviso.created_at = new Date('2026-11-19T06:00:00Z');
    assert.equal(motivoDescarte(e, ahora), null, 'justo 6 h todavia vale');
});
