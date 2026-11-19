const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ErrorOrs, hayLlave, tipoDeEstadoHttp, interpretarRespuesta, calcularRuta, BASE_URL_POR_DEFECTO } = require('../src/services/ors');

const origen = { latitud: -38.7359, longitud: -72.5904 };
const destino = { latitud: -38.70, longitud: -72.50 };
const LLAVE = 'llave-de-prueba-nunca-real';

/** fetch falso que guarda la peticion y devuelve lo que se le diga. */
function falso(respuesta) {
    const llamadas = [];
    const fetchFn = async (url, init) => {
        llamadas.push({ url, init });
        if (respuesta instanceof Error) throw respuesta;
        return respuesta;
    };
    return { fetchFn, llamadas };
}
const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const fallo = (status) => ({ ok: false, status, json: async () => ({}) });

describe('hayLlave', () => {
    test('vacia, en blanco o ausente no cuenta como llave', () => {
        assert.strictEqual(hayLlave({ ORS_API_KEY: '' }), false);
        assert.strictEqual(hayLlave({ ORS_API_KEY: '   ' }), false);
        assert.strictEqual(hayLlave({}), false);
        assert.strictEqual(hayLlave({ ORS_API_KEY: 'abc' }), true);
    });
});

describe('tipoDeEstadoHttp', () => {
    test('clasifica los codigos que importan', () => {
        assert.strictEqual(tipoDeEstadoHttp(401), 'auth_o_cuota');
        assert.strictEqual(tipoDeEstadoHttp(403), 'auth_o_cuota');
        assert.strictEqual(tipoDeEstadoHttp(429), 'limite_minuto');
        assert.strictEqual(tipoDeEstadoHttp(500), 'servidor');
        assert.strictEqual(tipoDeEstadoHttp(503), 'servidor');
        assert.strictEqual(tipoDeEstadoHttp(404), 'respuesta');
    });
});

describe('interpretarRespuesta', () => {
    test('lee distancia y duracion y las redondea', () => {
        const r = interpretarRespuesta({ routes: [{ summary: { distance: 13534.4, duration: 1069.6 } }] });
        assert.deepStrictEqual(r, { distancia_m: 13534, segundos: 1070 });
    });

    test('una respuesta mal formada es un error, nunca una ETA inventada', () => {
        for (const mala of [null, {}, { routes: [] }, { routes: [{}] }, { routes: [{ summary: {} }] },
            { routes: [{ summary: { distance: 'x', duration: 5 } }] },
            { routes: [{ summary: { distance: -1, duration: 5 } }] },
            { routes: [{ summary: { distance: 5, duration: NaN } }] },
            { routes: [{ summary: { distance: Infinity, duration: 5 } }] }]) {
            assert.throws(() => interpretarRespuesta(mala), (e) => e instanceof ErrorOrs && e.tipo === 'respuesta');
        }
    });
});

describe('calcularRuta', () => {
    test('arma la peticion como la espera ORS: dominio nuevo, llave sin Bearer y [longitud, latitud]', async () => {
        const { fetchFn, llamadas } = falso(ok({ routes: [{ summary: { distance: 5000, duration: 600 } }] }));
        const r = await calcularRuta(origen, destino, { fetchFn, llave: LLAVE });
        assert.deepStrictEqual(r, { distancia_m: 5000, segundos: 600 });

        const { url, init } = llamadas[0];
        assert.strictEqual(url, `${BASE_URL_POR_DEFECTO}/v2/directions/driving-car`);
        assert.ok(url.startsWith('https://api.heigit.org/'), 'no el dominio antiguo, que esta en desuso');
        assert.strictEqual(init.method, 'POST');
        assert.strictEqual(init.headers.Authorization, LLAVE, 'tal cual, sin Bearer');
        assert.deepStrictEqual(JSON.parse(init.body), { coordinates: [[-72.5904, -38.7359], [-72.5, -38.7]] }, 'ORS pide longitud primero');
        assert.ok(init.signal, 'lleva timeout');
    });

    test('sin llave no llama a nadie', async () => {
        const { fetchFn, llamadas } = falso(ok({}));
        // con `llave: undefined` se lee ORS_API_KEY del entorno: se quita para no depender de un .env real
        const llaveEntorno = process.env.ORS_API_KEY;
        delete process.env.ORS_API_KEY;
        try {
            for (const llave of [undefined, '', '   ']) {
                await assert.rejects(calcularRuta(origen, destino, { fetchFn, llave }), (e) => e.tipo === 'sin_llave');
            }
        } finally {
            if (llaveEntorno !== undefined) process.env.ORS_API_KEY = llaveEntorno;
        }
        assert.strictEqual(llamadas.length, 0);
    });

    test('cada fallo del servicio se convierte en un ErrorOrs con su tipo', async () => {
        const casos = [[403, 'auth_o_cuota'], [429, 'limite_minuto'], [502, 'servidor'], [400, 'respuesta']];
        for (const [status, tipo] of casos) {
            await assert.rejects(
                calcularRuta(origen, destino, { fetchFn: falso(fallo(status)).fetchFn, llave: LLAVE }),
                (e) => e instanceof ErrorOrs && e.tipo === tipo && e.estadoHttp === status, `HTTP ${status}`);
        }
    });

    test('timeout y caida de red se distinguen', async () => {
        const tiempo = Object.assign(new Error('x'), { name: 'TimeoutError' });
        await assert.rejects(calcularRuta(origen, destino, { fetchFn: falso(tiempo).fetchFn, llave: LLAVE }), (e) => e.tipo === 'timeout');
        await assert.rejects(calcularRuta(origen, destino, { fetchFn: falso(new TypeError('fetch failed')).fetchFn, llave: LLAVE }), (e) => e.tipo === 'red');
    });

    test('una respuesta que no es JSON es un error', async () => {
        const noJson = { ok: true, status: 200, json: async () => { throw new SyntaxError('no es json'); } };
        await assert.rejects(calcularRuta(origen, destino, { fetchFn: falso(noJson).fetchFn, llave: LLAVE }), (e) => e.tipo === 'respuesta');
    });

    test('la llave nunca aparece en los mensajes de error', async () => {
        const casos = [fallo(403), fallo(500), new TypeError(`fetch failed ${LLAVE}`), Object.assign(new Error(LLAVE), { name: 'TimeoutError' })];
        for (const caso of casos) {
            try {
                await calcularRuta(origen, destino, { fetchFn: falso(caso).fetchFn, llave: LLAVE });
                assert.fail('debia fallar');
            } catch (e) {
                assert.ok(!String(e.message).includes(LLAVE), `el mensaje filtra la llave: ${e.message}`);
                assert.ok(!JSON.stringify(e).includes(LLAVE));
            }
        }
    });
});
