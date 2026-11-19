const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { elegirDestino, ORIGENES } = require('../src/utils/destinoOt');

const solicitud = { latitud: '-38.700000', longitud: '-72.500000' };
const guia = { latitud: '-38.710000', longitud: '-72.510000' };
const cliente = { latitud: '-38.720000', longitud: '-72.520000' };

describe('elegirDestino', () => {
    test('la solicitud manda sobre la guia y el cliente', () => {
        assert.deepStrictEqual(elegirDestino({ solicitud, guia, cliente }), { latitud: -38.7, longitud: -72.5, origen: 'solicitud' });
    });

    test('sin coordenadas en la solicitud se usa la guia vigente', () => {
        const r = elegirDestino({ solicitud: { latitud: null, longitud: null }, guia, cliente });
        assert.deepStrictEqual(r, { latitud: -38.71, longitud: -72.51, origen: 'guia' });
    });

    test('sin solicitud ni guia se usa la ubicacion del cliente', () => {
        assert.deepStrictEqual(elegirDestino({ cliente }), { latitud: -38.72, longitud: -72.52, origen: 'cliente' });
    });

    test('una fuente con solo una coordenada se salta, no se usa a medias', () => {
        const r = elegirDestino({ solicitud: { latitud: '-38.7', longitud: null }, cliente });
        assert.strictEqual(r.origen, 'cliente');
    });

    test('un valor corrupto en la base se salta en vez de romper', () => {
        const r = elegirDestino({ solicitud: { latitud: 'abc', longitud: 'def' }, guia });
        assert.strictEqual(r.origen, 'guia');
    });

    test('ninguna fuente con coordenadas devuelve null: la OT sigue valida, sin ruta ni ETA', () => {
        assert.strictEqual(elegirDestino({}), null);
        assert.strictEqual(elegirDestino(), null);
        assert.strictEqual(elegirDestino({ solicitud: null, guia: null, cliente: { latitud: null, longitud: null } }), null);
    });

    test('el origen siempre es uno de los valores que acepta la base', () => {
        for (const fuentes of [{ solicitud }, { guia }, { cliente }]) {
            assert.ok(ORIGENES.includes(elegirDestino(fuentes).origen));
        }
    });
});
