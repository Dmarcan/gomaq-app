// Historial de eventos de la OT (utils/eventosOt.js): las reglas puras y el INSERT con un cliente falso.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
    TIPOS_EVENTO, ORIGENES_EVENTO, esTipoValido, esHoraDudosa, leerUuidTarea, construirEvento,
    registrarEvento, dejarEvento, sincronizadoTarde, decidirEventoDiagnostico, decidirEventoAsignacion,
    TOLERANCIA_FUTURO_MS,
} = require('../src/utils/eventosOt');

const AHORA = new Date('2026-11-03T12:00:00Z');
const CREADA = '2026-11-03T08:00:00Z';

describe('esTipoValido', () => {
    test('acepta los diez tipos del historial y nada mas', () => {
        assert.equal(TIPOS_EVENTO.length, 10);
        for (const tipo of TIPOS_EVENTO) assert.equal(esTipoValido(tipo), true, tipo);
        assert.equal(esTipoValido('inventado'), false);
        assert.equal(esTipoValido(undefined), false);
        assert.equal(esTipoValido(''), false);
    });
});

describe('esHoraDudosa', () => {
    test('una hora entre la creacion y ahora no es dudosa', () => {
        assert.equal(esHoraDudosa('2026-11-03T10:00:00Z', CREADA, AHORA), false);
    });

    test('en el futuro es dudosa, con 2 minutos de margen para el reloj adelantado', () => {
        assert.equal(TOLERANCIA_FUTURO_MS, 120000);
        assert.equal(esHoraDudosa('2026-11-03T12:01:59Z', CREADA, AHORA), false);
        assert.equal(esHoraDudosa('2026-11-03T12:02:00Z', CREADA, AHORA), false);
        assert.equal(esHoraDudosa('2026-11-03T12:02:01Z', CREADA, AHORA), true);
        assert.equal(esHoraDudosa('2027-01-01T00:00:00Z', CREADA, AHORA), true);
    });

    test('una OT nacida por sincronizacion no se compara con su fecha de creacion, pero el futuro si cuenta', () => {
        const opciones = { nacioPorSincronizacion: true };
        assert.equal(esHoraDudosa('2026-11-03T07:00:00Z', CREADA, AHORA, opciones), false);
        assert.equal(esHoraDudosa('2026-11-03T07:00:00Z', CREADA, AHORA), true);
        assert.equal(esHoraDudosa('2026-11-04T00:00:00Z', CREADA, AHORA, opciones), true);
    });

    test('antes de crear la OT es dudosa', () => {
        assert.equal(esHoraDudosa('2026-11-03T07:59:59Z', CREADA, AHORA), true);
    });

    test('justo en la creacion o en este instante no es dudosa', () => {
        assert.equal(esHoraDudosa(CREADA, CREADA, AHORA), false);
        assert.equal(esHoraDudosa(AHORA, CREADA, AHORA), false);
    });

    test('sin hora no hay nada que dudar, y sin fecha de creacion solo cuenta el futuro', () => {
        assert.equal(esHoraDudosa(null, CREADA, AHORA), false);
        assert.equal(esHoraDudosa('no es fecha', CREADA, AHORA), false);
        assert.equal(esHoraDudosa('2020-01-01T00:00:00Z', null, AHORA), false);
    });

    test('acepta objetos Date', () => {
        assert.equal(esHoraDudosa(new Date('2026-11-04T00:00:00Z'), new Date(CREADA), AHORA), true);
    });
});

describe('leerUuidTarea', () => {
    test('devuelve el uuid en minusculas, o null si no es un uuid', () => {
        assert.equal(leerUuidTarea('3F2504E0-4F89-41D3-9A0C-0305E82C3301'), '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
        assert.equal(leerUuidTarea('no-es-un-uuid'), null);
        assert.equal(leerUuidTarea(''), null);
        assert.equal(leerUuidTarea(undefined), null);
        assert.equal(leerUuidTarea(42), null);
    });
});

describe('construirEvento', () => {
    test('arma el evento con los valores por omision', () => {
        const e = construirEvento({ ordenId: '7', tipo: 'creacion', origen: 'panel' });
        assert.deepEqual(e, {
            ordenId: 7, tipo: 'creacion', estadoAnterior: null, estadoNuevo: null, usuarioId: null, rol: null,
            ocurrioEn: null, origen: 'panel', uuidCliente: null, aplicado: true, horaDudosa: false, detalle: null,
        });
    });

    test('toma el usuario y el rol de req.user', () => {
        const e = construirEvento({ ordenId: 1, tipo: 'toma', origen: 'terreno', usuario: { id: 5, rol: 'mecanico', cliente_id: null } });
        assert.equal(e.usuarioId, 5);
        assert.equal(e.rol, 'mecanico');
    });

    test('normaliza la hora a ISO y calcula la hora dudosa', () => {
        const dudosa = construirEvento({
            ordenId: 1, tipo: 'cambio_estado', origen: 'terreno', ocurrioEn: '2026-11-04T00:00:00Z', creadaEn: CREADA, ahora: AHORA,
        });
        assert.equal(dudosa.ocurrioEn, '2026-11-04T00:00:00.000Z');
        assert.equal(dudosa.horaDudosa, true);
        const normal = construirEvento({
            ordenId: 1, tipo: 'cambio_estado', origen: 'terreno', ocurrioEn: '2026-11-03T10:00:00Z', creadaEn: CREADA, ahora: AHORA,
        });
        assert.equal(normal.horaDudosa, false);
    });

    test('una hora que no es fecha se descarta (usa la del servidor)', () => {
        const e = construirEvento({ ordenId: 1, tipo: 'cierre', origen: 'terreno', ocurrioEn: 'ayer' });
        assert.equal(e.ocurrioEn, null);
        assert.equal(e.horaDudosa, false);
    });

    test('aplicado solo es false cuando se pide expresamente', () => {
        assert.equal(construirEvento({ ordenId: 1, tipo: 'cambio_estado', origen: 'terreno', aplicado: false }).aplicado, false);
        assert.equal(construirEvento({ ordenId: 1, tipo: 'cambio_estado', origen: 'terreno', aplicado: undefined }).aplicado, true);
    });

    test('rechaza un tipo, un origen o una orden invalidos', () => {
        assert.throws(() => construirEvento({ ordenId: 1, tipo: 'inventado', origen: 'panel' }), /Tipo de evento/);
        assert.throws(() => construirEvento({ ordenId: 1, tipo: 'cierre', origen: 'otro' }), /Origen de evento/);
        assert.throws(() => construirEvento({ ordenId: 0, tipo: 'cierre', origen: 'panel' }), /orden/);
        assert.throws(() => construirEvento({ ordenId: 'abc', tipo: 'cierre', origen: 'panel' }), /orden/);
        for (const origen of ORIGENES_EVENTO) assert.doesNotThrow(() => construirEvento({ ordenId: 1, tipo: 'cierre', origen }));
    });
});

/** Cliente falso que registra las consultas y responde como Postgres con ON CONFLICT. */
function clienteFalso(filas) {
    const consultas = [];
    return {
        consultas,
        async query(sql, params) {
            consultas.push({ sql, params });
            return { rows: filas };
        },
    };
}

describe('registrarEvento', () => {
    test('inserta con ON CONFLICT DO NOTHING y dice si inserto', async () => {
        const evento = construirEvento({
            ordenId: 3, tipo: 'cambio_estado', origen: 'terreno', estadoAnterior: 'asignada', estadoNuevo: 'aceptada',
            usuario: { id: 9, rol: 'mecanico' }, uuidCliente: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', detalle: { a: 1 },
        });
        const nuevo = clienteFalso([{ id: 11 }]);
        assert.equal(await registrarEvento(nuevo, evento), true);
        assert.match(nuevo.consultas[0].sql, /ON CONFLICT DO NOTHING/);
        assert.deepEqual(nuevo.consultas[0].params.slice(0, 6), [3, 'cambio_estado', 'asignada', 'aceptada', 9, 'mecanico']);
        assert.equal(nuevo.consultas[0].params[11], '{"a":1}');

        const repetido = clienteFalso([]);
        assert.equal(await registrarEvento(repetido, evento), false, 'el reintento no inserta pero tampoco falla');
    });

    test('dejarEvento construye y registra con un solo cliente', async () => {
        const cliente = clienteFalso([{ id: 1 }]);
        assert.equal(await dejarEvento(cliente, { ordenId: 2, tipo: 'valorizacion', origen: 'panel' }), true);
        assert.equal(cliente.consultas.length, 1);
        assert.equal(cliente.consultas[0].params[11], null, 'sin detalle se guarda NULL');
    });
});

describe('sincronizadoTarde', () => {
    test('marca los eventos registrados mas de 10 minutos despues de ocurrir', () => {
        assert.equal(sincronizadoTarde('2026-11-03T10:00:00Z', '2026-11-03T10:10:00Z'), false);
        assert.equal(sincronizadoTarde('2026-11-03T10:00:00Z', '2026-11-03T10:10:01Z'), true);
        assert.equal(sincronizadoTarde('2026-11-03T10:00:00Z', '2026-11-03T10:00:00Z'), false);
    });

    test('un evento con hora futura (registrado antes de ocurrir) no es tarde', () => {
        assert.equal(sincronizadoTarde('2026-11-04T10:00:00Z', '2026-11-03T10:00:00Z'), false);
    });

    test('sin fechas validas no es tarde', () => {
        assert.equal(sincronizadoTarde(null, '2026-11-03T10:00:00Z'), false);
        assert.equal(sincronizadoTarde('x', 'y'), false);
    });
});

describe('decidirEventoDiagnostico', () => {
    const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

    test('un cambio aplicado se registra como aplicado', () => {
        assert.deepEqual(
            decidirEventoDiagnostico({ cambio: 'cambiar', estadoActual: 'asignada', estadoPedido: 'aceptada', uuid: null }),
            { registrar: true, aplicado: true }
        );
    });

    test('un cambio atrasado se registra con aplicado = false', () => {
        assert.deepEqual(
            decidirEventoDiagnostico({ cambio: 'sin_cambio', estadoActual: 'en_terreno', estadoPedido: 'aceptada', uuid: null }),
            { registrar: true, aplicado: false }
        );
    });

    test('sin uuid, repetir el mismo estado no se registra; con uuid si (el ON CONFLICT evita el duplicado)', () => {
        assert.equal(decidirEventoDiagnostico({ cambio: 'sin_cambio', estadoActual: 'aceptada', estadoPedido: 'aceptada' }).registrar, false);
        assert.equal(decidirEventoDiagnostico({ cambio: 'sin_cambio', estadoActual: 'aceptada', estadoPedido: 'aceptada', uuid: UUID }).registrar, true);
    });

    test('sin estado pedido, o con un resultado que no es cambio, no se registra', () => {
        assert.equal(decidirEventoDiagnostico({ cambio: 'sin_cambio', estadoActual: 'asignada', estadoPedido: null }).registrar, false);
        assert.equal(decidirEventoDiagnostico({ cambio: 'cambiar', estadoActual: 'asignada', estadoPedido: undefined }).registrar, false);
        assert.equal(decidirEventoDiagnostico({ cambio: 'rechazar', estadoActual: 'finalizada', estadoPedido: 'en_terreno' }).registrar, false);
    });
});

describe('decidirEventoAsignacion', () => {
    test('asignar por primera vez no es reasignacion', () => {
        assert.deepEqual(
            decidirEventoAsignacion({ estadoActual: 'pendiente', estadoNuevo: 'asignada', mecanicoAnteriorId: null, mecanicoNuevoId: 5 }),
            { registrar: true, reasignacion: false, reinicioViaje: false }
        );
    });

    test('cambiar de tecnico es reasignacion; si estaba en viaje se reinicia el viaje', () => {
        assert.deepEqual(
            decidirEventoAsignacion({ estadoActual: 'en_camino', estadoNuevo: 'asignada', mecanicoAnteriorId: 4, mecanicoNuevoId: '5' }),
            { registrar: true, reasignacion: true, reinicioViaje: true }
        );
        assert.equal(decidirEventoAsignacion({ estadoActual: 'en_terreno', estadoNuevo: 'en_terreno', mecanicoAnteriorId: 4, mecanicoNuevoId: 5 }).reinicioViaje, false);
    });

    test('el mismo tecnico en el mismo estado (doble clic) no deja evento', () => {
        assert.equal(decidirEventoAsignacion({ estadoActual: 'aceptada', estadoNuevo: 'aceptada', mecanicoAnteriorId: 5, mecanicoNuevoId: '5' }).registrar, false);
    });

    test('el mismo tecnico pero con cambio de estado si se registra, sin ser reasignacion', () => {
        assert.deepEqual(
            decidirEventoAsignacion({ estadoActual: 'pendiente', estadoNuevo: 'asignada', mecanicoAnteriorId: 5, mecanicoNuevoId: 5 }),
            { registrar: true, reasignacion: false, reinicioViaje: false }
        );
    });
});
