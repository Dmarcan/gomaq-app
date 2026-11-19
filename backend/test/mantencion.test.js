const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    HORAS_AVISO_MANTENCION,
    calcularEstadoMantencion,
    requiereAviso,
} = require('../src/utils/mantencion');

const estado = (ultimaLectura, horometroUltimaMantencion = null, intervaloHoras = 350) =>
    calcularEstadoMantencion({ ultimaLectura, horometroUltimaMantencion, intervaloHoras });

describe('calcularEstadoMantencion', () => {
    test('sin lecturas no se puede calcular nada', () => {
        assert.deepStrictEqual(estado(null), {
            horas_usadas: null,
            horas_restantes: null,
            proxima_mantencion_en: null,
            por_vencer: false,
            vencida: false,
        });
    });

    test('equipo nuevo: cuenta desde cero', () => {
        const r = estado(120);
        assert.strictEqual(r.horas_usadas, 120);
        assert.strictEqual(r.horas_restantes, 230);
        assert.strictEqual(r.proxima_mantencion_en, 350);
        assert.strictEqual(r.por_vencer, false);
        assert.strictEqual(r.vencida, false);
    });

    test('cuenta desde la ultima mantencion, no desde el horometro absoluto', () => {
        // el equipo de la guia real marca 1156 h y recibio mantencion a las 1100
        const r = estado(1156, 1100);
        assert.strictEqual(r.horas_usadas, 56);
        assert.strictEqual(r.horas_restantes, 294);
        assert.strictEqual(r.proxima_mantencion_en, 1450);
        assert.strictEqual(r.por_vencer, false);
    });

    test('avisa al quedar 50 h o menos', () => {
        assert.strictEqual(estado(299).por_vencer, false, 'a 51 h todavia no avisa');
        assert.strictEqual(estado(300).por_vencer, true, 'a 50 h justo avisa');
        assert.strictEqual(estado(340).por_vencer, true);
    });

    test('al cumplir el intervalo queda vencida, no por vencer', () => {
        const r = estado(350);
        assert.strictEqual(r.horas_restantes, 0);
        assert.strictEqual(r.vencida, true);
        assert.strictEqual(r.por_vencer, false);
    });

    test('pasado el intervalo sigue vencida', () => {
        const r = estado(420);
        assert.strictEqual(r.horas_restantes, -70);
        assert.strictEqual(r.vencida, true);
    });

    test('respeta un intervalo distinto al de la flota', () => {
        const r = estado(180, null, 200);
        assert.strictEqual(r.horas_restantes, 20);
        assert.strictEqual(r.por_vencer, true);
        assert.strictEqual(r.proxima_mantencion_en, 200);
    });

    test('una lectura menor a la base no produce horas negativas', () => {
        // pasa si se reemplaza el horometro del equipo o si alguien tipea mal
        assert.strictEqual(estado(50, 1100).horas_usadas, 0);
    });

    test('intervalo invalido no revienta el calculo', () => {
        assert.strictEqual(estado(100, null, 0).horas_restantes, null);
    });
});

describe('requiereAviso', () => {
    test('avisa por vencer y tambien ya vencida', () => {
        // una maquina que paso el intervalo sin lecturas tiene que alertar igual
        assert.strictEqual(requiereAviso(estado(310)), true);
        assert.strictEqual(requiereAviso(estado(500)), true);
    });

    test('no avisa lejos del intervalo ni sin lecturas', () => {
        assert.strictEqual(requiereAviso(estado(100)), false);
        assert.strictEqual(requiereAviso(estado(null)), false);
    });
});

describe('HORAS_AVISO_MANTENCION', () => {
    test('el margen acordado con GOMAQ es de 50 h', () => {
        assert.strictEqual(HORAS_AVISO_MANTENCION, 50);
    });
});
