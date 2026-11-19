const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { MOTIVOS_AJUSTE, MOTIVOS_CONTEO, validarMotivoAjuste, leerCantidadEstricta, calcularAjuste, reconstruirDescuadre } = require('../src/utils/stock');

describe('validarMotivoAjuste', () => {
    test('acepta los seis motivos de la lista cerrada', () => {
        for (const codigo of Object.keys(MOTIVOS_AJUSTE)) assert.equal(validarMotivoAjuste(codigo).valido, true, codigo);
        assert.deepEqual(Object.keys(MOTIVOS_AJUSTE), [
            'traspaso_no_registrado', 'compra_no_ingresada', 'error_registro', 'diferencia_conteo', 'danio_merma', 'perdida_robo',
        ]);
    });

    test('rechaza lo que no esta en la lista, vacio, otros tipos y claves heredadas del prototipo', () => {
        for (const raro of ['otro', '', null, undefined, 5, {}, [], 'constructor', 'toString', '__proto__']) {
            assert.equal(validarMotivoAjuste(raro).valido, false, String(raro));
        }
    });
});

describe('motivos de conteo', () => {
    test('el conteo no admite traspaso_no_registrado: ese caso se cuadra con un traspaso', () => {
        assert.equal(Object.keys(MOTIVOS_CONTEO).length, 5);
        assert.equal(validarMotivoAjuste('traspaso_no_registrado', MOTIVOS_CONTEO).valido, false);
        assert.equal(validarMotivoAjuste('traspaso_no_registrado').valido, true, 'el traspaso si lo admite');
        for (const codigo of Object.keys(MOTIVOS_CONTEO)) assert.equal(validarMotivoAjuste(codigo, MOTIVOS_CONTEO).valido, true, codigo);
    });
});

describe('leerCantidadEstricta', () => {
    test('acepta numeros finitos y textos decimales', () => {
        assert.equal(leerCantidadEstricta(5), 5);
        assert.equal(leerCantidadEstricta(-3.5), -3.5);
        assert.equal(leerCantidadEstricta('12'), 12);
        assert.equal(leerCantidadEstricta('-3.50'), -3.5);
        assert.equal(leerCantidadEstricta('9999999999.99'), 9999999999.99);
    });

    test('rechaza booleanos, arreglos, hexadecimal, notacion cientifica, Infinity, NaN y desbordes', () => {
        for (const raro of [true, false, [5], ['5'], '0x10', '1e3', 'Infinity', Infinity, -Infinity, NaN, '', ' ', null, undefined, {}, '1,5', '5.', '.5',
            1e12, '10000000000', 10000000000, '-10000000000.01']) {
            assert.equal(leerCantidadEstricta(raro), null, String(raro));
        }
    });
});

describe('calcularAjuste', () => {
    test('un conteo de 1 sobre -3 genera +4', () => {
        assert.deepEqual(calcularAjuste({ contada: 1, sistema: -3, esperada: -3 }), { ok: true, delta: 4 });
    });

    test('contar menos de lo que hay genera un delta negativo, y igual no genera cambio', () => {
        assert.equal(calcularAjuste({ contada: 2, sistema: 5, esperada: 5 }).delta, -3);
        assert.equal(calcularAjuste({ contada: 5, sistema: 5, esperada: 5 }).delta, 0);
    });

    test('acepta cantidades como texto de Postgres y decimales', () => {
        assert.equal(calcularAjuste({ contada: '1.50', sistema: '-3.00', esperada: '-3.00' }).delta, 4.5);
        assert.equal(calcularAjuste({ contada: 0.1, sistema: 0.2, esperada: 0.2 }).delta, -0.1);
    });

    test('409 si el stock cambio mientras se contaba', () => {
        const r = calcularAjuste({ contada: 1, sistema: -2, esperada: -3 });
        assert.equal(r.ok, false);
        assert.equal(r.status, 409);
    });

    test('400 si lo contado es negativo, vacio o no numerico', () => {
        for (const contada of [-1, null, undefined, '', 'abc', NaN]) {
            const r = calcularAjuste({ contada, sistema: 0, esperada: 0 });
            assert.equal(r.ok, false, String(contada));
            assert.equal(r.status, 400, String(contada));
        }
    });

    test('400 con valores raros en lo contado o en lo esperado', () => {
        for (const raro of [true, [5], '0x10', Infinity, 1e12, '1e3']) {
            assert.equal(calcularAjuste({ contada: raro, sistema: 0, esperada: 0 }).status, 400, `contada ${String(raro)}`);
            assert.equal(calcularAjuste({ contada: 1, sistema: 0, esperada: raro }).status, 400, `esperada ${String(raro)}`);
        }
    });

    test('400 si falta la cantidad esperada', () => {
        for (const esperada of [undefined, null, '', 'x']) {
            assert.equal(calcularAjuste({ contada: 1, sistema: 0, esperada }).status, 400);
        }
    });
});

describe('reconstruirDescuadre', () => {
    test('cruce simple: entra 5, salen 8, queda -3 desde la salida', () => {
        const r = reconstruirDescuadre(-3, [{ at: '2026-03-01T10:00:00Z', delta: 5 }, { at: '2026-03-05T10:00:00Z', delta: -8 }]);
        assert.equal(r.negativo_desde, '2026-03-05T10:00:00Z');
        assert.equal(r.ultimo_movimiento_at, '2026-03-05T10:00:00Z');
        assert.equal(r.sin_origen, false);
    });

    test('se recupera en parte y sigue negativo: la fecha desde no cambia', () => {
        const r = reconstruirDescuadre(-1, [
            { at: '2026-03-01T10:00:00Z', delta: 5 },
            { at: '2026-03-05T10:00:00Z', delta: -8 },
            { at: '2026-03-07T10:00:00Z', delta: 2 },
        ]);
        assert.equal(r.negativo_desde, '2026-03-05T10:00:00Z');
        assert.equal(r.ultimo_movimiento_at, '2026-03-07T10:00:00Z');
    });

    test('vuelve a 0 y luego cae otra vez: la fecha desde es la segunda caida', () => {
        const r = reconstruirDescuadre(-2, [
            { at: '2026-03-01T10:00:00Z', delta: 5 },
            { at: '2026-03-02T10:00:00Z', delta: -6 },
            { at: '2026-03-03T10:00:00Z', delta: 1 },
            { at: '2026-03-09T10:00:00Z', delta: -2 },
        ]);
        assert.equal(r.negativo_desde, '2026-03-09T10:00:00Z');
    });

    test('una linea anulada suma de vuelta en su fecha de anulacion', () => {
        // sale 4 (queda -4), se anula la linea (+4): queda en 0, luego sale 1 y queda -1
        const r = reconstruirDescuadre(-1, [
            { at: '2026-03-01T10:00:00Z', delta: -4 },
            { at: '2026-03-02T10:00:00Z', delta: 4 },
            { at: '2026-03-06T10:00:00Z', delta: -1 },
        ]);
        assert.equal(r.negativo_desde, '2026-03-06T10:00:00Z');
        assert.equal(r.sin_origen, false);
    });

    test('un negativo que ningun movimiento explica queda como sin origen', () => {
        // el saldo ya era negativo antes del unico evento (p. ej. la siembra de la migracion 014)
        const r = reconstruirDescuadre(-5, [{ at: '2026-03-05T10:00:00Z', delta: -1 }]);
        assert.equal(r.sin_origen, true);
        assert.equal(r.negativo_desde, '2026-03-05T10:00:00Z');
        const sinEventos = reconstruirDescuadre(-5, []);
        assert.equal(sinEventos.sin_origen, true);
        assert.equal(sinEventos.negativo_desde, null);
        assert.equal(sinEventos.ultimo_movimiento_at, null);
    });

    test('eventos con la misma hora conservan el orden recibido', () => {
        const mismo = '2026-03-05T10:00:00Z';
        const r = reconstruirDescuadre(-3, [{ at: mismo, delta: 2 }, { at: mismo, delta: -5 }]);
        assert.equal(r.negativo_desde, mismo);
        assert.equal(r.sin_origen, false);
    });

    test('cantidades como texto y decimales no acumulan error', () => {
        const r = reconstruirDescuadre('-0.10', [
            { at: '2026-03-01T10:00:00Z', delta: '0.20' },
            { at: '2026-03-02T10:00:00Z', delta: '-0.30' },
        ]);
        assert.equal(r.negativo_desde, '2026-03-02T10:00:00Z');
        assert.equal(r.sin_origen, false);
    });

    test('una existencia no negativa no tiene fecha desde', () => {
        const r = reconstruirDescuadre(0, [{ at: '2026-03-01T10:00:00Z', delta: 5 }, { at: '2026-03-02T10:00:00Z', delta: -5 }]);
        assert.equal(r.negativo_desde, null);
    });
});
