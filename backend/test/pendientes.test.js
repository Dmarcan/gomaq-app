const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { contarAlertas } = require('../src/utils/mantencion');
const { filtrarPorFacturar, filtrarConAviso } = require('../src/utils/arriendos');
const { cobroParaCliente } = require('../src/utils/cobroCliente');
const { parsearEstados, ESTADOS, EN_CURSO_PANEL } = require('../src/utils/estadosOt');

describe('contarAlertas', () => {
    test('separa las vencidas de las que estan por vencer', () => {
        const equipos = [
            { vencida: true, por_vencer: false },
            { vencida: true, por_vencer: false },
            { vencida: false, por_vencer: true },
        ];
        assert.deepEqual(contarAlertas(equipos), { vencidas: 2, proximas: 1 });
    });

    test('sin alertas da cero y una vencida no cuenta tambien como proxima', () => {
        assert.deepEqual(contarAlertas([]), { vencidas: 0, proximas: 0 });
        assert.deepEqual(contarAlertas([{ vencida: true, por_vencer: true }]), { vencidas: 1, proximas: 0 });
    });
});

describe('filtros de arriendos', () => {
    const config = { dia_facturacion: 5, corte_cierra_periodo: true };

    test('por facturar: cerrados con algo que facturar o facturados de mas; no los en curso ni los completos', () => {
        const todos = [
            { id: 1, en_curso: true, nada_que_facturar: false },
            { id: 2, en_curso: false, nada_que_facturar: false },
            { id: 3, en_curso: false, nada_que_facturar: true },
            { id: 4, en_curso: false, nada_que_facturar: true, facturado_de_mas: true },
        ];
        assert.deepEqual(filtrarPorFacturar(todos).map((a) => a.id), [2, 4]);
    });

    test('con aviso: en curso y con un corte ya cumplido sin facturar', () => {
        const enCurso = (id, inicio, hoy) => ({ id, en_curso: true, inicio_cobro: inicio, facturado_hasta: null, hoy });
        const todos = [
            enCurso(1, '2026-03-04', '2026-03-04'), // antes del corte del 5: sin aviso
            enCurso(2, '2026-03-04', '2026-03-05'), // el dia del corte: aviso
            enCurso(3, '2026-03-06', '2026-05-10'), // dos cortes: aviso
            { id: 4, en_curso: false, inicio_cobro: '2026-01-01', facturado_hasta: null, hoy: '2026-05-10' }, // cerrado: no es "en curso"
        ];
        assert.deepEqual(filtrarConAviso(todos, config).map((a) => a.id), [2, 3]);
    });

    test('con aviso respeta lo ya facturado', () => {
        const a = { id: 1, en_curso: true, inicio_cobro: '2026-03-06', facturado_hasta: '2026-05-05', hoy: '2026-05-10' };
        assert.deepEqual(filtrarConAviso([a], config), [], 'ya se facturo hasta el ultimo corte');
    });
});

describe('cobroParaCliente', () => {
    test('una orden abierta no dice nada', () => {
        for (const estado of ['pendiente', 'asignada', 'aceptada', 'en_camino', 'en_terreno', 'en_reparacion']) {
            assert.equal(cobroParaCliente({ estado, facturable: true, lineasPendientes: 0 }), null);
        }
    });

    test('finalizada: por definir si quedan lineas sin decidir, aunque ya sea facturable', () => {
        assert.equal(cobroParaCliente({ estado: 'finalizada', facturable: true, lineasPendientes: 2 }), 'por_definir');
        assert.equal(cobroParaCliente({ estado: 'finalizada', facturable: false, lineasPendientes: '1' }), 'por_definir');
    });

    test('finalizada: con cobro si es facturable, sin cobro si no', () => {
        assert.equal(cobroParaCliente({ estado: 'finalizada', facturable: true, lineasPendientes: 0 }), 'con_cobro');
        assert.equal(cobroParaCliente({ estado: 'finalizada', facturable: false, lineasPendientes: 0 }), 'sin_cobro');
        assert.equal(cobroParaCliente({ estado: 'finalizada', facturable: null, lineasPendientes: 0 }), 'sin_cobro');
    });
});

describe('parsearEstados', () => {
    test('acepta un estado, una lista y quita repetidos y espacios', () => {
        assert.deepEqual(parsearEstados('finalizada'), { estados: ['finalizada'] });
        assert.deepEqual(parsearEstados('asignada, aceptada,asignada'), { estados: ['asignada', 'aceptada'] });
    });

    test('rechaza un estado desconocido, vacios y tipos raros', () => {
        for (const malo of ['inventado', 'asignada,inventado', '', ',', 'asignada,', undefined, null, 5, ['asignada']]) {
            assert.ok(parsearEstados(malo).error, `debe rechazar ${JSON.stringify(malo)}`);
        }
    });

    test('la lista de estados de la pestana En curso esta dentro de los estados validos y no incluye pendiente ni finalizada', () => {
        assert.ok(EN_CURSO_PANEL.every((e) => ESTADOS.includes(e)));
        assert.ok(!EN_CURSO_PANEL.includes('pendiente') && !EN_CURSO_PANEL.includes('finalizada'));
    });
});
