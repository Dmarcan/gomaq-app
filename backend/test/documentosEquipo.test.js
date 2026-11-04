const { test, describe } = require('node:test');
const assert = require('node:assert');
const { visiblePara, construirSqlDocumentos, filaPublica } = require('../src/utils/documentosEquipo');

describe('visiblePara', () => {
    const doc = (cliente) => ({ tipo: 'guia_despacho', cliente_id: cliente });

    test('administrativo y gerente ven todo, incluso lo que no tiene cliente', () => {
        for (const rol of ['administrativo', 'gerente']) {
            assert.equal(visiblePara(doc(1), { rol }), true);
            assert.equal(visiblePara(doc(null), { rol }), true);
        }
    });

    test('el cliente ve solo lo suyo', () => {
        assert.equal(visiblePara(doc(1), { rol: 'cliente', cliente_id: 1 }), true);
        assert.equal(visiblePara(doc(2), { rol: 'cliente', cliente_id: 1 }), false);
        assert.equal(visiblePara(doc('1'), { rol: 'cliente', cliente_id: 1 }), true, 'tolera ids como texto');
    });

    test('un documento sin cliente no lo ve ningun cliente, ni uno sin cliente_id', () => {
        assert.equal(visiblePara(doc(null), { rol: 'cliente', cliente_id: 1 }), false);
        assert.equal(visiblePara(doc(null), { rol: 'cliente', cliente_id: null }), false);
        assert.equal(visiblePara(doc(1), { rol: 'cliente', cliente_id: null }), false);
        assert.equal(visiblePara(doc(1), { rol: 'cliente' }), false);
    });

    test('el mecanico y los roles desconocidos nunca ven nada', () => {
        assert.equal(visiblePara(doc(1), { rol: 'mecanico', cliente_id: 1 }), false);
        assert.equal(visiblePara(doc(1), { rol: 'otro' }), false);
        assert.equal(visiblePara(doc(1), null), false);
    });
});

describe('construirSqlDocumentos', () => {
    test('para el cliente filtra por su cliente en las tres ramas y por la fecha de la migracion 010', () => {
        const sql = construirSqlDocumentos({ rol: 'cliente' });
        assert.equal((sql.match(/g\.cliente_id = \$2/g) || []).length, 1, 'rama de guias');
        assert.match(sql, /ot\.cliente_id = \$2/);
        assert.match(sql, /COALESCE\(f\.cliente_id, ot\.cliente_id\) = \$2/);
        assert.match(sql, /g\.created_at >= \$3/);
        assert.match(sql, /gr\.created_at >= \$3/);
        assert.doesNotMatch(sql, /\$2::int IS NULL/);
    });

    test('para administrativo el filtro por cliente es opcional', () => {
        const sql = construirSqlDocumentos({ rol: 'administrativo' });
        assert.equal((sql.match(/\$2::int IS NULL OR/g) || []).length, 3);
        assert.doesNotMatch(sql, /\$3/);
    });
});

describe('filaPublica', () => {
    const fila = {
        tipo: 'orden_trabajo', id: 5, archivo_url: 'ruta/privada.pdf', valorizacion: '1500', fecha_cierre: null, cliente_id: 1,
    };

    test('nunca deja la ruta del archivo y reemplaza por la URL firmada', () => {
        const r = filaPublica({ ...fila, tipo: 'factura' }, { rol: 'administrativo', urlFirmada: 'https://f.test/x' });
        assert.equal(r.archivo_url, undefined);
        assert.equal(r.url, 'https://f.test/x');
    });

    test('el cliente no ve la valorizacion de una OT; administrativo si', () => {
        assert.equal('valorizacion' in filaPublica(fila, { rol: 'cliente' }), false);
        assert.equal(filaPublica(fila, { rol: 'gerente' }).valorizacion, 1500);
    });
});
