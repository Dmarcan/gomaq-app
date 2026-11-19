// Canal push de los avisos: solo con PUSH_HABILITADO=1 y solo para los tipos de OT. Sin base de datos:
// el client de la transaccion se reemplaza por uno falso. Los avisos con proveedor de correo y el porton en
// general se prueban en avisosPorton.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    tieneProveedor, encolarNotificacion, encolarAMecanico, avisarOtDisponible, avisarAsignacion, TIPOS_AVISO, TIPOS_INTERNOS,
    encolarAGerentes, encolarAOficina, encolarAClientes, avisarPorValorizar, avisarFacturaAnulada, avisarAsistenciaNueva, avisarAlCliente,
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

test('con PUSH_HABILITADO=1 tienen push los tipos de mecanico, gerencia, oficina y cliente, y el resto no cambia', async () => {
    await conFlag('1', () => {
        for (const tipo of ['ot_asignada', 'ot_reasignada', 'ot_disponible', 'ot_por_valorizar', 'factura_anulada', 'ajuste_inventario',
            'asistencia_nueva', 'mantencion_proxima', 'mecanico_asignado', 'ot_finalizada']) {
            assert.equal(tieneProveedor('push', tipo), true, tipo);
        }
        for (const tipo of ['factura_emitida', 'cuenta_aprobada', undefined]) {
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
        assert.equal(await encolarAMecanico(otro, 5, { tipo: 'ot_por_valorizar' }), 0, 'un tipo de oficina no va al mecanico');
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

// ----- gerencia, oficina y cliente -----

/** Cliente falso que distingue la consulta de dispositivos de la de datos de la OT. */
function clienteOficina(dispositivos, orden = { orden_trabajo_id: 12, motivo: 'texto libre', maquinaria_codigo: 'EXC-04' }) {
    const llamadas = [];
    return {
        llamadas,
        inserts: () => llamadas.filter((l) => /INSERT INTO notificaciones_pendientes/.test(l.sql)),
        dispositivos: () => llamadas.filter((l) => /FROM dispositivos_push/.test(l.sql)),
        query: async (sql, params) => {
            llamadas.push({ sql, params });
            if (/FROM dispositivos_push/.test(sql)) return { rows: dispositivos };
            if (/FROM ordenes_trabajo/.test(sql)) return { rows: [orden] };
            return { rows: [] };
        },
    };
}
const payloadsDe = (c) => c.inserts().map((f) => JSON.parse(f.params[2]));

test('gerencia y oficina con flag apagado: no consultan ni encolan', async () => {
    const c = clienteOficina([{ id: '1', usuario_id: 2 }]);
    await conFlag(undefined, async () => {
        assert.equal(await encolarAGerentes(c, { tipo: 'factura_anulada', folio: 'F-1' }), 0);
        assert.equal(await encolarAOficina(c, { tipo: 'ot_por_valorizar', orden_trabajo_id: 12 }), 0);
        assert.equal(await avisarAsistenciaNueva(c, 12), 0);
        assert.equal(await avisarAlCliente(c, { tipo: 'ot_finalizada', ordenId: 12, clienteId: 8 }), 0);
    });
    assert.equal(c.llamadas.length, 0);
});

test('encolarAGerentes: una fila push por dispositivo del panel de gerentes activos, sin correo ni WhatsApp', async () => {
    const c = clienteOficina([{ id: '5', usuario_id: 2 }, { id: '6', usuario_id: 2 }, { id: '9', usuario_id: 3 }]);
    const n = await conFlag('1', () => encolarAGerentes(c, { tipo: 'factura_anulada', folio: 'F-1' }, { excluirUsuarioId: 4 }));
    assert.equal(n, 3);
    assert.deepEqual(c.inserts().map((f) => [f.params[0], f.params[1]]), [['push', '5'], ['push', '6'], ['push', '9']]);
    assert.deepEqual(payloadsDe(c).map((x) => x.usuario_id), [2, 2, 3]);
    const consulta = c.dispositivos()[0];
    assert.match(consulta.sql, /d\.activo/);
    assert.match(consulta.sql, /d\.app = \$1/);
    assert.match(consulta.sql, /u\.estado_cuenta = 'activo'/);
    assert.match(consulta.sql, /u\.id <> \$3::int/, 'excluye a quien ejecuta');
    // factura anulada: app panel y solo gerente; quien ejecuta (4) se excluye
    assert.deepEqual(consulta.params, ['panel', ['gerente'], 4, null, false]);
});

test('encolarAOficina: ot_por_valorizar llega a gerentes y administrativos; factura anulada solo al gerente', async () => {
    const c = clienteOficina([{ id: '5', usuario_id: 2 }]);
    await conFlag('1', async () => {
        await encolarAOficina(c, { tipo: 'ot_por_valorizar', orden_trabajo_id: 12 });
        await encolarAOficina(c, { tipo: 'asistencia_nueva', orden_trabajo_id: 12 });
        await encolarAOficina(c, { tipo: 'factura_anulada', folio: 'F-1' });
    });
    const roles = c.dispositivos().map((l) => l.params[1]);
    assert.deepEqual(roles, [['gerente', 'administrativo'], ['gerente', 'administrativo'], ['gerente']]);
    assert.ok(c.dispositivos().every((l) => l.params[0] === 'panel'), 'siempre la app panel: terreno no recibe avisos de oficina');
});

test('un dispositivo que sale dos veces se encola una sola vez', async () => {
    const c = clienteOficina([{ id: '5', usuario_id: 2 }, { id: '5', usuario_id: 2 }]);
    assert.equal(await conFlag('1', () => encolarAOficina(c, { tipo: 'ot_por_valorizar', orden_trabajo_id: 12 })), 1);
});

test('sin dispositivos no se encola nada', async () => {
    const c = clienteOficina([]);
    assert.equal(await conFlag('1', () => encolarAOficina(c, { tipo: 'ot_por_valorizar', orden_trabajo_id: 12 })), 0);
    assert.equal(c.inserts().length, 0);
});

test('un tipo de mecanico o sin push no se manda a la oficina', async () => {
    const c = clienteOficina([{ id: '5', usuario_id: 2 }]);
    await conFlag('1', async () => {
        assert.equal(await encolarAOficina(c, { tipo: 'ot_asignada', orden_trabajo_id: 12 }), 0, 'ese tipo es de terreno');
        assert.equal(await encolarAGerentes(c, { tipo: 'cuenta_aprobada' }), 0);
        assert.equal(await encolarAGerentes(c, null), 0);
    });
    assert.equal(c.llamadas.length, 0);
});

test('avisarPorValorizar y avisarFacturaAnulada usan el destino de cada tipo y excluyen a quien ejecuta', async () => {
    const c = clienteOficina([{ id: '5', usuario_id: 2 }]);
    await conFlag('1', async () => {
        await avisarPorValorizar(c, 12, 'Orden finalizada', { excluirUsuarioId: 4 });
        await avisarFacturaAnulada(c, { factura: { orden_trabajo_id: 12, folio: 'F-1' }, excluirUsuarioId: 4 });
    });
    assert.deepEqual(c.dispositivos().map((l) => l.params), [
        ['panel', ['gerente', 'administrativo'], 4, null, false],
        ['panel', ['gerente'], 4, null, false],
    ]);
    // la factura anulada no lleva monto ni motivo
    assert.deepEqual(Object.keys(payloadsDe(c)[1]).sort(), ['folio', 'orden_trabajo_id', 'tipo', 'usuario_id']);
});

test('avisarAsistenciaNueva: OT y equipo a la oficina, sin el texto libre de la solicitud', async () => {
    const c = clienteOficina([{ id: '5', usuario_id: 2 }, { id: '7', usuario_id: 3 }]);
    const n = await conFlag('1', () => avisarAsistenciaNueva(c, 12));
    assert.equal(n, 2);
    assert.deepEqual(c.dispositivos()[0].params, ['panel', ['gerente', 'administrativo'], null, null, false]);
    const [primero] = payloadsDe(c);
    assert.deepEqual(primero, { tipo: 'asistencia_nueva', orden_trabajo_id: 12, maquinaria_codigo: 'EXC-04', usuario_id: 2 });
    assert.ok(!JSON.stringify(primero).includes('texto libre'));
    assert.ok(TIPOS_INTERNOS.includes('asistencia_nueva'));
    assert.equal(TIPOS_AVISO.ASISTENCIA_NUEVA, 'asistencia_nueva');
});

test('encolarAClientes: solo usuarios cliente de la empresa pedida, de la app panel', async () => {
    const c = clienteOficina([{ id: '8', usuario_id: 31 }]);
    const n = await conFlag('1', () => encolarAClientes(c, 8, { tipo: 'ot_finalizada', orden_trabajo_id: 12 }));
    assert.equal(n, 1);
    const consulta = c.dispositivos()[0];
    assert.deepEqual(consulta.params, ['panel', ['cliente'], null, 8, false]);
    assert.match(consulta.sql, /u\.cliente_id = \$4::int/);
    // sin la empresa no se encola a nadie (nunca "todos los clientes")
    const sin = clienteOficina([{ id: '8', usuario_id: 31 }]);
    assert.equal(await conFlag('1', () => encolarAClientes(sin, null, { tipo: 'ot_finalizada', orden_trabajo_id: 12 })), 0);
    assert.equal(sin.llamadas.length, 0);
});

test('avisarAlCliente: payload minimo, sin datos del mecanico ni observacion final', async () => {
    const c = clienteOficina([{ id: '8', usuario_id: 31 }]);
    await conFlag('1', async () => {
        assert.equal(await avisarAlCliente(c, { tipo: 'mecanico_asignado', ordenId: 12, clienteId: 8 }), 1);
        assert.equal(await avisarAlCliente(c, { tipo: 'ot_finalizada', ordenId: 12, clienteId: null }), 0, 'sin empresa');
        assert.equal(await avisarAlCliente(c, { tipo: 'ot_por_valorizar', ordenId: 12, clienteId: 8 }), 0, 'ese tipo no es del cliente');
    });
    const [p] = payloadsDe(c);
    assert.deepEqual(p, { tipo: 'mecanico_asignado', orden_trabajo_id: 12, maquinaria_codigo: 'EXC-04', cliente_id: 8, usuario_id: 31 });
});
