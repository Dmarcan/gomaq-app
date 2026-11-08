const { test, describe } = require('node:test');
const assert = require('node:assert');

const { decidirRecalculo, CONFIG_POR_DEFECTO } = require('../src/utils/recalculoEta');

const ahora = new Date('2026-11-08T12:00:00.000Z');
const haceSeg = (s) => new Date(ahora.getTime() - s * 1000);

const origen = { latitud: -38.7359, longitud: -72.5904 };
// ~1 km al este de `origen`
const unKmEste = { latitud: -38.7359, longitud: -72.5904 + 0.0113 };
// ~100 m al este de `origen`
const cienMetros = { latitud: -38.7359, longitud: -72.5904 + 0.00113 };

function base(extra = {}) {
    return {
        estado: 'en_camino',
        ultimoCalculoAt: haceSeg(600),
        posicionUltimoCalculo: origen,
        posicionActual: unKmEste,
        consultasOt: 1,
        consultasHoy: 10,
        ahora,
        ...extra,
    };
}

describe('decidirRecalculo', () => {
    test('en camino, paso el tiempo y el mecanico se movio: recalcula', () => {
        assert.deepStrictEqual(decidirRecalculo(base()), { recalcular: true, motivo: 'movimiento' });
    });

    test('la primera consulta de la OT se hace de inmediato', () => {
        const r = decidirRecalculo(base({ ultimoCalculoAt: null, posicionUltimoCalculo: null }));
        assert.deepStrictEqual(r, { recalcular: true, motivo: 'primera' });
    });

    test('fuera de en_camino nunca se consulta', () => {
        for (const estado of ['asignada', 'aceptada', 'en_terreno', 'en_reparacion', 'finalizada']) {
            assert.deepStrictEqual(decidirRecalculo(base({ estado })), { recalcular: false, motivo: 'fuera_de_camino' });
        }
    });

    test('sin posicion del mecanico no hay desde donde calcular', () => {
        assert.deepStrictEqual(decidirRecalculo(base({ posicionActual: null })), { recalcular: false, motivo: 'sin_posicion' });
    });

    test('menos de 3 minutos desde la ultima consulta: no', () => {
        const r = decidirRecalculo(base({ ultimoCalculoAt: haceSeg(CONFIG_POR_DEFECTO.minSegundos - 1) }));
        assert.deepStrictEqual(r, { recalcular: false, motivo: 'muy_reciente' });
    });

    test('justo en el minimo de tiempo ya se puede', () => {
        const r = decidirRecalculo(base({ ultimoCalculoAt: haceSeg(CONFIG_POR_DEFECTO.minSegundos) }));
        assert.strictEqual(r.recalcular, true);
    });

    test('si el mecanico se movio menos de 500 m no se gasta cupo', () => {
        const r = decidirRecalculo(base({ posicionActual: cienMetros }));
        assert.deepStrictEqual(r, { recalcular: false, motivo: 'sin_movimiento' });
    });

    test('tope de consultas por OT', () => {
        const r = decidirRecalculo(base({ consultasOt: CONFIG_POR_DEFECTO.maxPorOt }));
        assert.deepStrictEqual(r, { recalcular: false, motivo: 'tope_por_ot' });
        assert.strictEqual(decidirRecalculo(base({ consultasOt: CONFIG_POR_DEFECTO.maxPorOt - 1 })).recalcular, true);
    });

    test('cupo diario global agotado: nadie consulta, ni la primera vez', () => {
        const agotado = base({ consultasHoy: CONFIG_POR_DEFECTO.cupoDiario, ultimoCalculoAt: null, posicionUltimoCalculo: null });
        assert.deepStrictEqual(decidirRecalculo(agotado), { recalcular: false, motivo: 'cupo_diario' });
    });

    test('la configuracion se puede sobrescribir', () => {
        const r = decidirRecalculo(base({ posicionActual: cienMetros }), { minMetros: 50 });
        assert.strictEqual(r.recalcular, true);
    });

    test('el cupo por defecto deja margen bajo el limite real de 2.000 al dia', () => {
        assert.ok(CONFIG_POR_DEFECTO.cupoDiario < 2000);
    });
});
