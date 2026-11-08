const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ErrorLimite, crearLimitador, normalizarTexto, simplificarACalle, interpretarSugerencias, buscarDirecciones, MAX_SUGERENCIAS,
} = require('../src/services/geocodificar');

const feature = (label, lng, lat) => ({ properties: { label }, geometry: { coordinates: [lng, lat] } });

test('normalizarTexto: recorta, junta espacios y exige entre 3 y 120 letras', () => {
    assert.equal(normalizarTexto('  Av.   Providencia \n 1234 '), 'Av. Providencia 1234');
    assert.equal(normalizarTexto('ab'), null);
    assert.equal(normalizarTexto('   '), null);
    assert.equal(normalizarTexto('x'.repeat(121)), null);
    assert.equal(normalizarTexto(undefined), null);
    assert.equal(normalizarTexto(['a', 'b']), null);
    assert.equal(normalizarTexto('Calle\u0000Uno'), 'Calle Uno');
});

test('interpretarSugerencias: [longitud, latitud] de GeoJSON, sin repetidas ni invalidas', () => {
    const r = interpretarSugerencias({
        features: [
            feature('Av. Providencia 1234, Providencia, Chile', -70.61, -33.42),
            feature('Av. Providencia 1234, Providencia, Chile', -70.61, -33.42), // repetida
            feature('', -70.6, -33.4), // sin etiqueta
            feature('Fuera de rango', -70.6, -95),
            { properties: { label: 'Sin geometria' } },
            feature('Otra calle 5, Santiago, Chile', -70.65, -33.45),
        ],
    });
    assert.deepEqual(r.map((x) => x.etiqueta), ['Av. Providencia 1234, Providencia, Chile', 'Otra calle 5, Santiago, Chile']);
    assert.equal(r[0].latitud, -33.42);
    assert.equal(r[0].longitud, -70.61);
});

test('interpretarSugerencias: devuelve como maximo el tope y una respuesta rara es un error', () => {
    const muchas = { features: Array.from({ length: 20 }, (_, i) => feature(`Calle ${i}`, -70 - i / 100, -33)) };
    assert.equal(interpretarSugerencias(muchas).length, MAX_SUGERENCIAS);
    assert.deepEqual(interpretarSugerencias({ features: [] }), []);
    assert.throws(() => interpretarSugerencias({}), (e) => e.tipo === 'respuesta');
    assert.throws(() => interpretarSugerencias(null), (e) => e.tipo === 'respuesta');
});

test('buscarDirecciones: arma la consulta (solo Chile, llave en el encabezado y no en la URL) y devuelve sugerencias', async () => {
    let visto = null;
    const fetchFn = async (url, opciones) => {
        visto = { url: String(url), opciones };
        return { ok: true, status: 200, json: async () => ({ features: [feature('Av. Uno 1, Chile', -70.6, -33.4)] }) };
    };
    const r = await buscarDirecciones('Av. Uno 1', { fetchFn, llave: 'llave-de-prueba', baseUrl: 'https://geo.test/ors' });
    assert.equal(r.length, 1);
    const u = new URL(visto.url);
    assert.equal(u.pathname, '/ors/autocomplete');
    assert.equal(u.searchParams.get('text'), 'Av. Uno 1');
    assert.equal(u.searchParams.get('boundary.country'), 'CL');
    assert.equal(visto.opciones.headers.Authorization, 'llave-de-prueba');
    assert.ok(!visto.url.includes('llave-de-prueba'), 'la llave no viaja en la URL');
});

test('buscarDirecciones: sin llave, cupo, servidor caido, timeout y respuesta rota dan el tipo de error correcto', async () => {
    const siempre = (estado) => async () => ({ ok: false, status: estado, json: async () => ({}) });
    await assert.rejects(buscarDirecciones('abc', { llave: '' }), (e) => e.tipo === 'sin_llave');
    await assert.rejects(buscarDirecciones('abc', { llave: 'k', fetchFn: siempre(403) }), (e) => e.tipo === 'auth_o_cuota');
    await assert.rejects(buscarDirecciones('abc', { llave: 'k', fetchFn: siempre(429) }), (e) => e.tipo === 'limite_minuto');
    await assert.rejects(buscarDirecciones('abc', { llave: 'k', fetchFn: siempre(503) }), (e) => e.tipo === 'servidor');
    await assert.rejects(buscarDirecciones('abc', { llave: 'k', fetchFn: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } }), (e) => e.tipo === 'timeout');
    await assert.rejects(buscarDirecciones('abc', { llave: 'k', fetchFn: async () => { throw new Error('sin red'); } }), (e) => e.tipo === 'red');
    await assert.rejects(buscarDirecciones('abc', { llave: 'k', fetchFn: async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } }) }), (e) => e.tipo === 'respuesta');
});

test('limitador: tope por usuario y minuto, y tope diario que se reinicia al cambiar el dia', () => {
    const l = crearLimitador({ porUsuarioMinuto: 3, diario: 5 });
    const t0 = Date.UTC(2026, 10, 8, 12, 0, 0);
    assert.ok(l.intentar('a', t0).ok);
    assert.ok(l.intentar('a', t0 + 1000).ok);
    assert.ok(l.intentar('a', t0 + 2000).ok);
    assert.deepEqual(l.intentar('a', t0 + 3000), { ok: false, motivo: 'usuario_minuto' });
    assert.ok(l.intentar('b', t0 + 3000).ok, 'otro usuario no se ve afectado');
    assert.ok(l.intentar('a', t0 + 61_000).ok, 'pasado el minuto vuelve a poder');
    // ya van 5 en el dia: el siguiente, de cualquiera, es rechazado
    assert.deepEqual(l.intentar('c', t0 + 62_000), { ok: false, motivo: 'diario' });
    // al dia siguiente se reinicia
    assert.ok(l.intentar('c', t0 + 24 * 3600_000).ok);
});

test('simplificarACalle: deja solo la calle, expande Av. y no toca rutas ni textos que no cambian', () => {
    assert.equal(simplificarACalle('Av. Apoquindo 4500, Las Condes'), 'Avenida Apoquindo');
    assert.equal(simplificarACalle('Camino a Rinconada 500, Maipu'), 'Camino a Rinconada');
    assert.equal(simplificarACalle('Los Leones #45, Providencia'), 'Los Leones');
    assert.equal(simplificarACalle('Pedro de Valdivia N° 123'), 'Pedro de Valdivia');
    assert.equal(simplificarACalle('Calle Uno s/n'), 'Calle Uno');
    assert.equal(simplificarACalle('Avenida Providencia'), null, 'ya es solo la calle');
    assert.equal(simplificarACalle('Ruta 5 Sur km 20'), null, 'en una ruta el numero es la direccion');
    assert.equal(simplificarACalle('ab 12'), null);
});

// proveedor falso: responde segun la ruta y el texto consultado y anota cada consulta
function proveedor(respuestas) {
    const llamadas = [];
    const fetchFn = async (url) => {
        const u = new URL(String(url));
        const clave = `${u.pathname.split('/').pop()}|${u.searchParams.get('text')}`;
        llamadas.push(clave);
        const features = (respuestas[clave] || []).map(([l, lng, lat]) => feature(l, lng, lat));
        return { ok: true, status: 200, json: async () => ({ features }) };
    };
    return { fetchFn, llamadas };
}

test('respaldo: si el texto completo no da resultados se prueba solo la calle y sale como aproximada', async () => {
    const p = proveedor({ 'autocomplete|Avenida Apoquindo': [['Avenida Apoquindo, Santiago, RM, Chile', -70.58, -33.41]] });
    const r = await buscarDirecciones('Av. Apoquindo 4500, Las Condes', { fetchFn: p.fetchFn, llave: 'k' });
    assert.deepEqual(p.llamadas, ['autocomplete|Av. Apoquindo 4500, Las Condes', 'autocomplete|Avenida Apoquindo']);
    assert.equal(r.length, 1);
    assert.equal(r[0].aproximada, true);
});

test('respaldo: con resultados al primer intento no se hacen mas consultas y no es aproximada', async () => {
    const p = proveedor({ 'autocomplete|Av. Providencia': [['Av Providencia, Santiago, RM, Chile', -70.61, -33.42]] });
    const r = await buscarDirecciones('Av. Providencia', { fetchFn: p.fetchFn, llave: 'k' });
    assert.equal(p.llamadas.length, 1);
    assert.equal(r[0].aproximada, false);
});

test('respaldo: sin calle que simplificar o sin resultados cae a la busqueda completa; todo vacio da lista vacia', async () => {
    const p = proveedor({ 'search|Zzz 12, Aaa': [['Aaa, RM, Chile', -70.1, -33.1]] });
    const r = await buscarDirecciones('Zzz 12, Aaa', { fetchFn: p.fetchFn, llave: 'k' });
    assert.deepEqual(p.llamadas, ['autocomplete|Zzz 12, Aaa', 'autocomplete|Zzz', 'search|Zzz 12, Aaa']);
    assert.equal(r[0].aproximada, true);
    const vacio = proveedor({});
    assert.deepEqual(await buscarDirecciones('Nada de nada', { fetchFn: vacio.fetchFn, llave: 'k' }), []);
    assert.equal(vacio.llamadas.length, 2, 'sin numero no hay paso por calle: autocompletar y buscar');
});

test('antesDeConsultar se llama por cada consulta real y puede cortar la busqueda con ErrorLimite', async () => {
    const p = proveedor({});
    let veces = 0;
    await buscarDirecciones('Calle 12, Aaa', { fetchFn: p.fetchFn, llave: 'k', antesDeConsultar: () => { veces += 1; } });
    assert.equal(veces, p.llamadas.length);
    assert.equal(veces, 3);
    const q = proveedor({});
    await assert.rejects(
        buscarDirecciones('Calle 12, Aaa', {
            fetchFn: q.fetchFn, llave: 'k',
            antesDeConsultar: () => { if (q.llamadas.length >= 1) throw new ErrorLimite('usuario_minuto'); },
        }),
        (e) => e instanceof ErrorLimite && e.motivo === 'usuario_minuto'
    );
    assert.equal(q.llamadas.length, 1, 'no se consulta al proveedor una vez que el limite corta');
});
