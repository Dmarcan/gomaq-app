const test = require('node:test');
const assert = require('node:assert/strict');
const { armarMensajePush, clasificarErrorFcm, motivoDescarte, destinoPush, TIPOS_CON_PUSH } = require('../src/utils/push');

test('los tipos con push y a que app y roles va cada uno', () => {
    assert.deepEqual([...TIPOS_CON_PUSH].sort(), [
        'ajuste_inventario', 'asistencia_nueva', 'factura_anulada', 'mantencion_proxima', 'mecanico_asignado',
        'ot_asignada', 'ot_disponible', 'ot_finalizada', 'ot_por_valorizar', 'ot_reasignada',
    ]);
    for (const tipo of ['ot_asignada', 'ot_reasignada', 'ot_disponible']) {
        assert.deepEqual(destinoPush(tipo), { app: 'terreno', roles: ['mecanico'] }, tipo);
    }
    for (const tipo of ['ot_por_valorizar', 'asistencia_nueva', 'mantencion_proxima']) {
        assert.deepEqual(destinoPush(tipo), { app: 'panel', roles: ['gerente', 'administrativo'] }, tipo);
    }
    for (const tipo of ['factura_anulada', 'ajuste_inventario']) {
        assert.deepEqual(destinoPush(tipo), { app: 'panel', roles: ['gerente'] }, tipo);
    }
    for (const tipo of ['mecanico_asignado', 'ot_finalizada']) {
        assert.deepEqual(destinoPush(tipo), { app: 'panel', roles: ['cliente'] }, tipo);
    }
    for (const tipo of ['cuenta_aprobada', 'factura_emitida', 'toString', undefined]) assert.equal(destinoPush(tipo), null, String(tipo));
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
    assert.equal(armarMensajePush({ tipo: 'cuenta_aprobada', orden_trabajo_id: 5 }), null, 'un tipo sin push no arma mensaje');
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
    dispositivo: { activo: true, app: 'terreno', rol: 'mecanico', cliente_id: null, usuario_id: 4, estado_cuenta: 'activo', sesion_id: null, sesion_revocada_at: null, sesion_expira_at: null },
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
        'dispositivo de otra app': (e) => { e.dispositivo.app = 'panel'; },
        'rol que ya no corresponde': (e) => { e.dispositivo.rol = 'cliente'; },
        'tipo sin push': (e) => { e.aviso.tipo = 'cuenta_aprobada'; },
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

/** Un aviso sano de un tipo de oficina o de cliente, con el dispositivo y el usuario que le corresponden. */
const sanoDe = (tipo, app, rol, extra = {}) => ({
    aviso: { tipo, usuario_id: 4, created_at: new Date('2026-11-19T11:50:00Z'), ...extra },
    dispositivo: { activo: true, app, rol, cliente_id: 8, usuario_id: 4, estado_cuenta: 'activo', sesion_id: null, sesion_revocada_at: null, sesion_expira_at: null },
});

test('motivoDescarte: los avisos de gerencia, oficina y cliente solo valen para su app y su rol', () => {
    assert.equal(motivoDescarte(sanoDe('ot_por_valorizar', 'panel', 'administrativo'), ahora), null);
    assert.equal(motivoDescarte(sanoDe('ot_por_valorizar', 'panel', 'gerente'), ahora), null);
    assert.equal(motivoDescarte(sanoDe('factura_anulada', 'panel', 'gerente'), ahora), null);
    assert.equal(motivoDescarte(sanoDe('mecanico_asignado', 'panel', 'cliente', { cliente_id: 8 }), ahora), null);
    // un administrativo no recibe lo reservado al gerente
    assert.match(motivoDescarte(sanoDe('factura_anulada', 'panel', 'administrativo'), ahora), /rol/);
    assert.match(motivoDescarte(sanoDe('ajuste_inventario', 'panel', 'administrativo'), ahora), /rol/);
    // un telefono de terreno no recibe avisos de gerencia ni del cliente
    assert.match(motivoDescarte(sanoDe('ot_por_valorizar', 'terreno', 'administrativo'), ahora), /otra app/);
    assert.match(motivoDescarte(sanoDe('ot_finalizada', 'terreno', 'cliente'), ahora), /otra app/);
    // el panel no recibe avisos del mecanico
    assert.match(motivoDescarte(sanoDe('ot_asignada', 'panel', 'mecanico'), ahora), /otra app/);
    // el rol cambio despues de encolar
    assert.match(motivoDescarte(sanoDe('ot_finalizada', 'panel', 'administrativo'), ahora), /rol/);
    assert.match(motivoDescarte(sanoDe('ot_por_valorizar', 'panel', 'cliente'), ahora), /rol/);
});

test('motivoDescarte: el aviso al cliente solo vale si el usuario sigue siendo de la empresa de la orden', () => {
    assert.match(motivoDescarte(sanoDe('ot_finalizada', 'panel', 'cliente', { cliente_id: 9 }), ahora), /empresa/);
    const sinEmpresa = sanoDe('ot_finalizada', 'panel', 'cliente', { cliente_id: 8 });
    sinEmpresa.dispositivo.cliente_id = null;
    assert.match(motivoDescarte(sinEmpresa, ahora), /empresa/);
});

// ----- mensajes de los tipos nuevos: lista blanca estricta -----

const PROHIBIDOS = ['Secreta', '11.111.111-1', 'AB1234', '-33.4', '-70.6', '150000', 'observacion reservada', 'Juan Perez', 'falla grave', 'Mina Norte'];
/** Payload con TODO lo que un aviso real podria traer: nada de esto debe llegar al telefono. */
const sucio = (tipo, extra = {}) => ({
    tipo, orden_trabajo_id: 12, maquinaria_id: 3, maquinaria_codigo: 'EXC-04', folio: 'F-77',
    motivo: 'Constructora Secreta: falla grave', causa: 'Orden finalizada', mecanico_nombre: 'Juan Perez', mecanico_rut: '11.111.111-1',
    vehiculo: { patente: 'AB1234', marca: 'Ford' }, latitud: -33.4, longitud: -70.6, monto: 150000, observacion_final: 'observacion reservada',
    insumo_nombre: 'Aceite', ubicacion_nombre: 'Mina Norte', delta: -5, registrado_por: 'Juan Perez', horas_restantes: 20, gravedad: 'alta',
    cliente_nombre: 'Constructora Secreta', usuario_id: 4, cliente_id: 8, ...extra,
});

test('armarMensajePush: titulos y textos de los tipos nuevos', () => {
    const esperado = {
        ot_por_valorizar: ['Orden por valorizar', 'OT #12, equipo EXC-04'],
        asistencia_nueva: ['Nueva asistencia solicitada', 'OT #12, equipo EXC-04'],
        mecanico_asignado: ['Tu equipo tiene tecnico asignado', 'OT #12, equipo EXC-04'],
        ot_finalizada: ['Tu orden de trabajo finalizo', 'OT #12, equipo EXC-04'],
        factura_anulada: ['Factura anulada', 'Folio F-77, OT #12'],
        ajuste_inventario: ['Ajuste de inventario con perdida', 'Revisa el conteo en Inventario'],
        mantencion_proxima: ['Mantencion proxima', 'Equipo EXC-04'],
    };
    for (const [tipo, [titulo, cuerpo]] of Object.entries(esperado)) {
        const m = armarMensajePush(sucio(tipo));
        assert.equal(m.titulo, titulo, tipo);
        assert.equal(m.cuerpo, cuerpo, tipo);
        assert.equal(m.data.tipo, tipo);
    }
    assert.equal(armarMensajePush(sucio('mantencion_proxima', { vencida: true })).titulo, 'Mantencion vencida');
});

test('armarMensajePush: ningun tipo filtra RUT, patente, coordenadas, montos, nombres ni observaciones', () => {
    const clavesData = new Set(['tipo', 'orden_trabajo_id', 'maquinaria_id']);
    for (const tipo of TIPOS_CON_PUSH) {
        const m = armarMensajePush(sucio(tipo));
        assert.ok(m, tipo);
        const texto = JSON.stringify(m);
        for (const prohibido of PROHIBIDOS) assert.ok(!texto.includes(prohibido), `${tipo} no debe filtrar ${prohibido}`);
        assert.deepEqual(Object.keys(m).sort(), ['cuerpo', 'data', 'tag', 'titulo'], tipo);
        for (const k of Object.keys(m.data)) assert.ok(clavesData.has(k), `${tipo}: data.${k} no esta en la lista blanca`);
        for (const v of Object.values(m.data)) assert.equal(typeof v, 'string', 'los valores de data van como texto');
    }
});

test('armarMensajePush al cliente: solo titulo corto y OT con equipo, sin nada del mecanico', () => {
    for (const tipo of ['mecanico_asignado', 'ot_finalizada']) {
        const m = armarMensajePush(sucio(tipo));
        assert.deepEqual(m.data, { tipo, orden_trabajo_id: '12' });
        assert.equal(m.cuerpo, 'OT #12, equipo EXC-04');
        assert.ok(!/Juan|Perez|AB1234|rut|monto|latitud|coordenada|llegada/i.test(JSON.stringify(m)), tipo);
    }
});

test('armarMensajePush: los tipos con OT la exigen; los sin OT piden lo suyo o un texto fijo', () => {
    for (const tipo of ['ot_por_valorizar', 'asistencia_nueva', 'mecanico_asignado', 'ot_finalizada']) {
        assert.equal(armarMensajePush({ tipo, orden_trabajo_id: 0 }), null, tipo);
        assert.equal(armarMensajePush({ tipo }), null, tipo);
    }
    assert.equal(armarMensajePush({ tipo: 'mantencion_proxima' }), null, 'sin equipo no hay aviso');
    assert.equal(armarMensajePush({ tipo: 'mantencion_proxima', maquinaria_id: 3 }).cuerpo, 'Equipo #3');
    const sinOt = armarMensajePush({ tipo: 'factura_anulada', orden_trabajo_id: null, folio: 'F-1' });
    assert.equal(sinOt.cuerpo, 'Folio F-1');
    assert.deepEqual(sinOt.data, { tipo: 'factura_anulada' });
    assert.equal(armarMensajePush({ tipo: 'factura_anulada' }).cuerpo, 'Revisa la factura anulada');
    assert.deepEqual(armarMensajePush({ tipo: 'ajuste_inventario' }).data, { tipo: 'ajuste_inventario' });
    // un folio con saltos de linea o enorme se limpia y se acota
    const folio = armarMensajePush({ tipo: 'factura_anulada', folio: 'F\n1' + 'x'.repeat(100) });
    assert.ok(!/\n/.test(folio.cuerpo) && folio.cuerpo.length <= 'Folio '.length + 40);
});
