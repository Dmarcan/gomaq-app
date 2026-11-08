const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
    validarCoordenadas,
    validarCoordenadasFormulario,
    coordenadasDeFila,
    distanciaMetros,
    etaAproximada,
    evaluarCapturadaEn,
    TOLERANCIA_FUTURO_MS,
    ANTIGUEDAD_MAXIMA_MS,
} = require('../src/utils/geo');

describe('validarCoordenadas', () => {
    test('un par valido se acepta y se redondea a 6 decimales', () => {
        const r = validarCoordenadas(-38.73591234567, -72.59041234567);
        assert.deepStrictEqual(r, { ok: true, presente: true, latitud: -38.735912, longitud: -72.590412 });
    });

    test('sin ninguna de las dos significa "sin ubicacion", no es un error', () => {
        assert.deepStrictEqual(validarCoordenadas(undefined, undefined), { ok: true, presente: false, latitud: null, longitud: null });
        assert.strictEqual(validarCoordenadas(null, null).presente, false);
    });

    test('una sola coordenada se rechaza', () => {
        assert.strictEqual(validarCoordenadas(-38.7, undefined).ok, false);
        assert.strictEqual(validarCoordenadas(null, -72.5).ok, false);
    });

    test('strings, NaN e infinitos se rechazan', () => {
        assert.strictEqual(validarCoordenadas('-38.7', '-72.5').ok, false);
        assert.strictEqual(validarCoordenadas(NaN, -72.5).ok, false);
        assert.strictEqual(validarCoordenadas(-38.7, Infinity).ok, false);
        assert.strictEqual(validarCoordenadas({}, []).ok, false);
    });

    test('fuera de rango se rechaza, los limites exactos se aceptan', () => {
        assert.strictEqual(validarCoordenadas(90.0001, 0).ok, false);
        assert.strictEqual(validarCoordenadas(0, -180.0001).ok, false);
        assert.strictEqual(validarCoordenadas(90, 180).ok, true);
        assert.strictEqual(validarCoordenadas(-90, -180).ok, true);
    });

    test('el cero es una coordenada valida, no "falta"', () => {
        const r = validarCoordenadas(0, 0);
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.presente, true);
    });
});

describe('validarCoordenadasFormulario', () => {
    test('convierte strings numericos, porque un multipart manda todo como texto', () => {
        const r = validarCoordenadasFormulario('-38.7359', '-72.5904');
        assert.deepStrictEqual(r, { ok: true, presente: true, latitud: -38.7359, longitud: -72.5904 });
    });

    test('vacio o ausente significa "no vino"', () => {
        assert.strictEqual(validarCoordenadasFormulario('', '').presente, false);
        assert.strictEqual(validarCoordenadasFormulario(undefined, undefined).presente, false);
        assert.strictEqual(validarCoordenadasFormulario('  ', ' ').presente, false);
    });

    test('texto no numerico, notacion rara y un solo valor se rechazan', () => {
        assert.strictEqual(validarCoordenadasFormulario('abc', '-72.5').ok, false);
        assert.strictEqual(validarCoordenadasFormulario('1e2', '5').ok, false);
        assert.strictEqual(validarCoordenadasFormulario('0x10', '5').ok, false);
        assert.strictEqual(validarCoordenadasFormulario('-38.7', '').ok, false);
    });

    test('fuera de rango tambien se rechaza', () => {
        assert.strictEqual(validarCoordenadasFormulario('91', '0').ok, false);
    });
});

describe('coordenadasDeFila', () => {
    test('acepta NUMERIC como string, tal como lo entrega pg', () => {
        assert.deepStrictEqual(coordenadasDeFila({ latitud: '-38.735900', longitud: '-72.590400' }), { latitud: -38.7359, longitud: -72.5904 });
    });

    test('null si falta alguna, la fila es null o el valor no es numerico', () => {
        assert.strictEqual(coordenadasDeFila(null), null);
        assert.strictEqual(coordenadasDeFila({ latitud: null, longitud: '-72.5' }), null);
        assert.strictEqual(coordenadasDeFila({ latitud: 'abc', longitud: '-72.5' }), null);
        assert.strictEqual(coordenadasDeFila({}), null);
    });

    test('permite nombres de campo distintos (destino_lat / destino_lng)', () => {
        const r = coordenadasDeFila({ destino_lat: '-38.7', destino_lng: '-72.5' }, 'destino_lat', 'destino_lng');
        assert.deepStrictEqual(r, { latitud: -38.7, longitud: -72.5 });
    });
});

describe('distanciaMetros', () => {
    test('el mismo punto esta a cero', () => {
        const p = { latitud: -38.7359, longitud: -72.5904 };
        assert.strictEqual(distanciaMetros(p, p), 0);
    });

    test('Santiago a Rancagua queda cerca de 80 km en linea recta', () => {
        const santiago = { latitud: -33.4489, longitud: -70.6693 };
        const rancagua = { latitud: -34.1708, longitud: -70.7444 };
        const km = distanciaMetros(santiago, rancagua) / 1000;
        assert.ok(km > 78 && km < 82, `se esperaba ~80 km y dio ${km}`);
    });

    test('es simetrica', () => {
        const a = { latitud: -38.7359, longitud: -72.5904 };
        const b = { latitud: -38.7, longitud: -72.5 };
        assert.strictEqual(distanciaMetros(a, b), distanciaMetros(b, a));
    });
});

describe('etaAproximada', () => {
    test('corrige la linea recta por el factor de camino y usa 40 km/h', () => {
        const origen = { latitud: -38.7359, longitud: -72.5904 };
        const destino = { latitud: -38.7359, longitud: -72.5904 + 0.0113 }; // ~1 km al este
        const directa = distanciaMetros(origen, destino);
        const r = etaAproximada(origen, destino);
        assert.strictEqual(r.distancia_m, Math.round(directa * 1.4));
        assert.strictEqual(r.segundos, Math.round((r.distancia_m / 1000 / 40) * 3600));
    });

    test('mismo punto: cero distancia y cero segundos', () => {
        const p = { latitud: -38.7, longitud: -72.5 };
        assert.deepStrictEqual(etaAproximada(p, p), { distancia_m: 0, segundos: 0 });
    });
});

describe('evaluarCapturadaEn', () => {
    const ahora = new Date('2026-11-08T12:00:00.000Z');
    const hace = (ms) => new Date(ahora.getTime() - ms).toISOString();

    test('una hora reciente se acepta', () => {
        const r = evaluarCapturadaEn(hace(30 * 1000), ahora);
        assert.strictEqual(r.ok, true);
        assert.ok(r.fecha instanceof Date);
    });

    test('una hora en el futuro dentro de la tolerancia se acepta', () => {
        assert.strictEqual(evaluarCapturadaEn(hace(-(TOLERANCIA_FUTURO_MS - 1000)), ahora).ok, true);
    });

    test('una hora muy en el futuro se rechaza: un reloj adelantado bloquearia las siguientes', () => {
        assert.deepStrictEqual(evaluarCapturadaEn(hace(-(TOLERANCIA_FUTURO_MS + 1000)), ahora), { ok: false, motivo: 'futura' });
    });

    test('una posicion muy vieja se rechaza', () => {
        assert.deepStrictEqual(evaluarCapturadaEn(hace(ANTIGUEDAD_MAXIMA_MS + 1000), ahora), { ok: false, motivo: 'antigua' });
    });

    test('vacio o basura es invalido', () => {
        for (const v of [undefined, null, '', 'ayer', {}]) {
            assert.deepStrictEqual(evaluarCapturadaEn(v, ahora), { ok: false, motivo: 'invalida' });
        }
    });
});
