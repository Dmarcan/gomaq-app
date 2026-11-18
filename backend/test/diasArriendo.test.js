process.env.TZ = 'America/Santiago'; // solo para las funciones antiguas, que dependen de la zona del proceso

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
    diaSantiago, horaSantiago, sumarDias, diasEntre,
    inicioCobroDia, finCobroDia, proximoCorte,
} = require('../src/utils/diasArriendo');
const { resumirArriendoEnCurso } = require('../src/utils/periodosArriendo');
const { DEFAULTS, validarCambioConfiguracion } = require('../src/utils/configuracion');

describe('inicioCobroDia (independiente de la zona del proceso)', () => {
    test('12:59 cuenta el dia del despacho y 13:00 parte al dia siguiente', () => {
        // marzo de 2026: Santiago esta en UTC-3 (horario de verano termina en abril)
        assert.equal(inicioCobroDia('2026-03-10T12:59:00-03:00'), '2026-03-10');
        assert.equal(inicioCobroDia('2026-03-10T13:00:00-03:00'), '2026-03-11');
    });

    test('corte configurable: 0, 9 y 23', () => {
        assert.equal(inicioCobroDia('2026-03-10T00:00:00-03:00', 0), '2026-03-11');
        assert.equal(inicioCobroDia('2026-03-10T08:59:00-03:00', 9), '2026-03-10');
        assert.equal(inicioCobroDia('2026-03-10T09:00:00-03:00', 9), '2026-03-11');
        assert.equal(inicioCobroDia('2026-03-10T22:59:00-03:00', 23), '2026-03-10');
        assert.equal(inicioCobroDia('2026-03-10T23:00:00-03:00', 23), '2026-03-11');
    });

    test('usa el dia de Santiago aunque el instante UTC sea de otro dia', () => {
        // 02:00 UTC del 5 de marzo = 23:00 del 4 de marzo en Santiago
        assert.equal(diaSantiago('2026-03-05T02:00:00Z'), '2026-03-04');
        assert.equal(horaSantiago('2026-03-05T02:00:00Z'), 23);
        assert.equal(inicioCobroDia('2026-03-05T02:00:00Z'), '2026-03-05');
    });

    test('no depende de process.env.TZ', () => {
        const antes = process.env.TZ;
        try {
            process.env.TZ = 'UTC';
            assert.equal(inicioCobroDia('2026-03-05T02:00:00Z'), '2026-03-05');
            assert.equal(inicioCobroDia('2026-03-10T12:59:00-03:00'), '2026-03-10');
        } finally {
            process.env.TZ = antes;
        }
    });

    test('cambios de calendario: fin de ano y ano bisiesto', () => {
        assert.equal(inicioCobroDia('2026-12-31T14:00:00-03:00'), '2027-01-01');
        assert.equal(inicioCobroDia('2028-02-28T14:00:00-03:00'), '2028-02-29');
        assert.equal(sumarDias('2028-02-28', 2), '2028-03-01');
    });
});

describe('diasEntre', () => {
    test('cuenta ambos extremos y no baja de 0', () => {
        assert.equal(diasEntre('2026-03-05', '2026-03-05'), 1);
        assert.equal(diasEntre('2026-03-01', '2026-03-10'), 10);
        assert.equal(diasEntre('2026-03-06', '2026-03-05'), 0);
        assert.equal(diasEntre('2026-03-10', '2026-03-01'), 0);
    });

    test('los cambios de hora de Chile no mueven el conteo', () => {
        assert.equal(diasEntre('2026-04-01', '2026-04-10'), 10);
        assert.equal(diasEntre('2026-09-01', '2026-09-10'), 10);
        assert.equal(diasEntre('2026-12-25', '2027-01-03'), 10);
    });
});

describe('finCobroDia: el ultimo dia que se cobra al cliente que entrega el equipo', () => {
    test('antes del corte no cobra ese dia y desde el corte si (corte 13)', () => {
        for (const [hora, esperado] of [
            ['00:00', '2026-03-09'], ['09:59', '2026-03-09'], ['10:00', '2026-03-09'], ['12:59', '2026-03-09'],
            ['13:00', '2026-03-10'], ['14:00', '2026-03-10'], ['23:59', '2026-03-10'],
        ]) {
            assert.equal(finCobroDia(`2026-03-10T${hora}:00-03:00`, 13), esperado, hora);
        }
    });

    test('con otros cortes: 0, 9 y 23', () => {
        assert.equal(finCobroDia('2026-03-10T00:00:00-03:00', 0), '2026-03-10');
        assert.equal(finCobroDia('2026-03-10T08:59:00-03:00', 9), '2026-03-09');
        assert.equal(finCobroDia('2026-03-10T09:00:00-03:00', 9), '2026-03-10');
        assert.equal(finCobroDia('2026-03-10T22:59:00-03:00', 23), '2026-03-09');
        assert.equal(finCobroDia('2026-03-10T23:00:00-03:00', 23), '2026-03-10');
    });

    test('usa el dia de Santiago y no depende de la zona del proceso', () => {
        const antes = process.env.TZ;
        try {
            process.env.TZ = 'UTC';
            // 02:00 UTC del 11 de marzo = 23:00 del 10 en Santiago (verano, UTC-3): desde el corte
            assert.equal(finCobroDia('2026-03-11T02:00:00Z', 13), '2026-03-10');
            // 14:00 UTC del 10 = 11:00 en Santiago: antes del corte
            assert.equal(finCobroDia('2026-03-10T14:00:00Z', 13), '2026-03-09');
        } finally {
            process.env.TZ = antes;
        }
    });

    test('cambios de hora de Chile (abril y septiembre de 2026)', () => {
        assert.equal(finCobroDia('2026-04-04T23:30:00-03:00', 13), '2026-04-04');
        assert.equal(finCobroDia('2026-04-05T12:59:00-04:00', 13), '2026-04-04');
        assert.equal(finCobroDia('2026-04-05T13:00:00-04:00', 13), '2026-04-05');
        assert.equal(finCobroDia('2026-09-06T12:59:00-03:00', 13), '2026-09-05');
        assert.equal(finCobroDia('2026-09-06T13:00:00-03:00', 13), '2026-09-06');
    });
});

describe('cambio de cliente: cada dia se cobra a uno solo (contiguidad)', () => {
    // A recibe el equipo antes; en `t` el equipo pasa a B (despacho): fin de A = finCobroDia(t),
    // inicio de B = inicioCobroDia(t). Los dias de A y de B no dejan huecos ni se solapan.
    const horas = ['00:00', '09:59', '10:00', '12:59', '13:00', '14:00', '23:59'];

    test('el dia del cambio, antes del corte, es del cliente nuevo; desde el corte, del anterior (corte 13)', () => {
        const antes = '2026-03-10T10:00:00-03:00';
        assert.equal(finCobroDia(antes, 13), '2026-03-09'); // ACSA termina el 9
        assert.equal(inicioCobroDia(antes, 13), '2026-03-10'); // Prize parte el 10
        const despues = '2026-03-10T15:00:00-03:00';
        assert.equal(finCobroDia(despues, 13), '2026-03-10'); // ACSA cobra el 10
        assert.equal(inicioCobroDia(despues, 13), '2026-03-11'); // Prize parte el 11
    });

    test('para cualquier hora, corte y fecha el fin del anterior es el dia antes del inicio del nuevo', () => {
        for (const corte of [0, 9, 13, 23]) {
            for (const dia of ['2026-03-10', '2026-04-04', '2026-04-05', '2026-09-05', '2026-09-06', '2028-02-28', '2026-12-31']) {
                for (const hora of horas) {
                    const t = `${dia}T${hora}:00-03:00`;
                    assert.equal(sumarDias(finCobroDia(t, corte), 1), inicioCobroDia(t, corte), `${t} corte ${corte}`);
                }
            }
        }
    });

    test('los dias de A y de B suman los dias entre el inicio de A y el fin de B', () => {
        const inicioA = '2026-03-01';
        const finB = '2026-03-20';
        for (const corte of [0, 9, 13, 23]) {
            for (const hora of horas) {
                const t = `2026-03-10T${hora}:00-03:00`;
                const dias = diasEntre(inicioA, finCobroDia(t, corte)) + diasEntre(inicioCobroDia(t, corte), finB);
                assert.equal(dias, diasEntre(inicioA, finB), `${hora} corte ${corte}`);
            }
        }
    });

    test('el cliente anterior que empezo el mismo dia del cambio queda en 0 dias', () => {
        const inicioA = inicioCobroDia('2026-03-10T09:00:00-03:00', 13);
        const finA = finCobroDia('2026-03-10T10:00:00-03:00', 13);
        assert.equal(diasEntre(inicioA, finA), 0);
    });
});

describe('proximoCorte', () => {
    test('proximo corte es siempre posterior a hoy', () => {
        assert.equal(proximoCorte('2026-03-04', 5), '2026-03-05');
        assert.equal(proximoCorte('2026-03-05', 5), '2026-04-05');
        assert.equal(proximoCorte('2026-12-20', 5), '2027-01-05');
        assert.equal(proximoCorte('2026-02-28', 28), '2026-03-28');
    });
});

describe('resumirArriendoEnCurso', () => {
    const resumir = (inicioCobro, hoy, extra = {}) => resumirArriendoEnCurso({ inicioCobro, hoy, diaFacturacion: 5, ...extra });

    test('el dia antes del corte no hay periodos ni aviso', () => {
        const r = resumir('2026-03-04', '2026-03-04');
        assert.equal(r.periodos_sin_facturar, 0);
        assert.equal(r.aviso, false);
        assert.equal(r.proximo_corte, '2026-03-05');
        assert.equal(r.dias, 1);
    });

    test('el dia de corte hay un periodo y aviso', () => {
        const r = resumir('2026-03-04', '2026-03-05');
        assert.equal(r.periodos_sin_facturar, 1);
        assert.equal(r.aviso, true);
        assert.equal(r.proximo_corte, '2026-04-05');
    });

    test('despacho el mismo dia de corte: un periodo de 1 dia', () => {
        const r = resumir('2026-03-05', '2026-03-05');
        assert.equal(r.periodos_sin_facturar, 1);
        assert.equal(r.dias, 1);
    });

    test('varios cortes sin facturar', () => {
        const r = resumir('2026-03-06', '2026-05-10');
        assert.equal(r.periodos_sin_facturar, 2);
        assert.equal(r.desde, '2026-03-06');
        assert.equal(r.dias, 66);
        assert.equal(r.proximo_corte, '2026-06-05');
    });

    test('con ultimo periodo facturado, cuenta desde el dia siguiente', () => {
        const r = resumir('2026-03-06', '2026-05-10', { ultimoPeriodoHasta: '2026-04-05' });
        assert.equal(r.desde, '2026-04-06');
        assert.equal(r.periodos_sin_facturar, 1);
        assert.equal(r.dias, 35);
    });
});

describe('validarCambioConfiguracion', () => {
    test('acepta valores validos y devuelve solo lo enviado', () => {
        assert.deepEqual(validarCambioConfiguracion({ dia_facturacion: 28 }).valores, { dia_facturacion: 28 });
        assert.deepEqual(
            validarCambioConfiguracion({ dia_facturacion: 1, hora_corte_despacho: 0, corte_cierra_periodo: false }).valores,
            { dia_facturacion: 1, hora_corte_despacho: 0, corte_cierra_periodo: false });
    });

    test('incluir_dia_recepcion esta obsoleta: el PUT la sigue aceptando pero no forma parte de los valores por defecto', () => {
        assert.deepEqual(validarCambioConfiguracion({ incluir_dia_recepcion: false }).valores, { incluir_dia_recepcion: false });
        assert.equal('incluir_dia_recepcion' in DEFAULTS, false);
    });

    test('rechaza fuera de rango, decimales, textos, nulos, claves desconocidas y cuerpo vacio', () => {
        for (const cuerpo of [
            { dia_facturacion: 0 }, { dia_facturacion: 29 }, { dia_facturacion: 5.5 }, { dia_facturacion: '5' },
            { dia_facturacion: null }, { hora_corte_despacho: 24 }, { hora_corte_despacho: -1 },
            { incluir_dia_recepcion: 'true' }, { incluir_dia_recepcion: 1 }, { inventada: 1 },
            { dia_facturacion: 5, inventada: 1 }, JSON.parse('{"__proto__":1}'), { constructor: 1 }, { toString: true },
            { valueOf: 1 }, {}, null, [], 'x',
        ]) {
            assert.ok(validarCambioConfiguracion(cuerpo).error, `debe rechazar ${JSON.stringify(cuerpo)}`);
        }
    });

    test('los valores por defecto son los de siempre', () => {
        assert.deepEqual({ ...DEFAULTS }, { dia_facturacion: 5, hora_corte_despacho: 13, corte_cierra_periodo: true });
    });
});
