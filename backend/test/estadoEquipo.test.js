const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
    validarEstadoEquipoCierre, estadoTrasEntrada, estadoTrasCierre, origenPorEjecutivo,
} = require('../src/utils/estadoEquipo');

describe('validarEstadoEquipoCierre', () => {
    test('ausente es valido (APK antiguo) y devuelve null', () => {
        for (const v of [undefined, null, '']) assert.deepEqual(validarEstadoEquipoCierre(v), { valido: true, estado: null });
    });

    test('operativa y fuera_de_servicio son validos', () => {
        assert.deepEqual(validarEstadoEquipoCierre('operativa'), { valido: true, estado: 'operativa' });
        assert.deepEqual(validarEstadoEquipoCierre('fuera_de_servicio'), { valido: true, estado: 'fuera_de_servicio' });
    });

    test('cualquier otro valor se rechaza', () => {
        for (const v of ['en_mantencion', 'OPERATIVA', 'x', 1, true, {}, []]) {
            assert.equal(validarEstadoEquipoCierre(v).valido, false, JSON.stringify(v));
        }
    });
});

describe('estadoTrasEntrada', () => {
    test('un equipo operativo pasa a en_mantencion por la orden', () => {
        assert.deepEqual(estadoTrasEntrada({ estadoEquipo: 'operativa' }), { estado: 'en_mantencion', origen: 'ot' });
    });

    test('en_mantencion y fuera_de_servicio no se tocan', () => {
        assert.equal(estadoTrasEntrada({ estadoEquipo: 'en_mantencion' }), null);
        assert.equal(estadoTrasEntrada({ estadoEquipo: 'fuera_de_servicio' }), null);
    });
});

describe('estadoTrasCierre: con estado pedido por el mecanico', () => {
    const base = { otrasAbiertas: 0, estadoEquipo: 'en_mantencion', origenEstado: 'ot' };

    test('fuera_de_servicio se aplica siempre, aunque haya otras ordenes o el panel haya fijado otro estado', () => {
        for (const extra of [{}, { otrasAbiertas: 2 }, { origenEstado: 'panel' }, { origenEstado: null }, { estadoEquipo: 'operativa' }]) {
            assert.deepEqual(estadoTrasCierre({ ...base, ...extra, pedido: 'fuera_de_servicio' }), { estado: 'fuera_de_servicio', origen: 'mecanico' });
        }
    });

    test('operativa sin otras ordenes abiertas y origen ot o mecanico deja el equipo operativo', () => {
        assert.deepEqual(estadoTrasCierre({ ...base, pedido: 'operativa' }), { estado: 'operativa', origen: 'mecanico' });
        assert.deepEqual(estadoTrasCierre({ ...base, pedido: 'operativa', origenEstado: 'mecanico', estadoEquipo: 'fuera_de_servicio' }),
            { estado: 'operativa', origen: 'mecanico' });
    });

    test('operativa con otras ordenes abiertas no cambia nada', () => {
        assert.equal(estadoTrasCierre({ ...base, pedido: 'operativa', otrasAbiertas: 1 }), null);
    });

    test('operativa no levanta un estado puesto a mano desde el panel (ni uno de antes de la migracion)', () => {
        assert.equal(estadoTrasCierre({ ...base, pedido: 'operativa', origenEstado: 'panel' }), null);
        assert.equal(estadoTrasCierre({ ...base, pedido: 'operativa', origenEstado: null }), null);
    });

    test('operativa sobre un equipo ya operativo no cambia nada', () => {
        assert.equal(estadoTrasCierre({ ...base, pedido: 'operativa', estadoEquipo: 'operativa' }), null);
    });
});

describe('estadoTrasCierre: sin estado pedido (APK antiguo)', () => {
    test('vuelve a operativa solo si estaba en mantencion por la orden y no quedan otras', () => {
        assert.deepEqual(
            estadoTrasCierre({ pedido: null, otrasAbiertas: 0, estadoEquipo: 'en_mantencion', origenEstado: 'ot' }),
            { estado: 'operativa', origen: 'ot' });
    });

    test('no cambia con otras ordenes abiertas', () => {
        assert.equal(estadoTrasCierre({ pedido: null, otrasAbiertas: 1, estadoEquipo: 'en_mantencion', origenEstado: 'ot' }), null);
    });

    test('nunca pisa un fuera_de_servicio del panel ni un en_mantencion del panel', () => {
        assert.equal(estadoTrasCierre({ pedido: null, otrasAbiertas: 0, estadoEquipo: 'fuera_de_servicio', origenEstado: 'panel' }), null);
        assert.equal(estadoTrasCierre({ pedido: null, otrasAbiertas: 0, estadoEquipo: 'en_mantencion', origenEstado: 'panel' }), null);
        assert.equal(estadoTrasCierre({ pedido: null, otrasAbiertas: 0, estadoEquipo: 'en_mantencion', origenEstado: null }), null);
    });

    test('un fuera_de_servicio que dejo el mecanico tampoco lo levanta un cierre sin estado', () => {
        assert.equal(estadoTrasCierre({ pedido: null, otrasAbiertas: 0, estadoEquipo: 'fuera_de_servicio', origenEstado: 'mecanico' }), null);
    });

    test('un equipo operativo no cambia', () => {
        assert.equal(estadoTrasCierre({ pedido: null, otrasAbiertas: 0, estadoEquipo: 'operativa', origenEstado: 'ot' }), null);
    });
});

describe('origenPorEjecutivo', () => {
    test('con ejecutivo es externo; sin ejecutivo o sin cliente, directo', () => {
        assert.equal(origenPorEjecutivo(3), 'externo');
        assert.equal(origenPorEjecutivo(0), 'externo');
        assert.equal(origenPorEjecutivo(null), 'directo');
        assert.equal(origenPorEjecutivo(undefined), 'directo');
    });
});
