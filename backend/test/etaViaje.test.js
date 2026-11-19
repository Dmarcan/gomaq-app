const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ajustarEta, calcularQuietoDesde } = require('../src/utils/etaViaje');
const { distanciaMetros } = require('../src/utils/geo');

const ahora = new Date('2026-11-08T12:00:00.000Z');
const destino = { latitud: -38.7359, longitud: -72.5904 };
// a lo largo de una linea este-oeste: 0,1 grados de longitud son unos 8,7 km a esta latitud
const al = (grados) => ({ latitud: -38.7359, longitud: -72.5904 + grados });
const seg = (s) => new Date(ahora.getTime() + s * 1000);

describe('ajustarEta', () => {
    test('a mitad del camino quedan la mitad de los segundos de la consulta', () => {
        const origenConsulta = al(0.2);
        const posicion = al(0.1);
        const r = ajustarEta({ etaSegundos: 1200, origenConsulta, destino, posicion, capturadaEn: ahora, ahora });
        assert.strictEqual(r.metodo, 'proporcional');
        const esperado = Math.round(1200 * distanciaMetros(posicion, destino) / distanciaMetros(origenConsulta, destino));
        assert.strictEqual(r.segundosRestantes, esperado);
        assert.ok(Math.abs(r.segundosRestantes - 600) < 5);
        assert.strictEqual(r.llegadaAt.getTime(), seg(r.segundosRestantes).getTime());
    });

    test('quieto en el mismo punto: la hora de llegada se corre con la captura, no se congela', () => {
        const origenConsulta = al(0.2);
        const posicion = al(0.1);
        const a = ajustarEta({ etaSegundos: 1200, origenConsulta, destino, posicion, capturadaEn: ahora, ahora });
        const despues = new Date(ahora.getTime() + 5 * 60 * 1000);
        const b = ajustarEta({ etaSegundos: 1200, origenConsulta, destino, posicion, capturadaEn: despues, ahora: despues });
        assert.strictEqual(b.segundosRestantes, a.segundosRestantes);
        assert.strictEqual(b.llegadaAt.getTime() - a.llegadaAt.getTime(), 5 * 60 * 1000);
    });

    test('a menos de 150 m quedan 60 segundos', () => {
        const r = ajustarEta({ etaSegundos: 1200, origenConsulta: al(0.2), destino, posicion: al(0.001), capturadaEn: ahora, ahora });
        assert.strictEqual(r.metodo, 'casi_llegado');
        assert.strictEqual(r.segundosRestantes, 60);
    });

    test('un tramo de consulta menor a 1 km usa la aproximada', () => {
        const r = ajustarEta({ etaSegundos: 100, origenConsulta: al(0.005), destino, posicion: al(0.004), capturadaEn: ahora, ahora });
        assert.strictEqual(r.metodo, 'aproximada');
    });

    test('si se desvio (mas lejos que 1,3 veces la distancia de la consulta) usa la aproximada', () => {
        const r = ajustarEta({ etaSegundos: 600, origenConsulta: al(0.1), destino, posicion: al(0.2), capturadaEn: ahora, ahora });
        assert.strictEqual(r.metodo, 'aproximada');
    });

    test('la hora de llegada nunca queda en el pasado: al menos ahora mas 60 s', () => {
        const vieja = new Date(ahora.getTime() - 60 * 60 * 1000);
        const r = ajustarEta({ etaSegundos: 600, origenConsulta: al(0.2), destino, posicion: al(0.1), capturadaEn: vieja, ahora });
        assert.strictEqual(r.llegadaAt.getTime(), seg(60).getTime());
    });

    test('sin datos devuelve null', () => {
        assert.strictEqual(ajustarEta({ etaSegundos: null, origenConsulta: al(0.2), destino, posicion: al(0.1), capturadaEn: ahora, ahora }), null);
        assert.strictEqual(ajustarEta({ etaSegundos: 600, origenConsulta: null, destino, posicion: al(0.1), capturadaEn: ahora, ahora }), null);
        assert.strictEqual(ajustarEta({ etaSegundos: 600, origenConsulta: al(0.2), destino: null, posicion: al(0.1), capturadaEn: ahora, ahora }), null);
    });
});

describe('calcularQuietoDesde', () => {
    const previa = (extra = {}) => ({
        orden_trabajo_id: 7, latitud: '-38.735900', longitud: '-72.590400',
        capturada_en: new Date('2026-11-08T11:50:00.000Z'), quieto_desde: null, ...extra,
    });
    const nueva = (extra = {}) => ({ latitud: -38.7359, longitud: -72.5904, capturadaEn: ahora, precisionM: 10, ordenId: 7, ...extra });

    test('la primera posicion del viaje parte de su propia hora', () => {
        assert.strictEqual(calcularQuietoDesde(null, nueva()).getTime(), ahora.getTime());
    });

    test('una posicion de otro viaje reinicia', () => {
        assert.strictEqual(calcularQuietoDesde(previa({ orden_trabajo_id: 3 }), nueva()).getTime(), ahora.getTime());
    });

    test('en el mismo punto conserva la hora desde la que estaba quieto', () => {
        const desde = new Date('2026-11-08T11:40:00.000Z');
        assert.strictEqual(calcularQuietoDesde(previa({ quieto_desde: desde }), nueva()).getTime(), desde.getTime());
    });

    test('sin quieto_desde guardado usa la hora de la posicion anterior', () => {
        assert.strictEqual(calcularQuietoDesde(previa(), nueva()).getTime(), new Date('2026-11-08T11:50:00.000Z').getTime());
    });

    test('un movimiento menor a 75 m (ruido del GPS) no reinicia', () => {
        const cercana = nueva({ longitud: -72.5904 + 0.0004 }); // ~35 m
        assert.strictEqual(calcularQuietoDesde(previa(), cercana).getTime(), new Date('2026-11-08T11:50:00.000Z').getTime());
    });

    test('un movimiento mayor al umbral reinicia', () => {
        const lejos = nueva({ longitud: -72.5904 + 0.005 }); // ~430 m
        assert.strictEqual(calcularQuietoDesde(previa(), lejos).getTime(), ahora.getTime());
    });

    test('con mala precision el umbral sube a la precision', () => {
        const medio = nueva({ longitud: -72.5904 + 0.002, precisionM: 400 }); // ~170 m, dentro de 400 m
        assert.strictEqual(calcularQuietoDesde(previa(), medio).getTime(), new Date('2026-11-08T11:50:00.000Z').getTime());
    });
});
