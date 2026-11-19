// Canal push del worker de notificaciones, sin base de datos: pool.query se reemplaza por un falso que
// responde segun la sentencia. Las consultas reales las valida el bloque "push" de escritura.test.js (con base).

const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/db');
const { enviarPush, procesarUna, usarEnvio } = require('../src/workers/notificaciones');

const ahora = Date.now();

/** Reemplaza pool.query por una funcion que responde por sentencia; devuelve las llamadas y restaura al final. */
function falsearPool(responder) {
    const original = pool.query;
    const llamadas = [];
    pool.query = async (sql, params) => {
        llamadas.push({ sql, params });
        return responder(sql, params);
    };
    return { llamadas, restaurar: () => { pool.query = original; usarEnvio(null); } };
}

const notificacion = (extra = {}) => ({
    id: 90, canal: 'push', destinatario: '31', intentos: 0,
    payload: { tipo: 'ot_asignada', orden_trabajo_id: 5, maquinaria_codigo: 'EXC-04', usuario_id: 4, motivo: 'texto interno', mecanico_rut: '1-9' },
    ...extra,
});

test('enviarPush: un tipo sin plantilla es error permanente', async () => {
    await assert.rejects(enviarPush(notificacion({ payload: { tipo: 'cuenta_aprobada', orden_trabajo_id: 5 } })), (e) => e.permanente === true);
});

test('enviarPush: un destinatario que no es id de dispositivo es error permanente', async () => {
    await assert.rejects(enviarPush(notificacion({ destinatario: 'abc' })), (e) => e.permanente === true);
});

test('enviarPush: dispositivo inactivo o borrado es error permanente', async () => {
    const f = falsearPool(() => ({ rows: [] }));
    try {
        await assert.rejects(enviarPush(notificacion()), (e) => e.permanente === true);
        assert.match(f.llamadas[0].sql, /activo/);
        assert.deepEqual(f.llamadas[0].params, [31]);
    } finally { f.restaurar(); }
});

test('enviarPush: manda a FCM solo el mensaje de la lista blanca y el token del dispositivo', async () => {
    const f = falsearPool(() => ({ rows: [{ token: 'tok-del-dispositivo-31' }] }));
    const enviados = [];
    try {
        await enviarPush(notificacion(), new AbortController().signal, {
            leerCuenta: () => ({ clientEmail: 'a', privateKey: 'k', projectId: 'p' }),
            enviarFcm: async (p) => { enviados.push(p); },
        });
    } finally { f.restaurar(); }
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].token, 'tok-del-dispositivo-31');
    assert.ok(enviados[0].signal);
    assert.equal(enviados[0].mensaje.cuerpo, 'OT #5, equipo EXC-04');
    const texto = JSON.stringify(enviados[0].mensaje);
    assert.ok(!texto.includes('texto interno') && !texto.includes('1-9'));
});

test('enviarPush: sin FCM_CUENTA_SERVICIO espera 1 h sin llamar a la red', async () => {
    const f = falsearPool(() => ({ rows: [{ token: 'tok-del-dispositivo-31' }] }));
    const previo = process.env.FCM_CUENTA_SERVICIO;
    delete process.env.FCM_CUENTA_SERVICIO;
    try {
        await assert.rejects(enviarPush(notificacion(), undefined, {
            enviarFcm: async () => { throw new Error('no debia llamar a FCM'); },
        }), (e) => e.reintentarEnSegundos === 3600);
    } finally {
        if (previo !== undefined) process.env.FCM_CUENTA_SERVICIO = previo;
        f.restaurar();
    }
});

/** Responde las consultas de sigueVigente para un push sano y deja que el resto devuelva vacio. */
function respuestaSana(sql) {
    if (/FROM notificaciones_pendientes WHERE id/.test(sql)) {
        return { rows: [{ estado: 'pendiente', canal: 'push', destinatario: '31', created_at: new Date(ahora - 60000), payload: notificacion().payload }] };
    }
    if (/FROM dispositivos_push d/.test(sql)) {
        return { rows: [{ activo: true, app: 'terreno', rol: 'mecanico', cliente_id: null, usuario_id: 4, sesion_id: null, estado_cuenta: 'activo', sesion_revocada_at: null, sesion_expira_at: null }] };
    }
    return { rows: [], rowCount: 1 };
}

test('procesarUna: un token descartado apaga el dispositivo y cancela el aviso sin gastar intentos', async () => {
    const f = falsearPool(respuestaSana);
    usarEnvio(async () => { throw Object.assign(new Error('FCM respondio 404 (UNREGISTERED)'), { descartar: true }); });
    try {
        await procesarUna(notificacion());
    } finally { f.restaurar(); }
    const apagado = f.llamadas.find((l) => /UPDATE dispositivos_push SET activo = false/.test(l.sql));
    assert.ok(apagado, 'apaga el dispositivo');
    assert.deepEqual(apagado.params, [31]);
    const cancelado = f.llamadas.find((l) => /SET estado = 'cancelado'/.test(l.sql));
    assert.ok(cancelado, 'cancela el aviso');
    assert.equal(cancelado.params[0], 90);
    assert.ok(!f.llamadas.some((l) => /intentos = \$1/.test(l.sql)), 'no pasa por el reintento');
});

test('procesarUna: un 429 reprograma sin sumar intento', async () => {
    const f = falsearPool(respuestaSana);
    usarEnvio(async () => { throw Object.assign(new Error('FCM respondio 429'), { reintentarEnSegundos: 90 }); });
    try {
        await procesarUna(notificacion({ intentos: 2 }));
    } finally { f.restaurar(); }
    const reintento = f.llamadas.find((l) => /intentos = \$1/.test(l.sql));
    assert.ok(reintento);
    assert.deepEqual([reintento.params[0], reintento.params[2], reintento.params[3]], [2, 'pendiente', 90]);
});

test('procesarUna: un dispositivo desactivado cancela el aviso sin enviar', async () => {
    const f = falsearPool((sql) => {
        if (/FROM dispositivos_push d/.test(sql)) {
            return { rows: [{ activo: false, usuario_id: 4, sesion_id: null, estado_cuenta: 'activo' }] };
        }
        return respuestaSana(sql);
    });
    let llamado = false;
    usarEnvio(async () => { llamado = true; });
    try {
        await procesarUna(notificacion());
    } finally { f.restaurar(); }
    assert.equal(llamado, false);
    assert.ok(f.llamadas.some((l) => /SET estado = 'cancelado'/.test(l.sql)));
});

test('procesarUna: ot_disponible con la OT ya tomada se cancela', async () => {
    const payload = { tipo: 'ot_disponible', orden_trabajo_id: 5, usuario_id: 4 };
    const f = falsearPool((sql) => {
        if (/FROM notificaciones_pendientes WHERE id/.test(sql)) {
            return { rows: [{ estado: 'pendiente', canal: 'push', destinatario: '31', created_at: new Date(ahora - 1000), payload }] };
        }
        if (/FROM ordenes_trabajo ot/.test(sql)) return { rows: [] };
        return respuestaSana(sql);
    });
    let llamado = false;
    usarEnvio(async () => { llamado = true; });
    try {
        await procesarUna(notificacion({ payload }));
    } finally { f.restaurar(); }
    assert.equal(llamado, false);
    const cancelado = f.llamadas.find((l) => /SET estado = 'cancelado'/.test(l.sql));
    assert.match(cancelado.params[1], /tomada/);
});

test('procesarUna: un push sano se envia y queda enviado', async () => {
    const f = falsearPool(respuestaSana);
    let llamado = false;
    usarEnvio(async () => { llamado = true; });
    try {
        await procesarUna(notificacion());
    } finally { f.restaurar(); }
    assert.equal(llamado, true);
    assert.ok(f.llamadas.some((l) => /SET estado = 'enviado'/.test(l.sql)));
});
