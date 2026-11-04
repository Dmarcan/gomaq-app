const { test, describe } = require('node:test');
const assert = require('node:assert');

const { finesDePeriodo, finesVencidos, proponerPeriodo, validarPeriodo, resumirArriendoEnCurso } = require('../src/utils/periodosArriendo');
const { diasEntre, inicioCobroDia } = require('../src/utils/diasArriendo');
const { validarCambioConfiguracion } = require('../src/utils/configuracion');

describe('finesDePeriodo', () => {
    test('el corte cierra el periodo: el fin es el dia de corte', () => {
        assert.deepEqual(finesDePeriodo('2026-03-06', '2026-05-10', 5), ['2026-04-05', '2026-05-05']);
        assert.deepEqual(finesDePeriodo('2026-03-05', '2026-03-05', 5), ['2026-03-05']);
    });

    test('el corte no cierra el periodo: el fin es el dia anterior', () => {
        assert.deepEqual(finesDePeriodo('2026-03-06', '2026-05-10', 5, false), ['2026-04-04', '2026-05-04']);
        // un fin que cae antes del desde no entra
        assert.deepEqual(finesDePeriodo('2026-03-05', '2026-03-31', 5, false), []);
        assert.deepEqual(finesDePeriodo('2026-03-04', '2026-03-31', 5, false), ['2026-03-04']);
    });

    test('dia de corte 1: el fin sin cierre es el ultimo dia del mes anterior', () => {
        assert.deepEqual(finesDePeriodo('2026-02-10', '2026-04-15', 1, false), ['2026-02-28', '2026-03-31']);
        assert.deepEqual(finesDePeriodo('2026-02-10', '2026-04-15', 1, true), ['2026-03-01', '2026-04-01']);
        // ano bisiesto
        assert.deepEqual(finesDePeriodo('2028-02-10', '2028-03-15', 1, false), ['2028-02-29']);
    });

    test('paso de ano y rango invertido', () => {
        assert.deepEqual(finesDePeriodo('2026-12-20', '2027-01-10', 5), ['2027-01-05']);
        assert.deepEqual(finesDePeriodo('2026-12-20', '2027-01-10', 5, false), ['2027-01-04']);
        assert.deepEqual(finesDePeriodo('2026-03-10', '2026-03-01', 5), []);
    });

    test('vencidos: el aviso aparece desde el dia de corte con o sin cierre', () => {
        // corte el 5; el 4 todavia no, el 5 si
        assert.deepEqual(finesVencidos('2026-03-01', '2026-03-04', 5, true), []);
        assert.deepEqual(finesVencidos('2026-03-01', '2026-03-05', 5, true), ['2026-03-05']);
        assert.deepEqual(finesVencidos('2026-03-01', '2026-03-04', 5, false), []);
        assert.deepEqual(finesVencidos('2026-03-01', '2026-03-05', 5, false), ['2026-03-04']);
    });

    test('dia de corte entre 1 y 28 nunca deja huecos ni se pasa de mes (2027 y 2028)', () => {
        for (const cierra of [true, false]) {
            for (let dia = 1; dia <= 28; dia++) {
                for (const inicio of ['2027-01-15', '2027-12-31', '2028-02-01', '2028-02-29']) {
                    const fin = '2028-04-20';
                    const fines = finesDePeriodo(inicio, fin, dia, cierra);
                    const puntos = [...fines];
                    if (puntos[puntos.length - 1] !== fin) puntos.push(fin);
                    // los periodos encadenados suman exactamente los dias del arriendo
                    let desde = inicio;
                    let total = 0;
                    for (const hasta of puntos) {
                        total += diasEntre(desde, hasta);
                        const [a, m, d] = hasta.split('-').map(Number);
                        desde = new Date(Date.UTC(a, m - 1, d + 1)).toISOString().slice(0, 10);
                    }
                    assert.equal(total, diasEntre(inicio, fin), `dia ${dia}, cierra ${cierra}, inicio ${inicio}`);
                    for (const f of fines) assert.match(f, /^\d{4}-\d{2}-\d{2}$/);
                }
            }
        }
    });
});

describe('proponerPeriodo', () => {
    const base = { diaFacturacion: 5, hoy: '2026-11-04' };

    test('despacho el 4 de nov a las 10 h: periodo del 4 al 5 (2 dias) al terminar', () => {
        const inicio = inicioCobroDia('2026-11-04T10:00:00-03:00');
        const p = proponerPeriodo({ ...base, inicioCobro: inicio, fin: '2026-11-20' });
        assert.equal(p.desde, '2026-11-04');
        assert.equal(p.hasta_sugerido, '2026-11-05');
        assert.equal(p.dias, 2);
        assert.equal(p.es_final, false);
    });

    test('despacho el 4 de nov a las 14 h: parte el 5 y el primer periodo es solo el 5', () => {
        const inicio = inicioCobroDia('2026-11-04T14:00:00-03:00');
        const p = proponerPeriodo({ ...base, inicioCobro: inicio, fin: '2026-11-20' });
        assert.equal(p.desde, '2026-11-05');
        assert.equal(p.hasta_sugerido, '2026-11-05');
        assert.equal(p.dias, 1);
    });

    test('despacho el 3 de nov a las 15 h: del 4 al 5', () => {
        const inicio = inicioCobroDia('2026-11-03T15:00:00-03:00');
        const p = proponerPeriodo({ ...base, inicioCobro: inicio, fin: '2026-11-20' });
        assert.equal(p.desde, '2026-11-04');
        assert.equal(p.dias, 2);
    });

    test('sin cierre del corte: el periodo del 4 de nov termina el 4, y el del 5 sigue hasta el 4 de dic', () => {
        const a = proponerPeriodo({ ...base, inicioCobro: '2026-11-04', fin: '2026-11-20', corteCierraPeriodo: false });
        assert.equal(a.hasta_sugerido, '2026-11-04');
        const b = proponerPeriodo({ ...base, inicioCobro: '2026-11-05', fin: '2027-01-20', corteCierraPeriodo: false });
        assert.equal(b.hasta_sugerido, '2026-12-04');
    });

    test('varios cortes sin facturar: opciones y encadenado sin huecos', () => {
        const p = proponerPeriodo({ ...base, inicioCobro: '2026-08-01', fin: '2026-10-20', hoy: '2026-10-20' });
        assert.deepEqual(p.opciones_hasta, ['2026-08-05', '2026-09-05', '2026-10-05', '2026-10-20']);
        assert.equal(p.hasta_sugerido, '2026-08-05');
        // facturado el primero: el siguiente parte el dia despues
        const q = proponerPeriodo({ ...base, inicioCobro: '2026-08-01', facturadoHasta: '2026-08-05', fin: '2026-10-20', hoy: '2026-10-20' });
        assert.equal(q.desde, '2026-08-06');
        assert.equal(q.hasta_sugerido, '2026-09-05');
    });

    test('devolucion antes del primer corte: un solo periodo final', () => {
        const p = proponerPeriodo({ ...base, inicioCobro: '2026-10-10', fin: '2026-10-20', hoy: '2026-10-25' });
        assert.deepEqual(p.opciones_hasta, ['2026-10-20']);
        assert.equal(p.es_final, true);
        assert.equal(p.dias, 11);
    });

    test('el fin coincide con un fin de periodo: no se duplica', () => {
        const p = proponerPeriodo({ ...base, inicioCobro: '2026-10-10', fin: '2026-11-05', hoy: '2026-11-10' });
        assert.deepEqual(p.opciones_hasta, ['2026-11-05']);
        assert.equal(p.es_final, true);
    });

    test('arriendo de 0 dias o ya facturado completo: nada que facturar', () => {
        const cero = proponerPeriodo({ ...base, inicioCobro: '2026-03-02', fin: '2026-03-01', hoy: '2026-03-10' });
        assert.equal(cero.nada_que_facturar, true);
        assert.equal(cero.hasta_sugerido, null);
        const completo = proponerPeriodo({ ...base, inicioCobro: '2026-03-01', facturadoHasta: '2026-03-20', fin: '2026-03-20', hoy: '2026-03-25' });
        assert.equal(completo.nada_que_facturar, true);
        assert.equal(completo.facturado_de_mas, false);
    });

    test('recepcion retroactiva anterior a lo ya facturado: facturado de mas', () => {
        const p = proponerPeriodo({ ...base, inicioCobro: '2026-03-01', facturadoHasta: '2026-04-05', fin: '2026-03-20', hoy: '2026-04-10' });
        assert.equal(p.facturado_de_mas, true);
        assert.equal(p.nada_que_facturar, true);
    });

    test('arriendo en curso: solo periodos cuyo corte ya llego', () => {
        const antes = proponerPeriodo({ ...base, inicioCobro: '2026-11-01', hoy: '2026-11-04' });
        assert.equal(antes.nada_que_facturar, true);
        const dia = proponerPeriodo({ ...base, inicioCobro: '2026-11-01', hoy: '2026-11-05' });
        assert.deepEqual(dia.opciones_hasta, ['2026-11-05']);
        assert.equal(dia.es_final, false);
    });

    test('recepcion y despacho del mismo dia a otro cliente: cada uno con su dia', () => {
        // X vuelve el 10 a las 11 h y se factura hasta el 10; Y sale el 10 a las 12 h y cobra desde el 10
        assert.equal(inicioCobroDia('2026-11-10T12:00:00-03:00'), '2026-11-10');
        // y si sale a las 14 h cobra desde el 11
        assert.equal(inicioCobroDia('2026-11-10T14:00:00-03:00'), '2026-11-11');
        const x = proponerPeriodo({ ...base, inicioCobro: '2026-11-06', fin: '2026-11-10', hoy: '2026-11-10' });
        assert.equal(x.hasta_sugerido, '2026-11-10');
    });
});

describe('validarPeriodo', () => {
    const propuesta = proponerPeriodo({ inicioCobro: '2026-08-01', fin: '2026-10-20', hoy: '2026-10-20', diaFacturacion: 5 });

    test('acepta el periodo propuesto y cualquier fin de la lista', () => {
        assert.equal(validarPeriodo({ desde: '2026-08-01', hasta: '2026-08-05' }, propuesta).ok, true);
        assert.equal(validarPeriodo({ desde: '2026-08-01', hasta: '2026-10-20' }, propuesta).ok, true);
    });

    test('rechaza un desde distinto (hueco o solape) y un hasta fuera de la lista', () => {
        const hueco = validarPeriodo({ desde: '2026-08-03', hasta: '2026-08-05' }, propuesta);
        assert.equal(hueco.ok, false);
        assert.equal(hueco.codigo, 'periodo_desactualizado');
        assert.equal(hueco.estado, 409);
        const invalido = validarPeriodo({ desde: '2026-08-01', hasta: '2026-08-07' }, propuesta);
        assert.equal(invalido.codigo, 'hasta_invalido');
        assert.equal(invalido.estado, 400);
        const mas = validarPeriodo({ desde: '2026-08-01', hasta: '2026-10-21' }, propuesta);
        assert.equal(mas.ok, false);
    });

    test('sin nada que facturar da 409', () => {
        const nada = proponerPeriodo({ inicioCobro: '2026-03-01', facturadoHasta: '2026-03-20', fin: '2026-03-20', hoy: '2026-03-25', diaFacturacion: 5 });
        const v = validarPeriodo({ desde: '2026-03-21', hasta: '2026-03-21' }, nada);
        assert.equal(v.codigo, 'nada_que_facturar');
    });
});

describe('resumirArriendoEnCurso con y sin cierre del corte', () => {
    test('con cierre: el 5 hay periodo; sin cierre: tambien el 5, con fin el 4', () => {
        const con = resumirArriendoEnCurso({ inicioCobro: '2026-03-01', hoy: '2026-03-05', diaFacturacion: 5 });
        assert.equal(con.periodos_sin_facturar, 1);
        const sin = resumirArriendoEnCurso({ inicioCobro: '2026-03-01', hoy: '2026-03-05', diaFacturacion: 5, corteCierraPeriodo: false });
        assert.equal(sin.periodos_sin_facturar, 1);
        const antes = resumirArriendoEnCurso({ inicioCobro: '2026-03-01', hoy: '2026-03-04', diaFacturacion: 5, corteCierraPeriodo: false });
        assert.equal(antes.periodos_sin_facturar, 0);
    });

    test('la clave nueva de configuracion es booleana estricta', () => {
        assert.deepEqual(validarCambioConfiguracion({ corte_cierra_periodo: false }).valores, { corte_cierra_periodo: false });
        assert.ok(validarCambioConfiguracion({ corte_cierra_periodo: 'no' }).error);
        assert.ok(validarCambioConfiguracion({ corte_cierra_periodo: 0 }).error);
    });
});
