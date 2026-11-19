// Canal push de los avisos: solo con PUSH_HABILITADO=1 y solo para los tipos de OT. Sin base de datos:
// el client de la transaccion se reemplaza por uno falso. Los avisos con proveedor de correo y el porton en
// general se prueban en avisosPorton.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    tieneProveedor, encolarNotificacion, encolarAMecanico, avisarOtDisponible, avisarAsignacion, TIPOS_AVISO, TIPOS_INTERNOS,
} = require('../src/utils/avisos');

/** Corre `fn` con PUSH_HABILITADO fijo y lo deja como estaba. */
async function conFlag(valor, fn) {
    const previo = process.env.PUSH_HABILITADO;
    if (valor === undefined) delete process.env.PUSH_HABILITADO; else process.env.PUSH_HABILITADO = valor;
    try {
        return await fn();
    } finally {
        if (previo === undefined) delete process.env.PUSH_HABILITADO; else process.env.PUSH_HABILITADO = previo;
    }
}

/** Cliente falso: devuelve `filas` a cada SELECT y anota los INSERT. */
function clienteConFilas(filas) {
    const llamadas = [];
    return {
        llamadas,
        inserts: () => llamadas.filter((l) => /INSERT INTO notificaciones_pendientes/.test(l.sql)),
        selects: () => llamadas.filter((l) => /^\s*SELECT/i.test(l.sql)),
        query: async (sql, params) => {
            llamadas.push({ sql, params });
            return { rows: /^\s*SELECT/i.test(sql) ? filas : [] };
        },
    };
}

test('sin PUSH_HABILITADO el canal push no tiene proveedor (ni con 0 ni con otro valor)', async () => {
    for (const valor of [undefined, '0', '', 'true', 'si']) {
        await conFlag(valor, () => {
            for (const tipo of ['ot_asignada', 'ot_reasignada', 'ot_disponible']) {
                assert.equal(tieneProveedor('push', tipo), false, `${tipo} con flag ${valor}`);
            }
        });
    }
});

test('con PUSH_HABILITADO=1 solo los tipos de OT tienen push y el resto no cambia', async () => {
    await conFlag('1', () => {
        for (const tipo of ['ot_asignada', 'ot_reasignada', 'ot_disponible']) assert.equal(tieneProveedor('push', tipo), true, tipo);
        for (const tipo of ['ot_por_valorizar', 'factura_anulada', 'ajuste_inventario', 'factura_emitida', 'mecanico_asignado', undefined]) {
            assert.equal(tieneProveedor('push', tipo), false, String(tipo));
        }
        assert.equal(tieneProveedor('whatsapp', 'ot_asignada'), false);
        assert.equal(tieneProveedor('email', 'ot_asignada'), false);
        assert.equal(tieneProveedor('email', 'factura_emitida'), true);
    });
    await conFlag(undefined, () => assert.equal(tieneProveedor('email', 'factura_emitida'), true));
});

test('ot_disponible es un aviso interno', () => {
    assert.equal(TIPOS_AVISO.OT_DISPONIBLE, 'ot_disponible');
    assert.ok(TIPOS_INTERNOS.includes('ot_disponible'));
});

test('encolarNotificacion inserta el push solo con el flag', async () => {
    const aviso = { canal: 'push', destinatario: '12', payload: { tipo: 'ot_asignada', orden_trabajo_id: 3 } };
    const sin = clienteConFilas([]);
    assert.equal(await conFlag(undefined, () => encolarNotificacion(sin, aviso)), 0);
    assert.equal(sin.llamadas.length, 0);
    const con = clienteConFilas([]);
    assert.equal(await conFlag('1', () => encolarNotificacion(con, aviso)), 1);
    assert.deepEqual(con.llamadas[0].params, ['push', '12', JSON.stringify(aviso.payload)]);
});

test('encolarAMecanico: flag apagado no consulta ni encola', async () => {
    const c = clienteConFilas([{ id: 1 }]);
    assert.equal(await conFlag(undefined, () => encolarAMecanico(c, 5, { tipo: 'ot_asignada', orden_trabajo_id: 3 })), 0);
    assert.equal(c.llamadas.length, 0);
});

test('encolarAMecanico: una fila push por dispositivo, con el id del dispositivo y el usuario en el payload', async () => {
    const c = clienteConFilas([{ id: '11' }, { id: '12' }]);
    const n = await conFlag('1', () => encolarAMecanico(c, 5, { tipo: 'ot_asignada', orden_trabajo_id: 3, maquinaria_codigo: 'EXC-04' }));
    assert.equal(n, 2);
    const filas = c.inserts();
    assert.deepEqual(filas.map((f) => [f.params[0], f.params[1]]), [['push', '11'], ['push', '12']]);
    assert.equal(JSON.parse(filas[0].params[2]).usuario_id, 5);
    // la consulta solo mira dispositivos activos de la app terreno de un mecanico activo
    assert.match(c.llamadas[0].sql, /d\.activo/);
    assert.match(c.llamadas[0].sql, /d\.app = 'terreno'/);
    assert.match(c.llamadas[0].sql, /u\.rol = 'mecanico'/);
    assert.match(c.llamadas[0].sql, /u\.estado_cuenta = 'activo'/);
});

test('encolarAMecanico: sin mecanico, sin dispositivos o con tipo sin push no encola', async () => {
    await conFlag('1', async () => {
        assert.equal(await encolarAMecanico(clienteConFilas([]), null, { tipo: 'ot_asignada' }), 0);
        const vacio = clienteConFilas([]);
        assert.equal(await encolarAMecanico(vacio, 5, { tipo: 'ot_asignada', orden_trabajo_id: 3 }), 0);
        assert.equal(vacio.inserts().length, 0);
        const otro = clienteConFilas([{ id: 1 }]);
        assert.equal(await encolarAMecanico(otro, 5, { tipo: 'ot_por_valorizar' }), 0);
        assert.equal(otro.llamadas.length, 0);
    });
});

test('avisarAsignacion con flag: avisa al nuevo y, si cambio el tecnico, al anterior', async () => {
    const c = clienteConFilas([{ id: '7', orden_trabajo_id: 3, motivo: null, maquinaria_codigo: 'EXC-04' }]);
    await conFlag('1', () => avisarAsignacion(c, { ordenId: 3, nuevoId: 5, anteriorId: 6 }));
    const tipos = c.inserts().map((f) => JSON.parse(f.params[2]).tipo);
    assert.deepEqual(tipos, ['ot_asignada', 'ot_reasignada']);
});

test('avisarAsignacion con flag apagado no encola nada', async () => {
    const c = clienteConFilas([{ id: '7' }]);
    await conFlag(undefined, () => avisarAsignacion(c, { ordenId: 3, nuevoId: 5, anteriorId: 6 }));
    assert.equal(c.inserts().length, 0);
});

test('avisarOtDisponible: flag apagado no hace nada', async () => {
    const c = clienteConFilas([{ id: '1', usuario_id: 5 }]);
    assert.equal(await conFlag(undefined, () => avisarOtDisponible(c, 3)), 0);
    assert.equal(c.llamadas.length, 0);
});

test('avisarOtDisponible: una consulta para todos los libres y una fila por dispositivo', async () => {
    const c = clienteConFilas([
        { id: '21', usuario_id: 5, orden_trabajo_id: 3, motivo: 'x', maquinaria_codigo: 'EXC-04' },
        { id: '22', usuario_id: 6 },
    ]);
    const n = await conFlag('1', () => avisarOtDisponible(c, 3));
    assert.equal(n, 2);
    const selects = c.selects();
    assert.equal(selects.length, 2, 'una por los datos de la OT y una por los mecanicos (sin N+1)');
    assert.match(selects[1].sql, /NOT EXISTS/);
    assert.match(selects[1].sql, /o\.mecanico_id = u\.id/);
    assert.deepEqual(selects[1].params, [['aceptada', 'en_camino', 'en_terreno', 'en_reparacion']]);
    const filas = c.inserts();
    assert.deepEqual(filas.map((f) => f.params[1]), ['21', '22']);
    assert.deepEqual(filas.map((f) => JSON.parse(f.params[2]).usuario_id), [5, 6]);
    assert.equal(JSON.parse(filas[0].params[2]).tipo, 'ot_disponible');
});
