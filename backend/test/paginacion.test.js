const { test, describe } = require('node:test');
const assert = require('node:assert');

const { LIMITE_MAXIMO, parsearPaginacion, parsearBusqueda, envolver } = require('../src/utils/paginacion');

describe('parsearPaginacion', () => {
    test('sin limite trae todo: lo necesitan los selectores y el catalogo offline', () => {
        assert.deepStrictEqual(parsearPaginacion({}), { limit: null, offset: 0 });
        assert.deepStrictEqual(parsearPaginacion({ limit: '' }), { limit: null, offset: 0 });
    });

    test('lee limit y offset validos', () => {
        assert.deepStrictEqual(parsearPaginacion({ limit: '50', offset: '100' }), { limit: 50, offset: 100 });
    });

    test('acota el limite para que nadie anule la paginacion', () => {
        assert.strictEqual(parsearPaginacion({ limit: '999999' }).limit, LIMITE_MAXIMO);
    });

    test('valores basura no rompen: se comportan como sin limite', () => {
        assert.deepStrictEqual(parsearPaginacion({ limit: 'abc' }), { limit: null, offset: 0 });
        assert.deepStrictEqual(parsearPaginacion({ limit: '-5' }), { limit: null, offset: 0 });
        assert.strictEqual(parsearPaginacion({ offset: '-10' }).offset, 0);
        assert.strictEqual(parsearPaginacion({ offset: 'x' }).offset, 0);
    });

    test('un limite decimal se trunca', () => {
        assert.strictEqual(parsearPaginacion({ limit: '10.9' }).limit, 10);
    });
});

describe('parsearBusqueda', () => {
    test('devuelve el texto sin espacios sobrantes', () => {
        assert.strictEqual(parsearBusqueda({ q: '  GH-042 ' }), 'GH-042');
    });

    test('vacio o ausente es null', () => {
        assert.strictEqual(parsearBusqueda({}), null);
        assert.strictEqual(parsearBusqueda({ q: '   ' }), null);
        assert.strictEqual(parsearBusqueda({ q: null }), null);
    });
});

describe('envolver', () => {
    test('sin limite nunca hay mas', () => {
        const r = envolver([1, 2, 3], 3, { limit: null, offset: 0 });
        assert.deepStrictEqual(r, { items: [1, 2, 3], total: 3, hay_mas: false });
    });

    test('con limite avisa que falta cargar', () => {
        // 50 de 500 traidos desde el inicio: quedan 450
        const r = envolver(new Array(50).fill(0), 500, { limit: 50, offset: 0 });
        assert.strictEqual(r.hay_mas, true);
        assert.strictEqual(r.total, 500);
    });

    test('la ultima pagina no dice que hay mas', () => {
        const r = envolver(new Array(20).fill(0), 100, { limit: 50, offset: 80 });
        assert.strictEqual(r.hay_mas, false);
    });

    test('el total es el del filtro, no el de la pagina', () => {
        // es lo que permite mostrar "45 de 500" en la pantalla
        assert.strictEqual(envolver([1], 500, { limit: 1, offset: 0 }).total, 500);
    });

    test('tolera entradas invalidas', () => {
        assert.deepStrictEqual(envolver(null, null), { items: [], total: 0, hay_mas: false });
    });
});
