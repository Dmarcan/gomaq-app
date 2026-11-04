process.env.TZ = 'America/Santiago'; // solo para las funciones antiguas, que dependen de la zona del proceso

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
    calcularDiasTranscurridos, calcularInicioCobro, diaSantiago, horaSantiago, sumarDias, diasEntre,
    inicioCobroDia, fechasDeCorte, proximoCorte, resumirArriendoEnCurso,
} = require('../src/utils/diasArriendo');
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

describe('calcularDiasTranscurridos', () => {
    test('por defecto el dia de recepcion cuenta (comportamiento de siempre)', () => {
        assert.equal(calcularDiasTranscurridos('2026-03-01T09:00:00-03:00', '2026-03-05T10:00:00-03:00'), 5);
    });

    test('sin contar el dia de recepcion: del 1 al 5 son 4', () => {
        const opciones = { incluirDiaRecepcion: false };
        assert.equal(calcularDiasTranscurridos('2026-03-01T09:00:00-03:00', '2026-03-05T10:00:00-03:00', opciones), 4);
    });

    test('recepcion el mismo dia del inicio da 0 sin contar el dia de recepcion, y nunca negativo', () => {
        const opciones = { incluirDiaRecepcion: false };
        assert.equal(calcularDiasTranscurridos('2026-03-01T09:00:00-03:00', '2026-03-01T17:00:00-03:00', opciones), 0);
        // despacho a las 15:00 (cobra desde el dia siguiente) y recepcion el mismo dia
        assert.equal(calcularDiasTranscurridos('2026-03-01T15:00:00-03:00', '2026-03-01T17:00:00-03:00', opciones), 0);
        assert.equal(calcularDiasTranscurridos('2026-03-01T15:00:00-03:00', '2026-03-01T17:00:00-03:00'), 0);
    });

    test('la hora de corte configurable cambia el primer dia', () => {
        assert.equal(calcularDiasTranscurridos('2026-03-01T10:00:00-03:00', '2026-03-05T10:00:00-03:00', { horaCorte: 9 }), 4);
        assert.equal(calcularDiasTranscurridos('2026-03-01T10:00:00-03:00', '2026-03-05T10:00:00-03:00', { horaCorte: 13 }), 5);
    });

    test('calcularInicioCobro conserva su comportamiento', () => {
        assert.equal(calcularInicioCobro('2026-03-10T12:59:00-03:00').getDate(), 10);
        assert.equal(calcularInicioCobro('2026-03-10T13:00:00-03:00').getDate(), 11);
    });
});

describe('fechasDeCorte y proximoCorte', () => {
    test('cortes dentro del rango, inclusive', () => {
        assert.deepEqual(fechasDeCorte('2026-03-06', '2026-05-10', 5), ['2026-04-05', '2026-05-05']);
        assert.deepEqual(fechasDeCorte('2026-03-05', '2026-03-05', 5), ['2026-03-05']);
        assert.deepEqual(fechasDeCorte('2026-03-06', '2026-04-04', 5), []);
        assert.deepEqual(fechasDeCorte('2026-03-10', '2026-03-01', 5), []);
    });

    test('dia 1, dia 28 (febrero) y paso de diciembre a enero', () => {
        assert.deepEqual(fechasDeCorte('2026-01-15', '2026-03-01', 1), ['2026-02-01', '2026-03-01']);
        assert.deepEqual(fechasDeCorte('2026-02-01', '2026-02-28', 28), ['2026-02-28']);
        assert.deepEqual(fechasDeCorte('2026-12-20', '2027-01-10', 5), ['2027-01-05']);
    });

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
            validarCambioConfiguracion({ dia_facturacion: 1, hora_corte_despacho: 0, incluir_dia_recepcion: false }).valores,
            { dia_facturacion: 1, hora_corte_despacho: 0, incluir_dia_recepcion: false });
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
        assert.deepEqual({ ...DEFAULTS }, { dia_facturacion: 5, hora_corte_despacho: 13, incluir_dia_recepcion: true });
    });
});
