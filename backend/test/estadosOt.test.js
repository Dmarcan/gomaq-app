// Ciclo de vida de la Orden de Trabajo (utils/estadosOt.js).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
    estadoTrasAsignar, mecanicoPuedeEditar, puedeCambiarEstadoA, evaluarCambioEstado, evaluarCierre,
} = require('../src/utils/estadosOt');

describe('estadoTrasAsignar', () => {
    test('una OT nueva o ya asignada queda asignada', () => {
        assert.equal(estadoTrasAsignar('pendiente'), 'asignada');
        assert.equal(estadoTrasAsignar('asignada'), 'asignada');
    });

    test('reasignar una OT que solo estaba aceptada o en camino la deja asignada al nuevo tecnico', () => {
        assert.equal(estadoTrasAsignar('aceptada'), 'asignada');
        assert.equal(estadoTrasAsignar('en_camino'), 'asignada');
    });

    test('reasignar una OT en curso cambia el tecnico sin hacerla retroceder', () => {
        assert.equal(estadoTrasAsignar('en_terreno'), 'en_terreno');
        assert.equal(estadoTrasAsignar('en_reparacion'), 'en_reparacion');
    });

    test('una OT finalizada no se reasigna', () => {
        assert.equal(estadoTrasAsignar('finalizada'), null);
    });
});

describe('mecanicoPuedeEditar', () => {
    test('solo mientras la OT no este cerrada', () => {
        for (const estado of ['asignada', 'aceptada', 'en_camino', 'en_terreno', 'en_reparacion']) {
            assert.equal(mecanicoPuedeEditar(estado), true, estado);
        }
        assert.equal(mecanicoPuedeEditar('finalizada'), false);
    });
});

describe('puedeCambiarEstadoA', () => {
    test('el mecanico inicia y alterna entre terreno y reparacion', () => {
        assert.equal(puedeCambiarEstadoA('asignada', 'en_terreno'), true);
        assert.equal(puedeCambiarEstadoA('en_terreno', 'en_reparacion'), true);
        assert.equal(puedeCambiarEstadoA('en_reparacion', 'en_terreno'), true);
    });

    test('no reabre una OT finalizada ni la mueve a estados que no le tocan', () => {
        assert.equal(puedeCambiarEstadoA('finalizada', 'en_terreno'), false);
        assert.equal(puedeCambiarEstadoA('en_terreno', 'finalizada'), false, 'cerrar es /finalizar, con firma');
        assert.equal(puedeCambiarEstadoA('en_terreno', 'asignada'), false);
    });
});

describe('evaluarCambioEstado (el viaje del mecanico)', () => {
    test('el viaje avanza en orden: aceptar, salir, llegar', () => {
        assert.equal(evaluarCambioEstado('asignada', 'aceptada'), 'cambiar');
        assert.equal(evaluarCambioEstado('aceptada', 'en_camino'), 'cambiar');
        assert.equal(evaluarCambioEstado('en_camino', 'en_terreno'), 'cambiar');
    });

    test('se puede saltar pasos: salir sin aceptar, o llegar directo (APK anterior)', () => {
        assert.equal(evaluarCambioEstado('asignada', 'en_camino'), 'cambiar');
        assert.equal(evaluarCambioEstado('asignada', 'en_terreno'), 'cambiar');
        assert.equal(evaluarCambioEstado('aceptada', 'en_terreno'), 'cambiar');
    });

    test('un reintento o un cambio atrasado no hace nada y no falla', () => {
        assert.equal(evaluarCambioEstado('aceptada', 'aceptada'), 'sin_cambio');
        assert.equal(evaluarCambioEstado('en_camino', 'aceptada'), 'sin_cambio');
        assert.equal(evaluarCambioEstado('en_terreno', 'en_camino'), 'sin_cambio');
        assert.equal(evaluarCambioEstado('en_terreno', 'en_terreno'), 'sin_cambio');
    });

    test('no se pueden fijar estados que no le tocan al mecanico ni mover una OT sin mecanico o cerrada', () => {
        assert.equal(evaluarCambioEstado('pendiente', 'aceptada'), 'rechazar');
        assert.equal(evaluarCambioEstado('finalizada', 'en_camino'), 'rechazar');
        assert.equal(evaluarCambioEstado('asignada', 'pendiente'), 'rechazar');
        assert.equal(evaluarCambioEstado('en_terreno', 'finalizada'), 'rechazar');
    });
});

describe('evaluarCierre', () => {
    test('una OT en curso o asignada se puede cerrar', () => {
        assert.deepEqual(evaluarCierre('en_reparacion'), { permitido: true, yaFinalizada: false });
        assert.deepEqual(evaluarCierre('asignada'), { permitido: true, yaFinalizada: false });
    });

    test('cerrar una ya cerrada es un reintento: se acepta sin volver a cerrar', () => {
        assert.deepEqual(evaluarCierre('finalizada'), { permitido: true, yaFinalizada: true });
    });

    test('una OT sin mecanico asignado no se cierra', () => {
        assert.equal(evaluarCierre('pendiente').permitido, false);
    });
});
