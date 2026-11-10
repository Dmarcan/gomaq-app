const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { parsearNumeroInterno, parsearGuia } = require('../src/utils/parsearDocumento');
const { elegirEquipo, numeroDelCodigo } = require('../src/utils/detectarEquipo');

const fixture = (nombre) => fs.readFileSync(path.join(__dirname, 'fixtures', nombre), 'utf8');
const GUIA_DESPACHO = fixture('guia_despacho.txt');
const GUIA_RETIRO = fixture('guia_retiro.txt');
const FACTURA = fixture('factura.txt');

describe('parsearNumeroInterno', () => {
    test('lee el numero interno de las guias reales, sin ceros a la izquierda', () => {
        assert.strictEqual(parsearNumeroInterno(GUIA_DESPACHO), '807');
        assert.strictEqual(parsearNumeroInterno(GUIA_RETIRO), '807');
        assert.strictEqual(parsearNumeroInterno(FACTURA), '506');
    });

    test('acepta las variantes del signo de numero', () => {
        assert.strictEqual(parsearNumeroInterno('Nº INTERNO: 0042'), '42');
        assert.strictEqual(parsearNumeroInterno('N INTERNO 1310'), '1310');
        assert.strictEqual(parsearNumeroInterno('No. interno: 7'), '7');
    });

    test('no confunde otros numeros del documento', () => {
        assert.strictEqual(parsearNumeroInterno('Orden Compra N° 10104 del 2026-07-13'), null);
        assert.strictEqual(parsearNumeroInterno('orden interno: 123'), null);
        assert.strictEqual(parsearNumeroInterno('N° INTERNO: 0000'), null);
        assert.strictEqual(parsearNumeroInterno(''), null);
        assert.strictEqual(parsearNumeroInterno(null), null);
    });

    test('parsearGuia lo entrega junto al resto', () => {
        assert.strictEqual(parsearGuia(GUIA_DESPACHO).numero_interno_detectado, '807');
    });
});

describe('numeroDelCodigo', () => {
    test('toma el numero final del codigo', () => {
        assert.strictEqual(numeroDelCodigo('PL-807'), '807');
        assert.strictEqual(numeroDelCodigo('GH-0506'), '506');
        assert.strictEqual(numeroDelCodigo('AP-1501'), '1501');
        assert.strictEqual(numeroDelCodigo('SINNUMERO'), null);
        assert.strictEqual(numeroDelCodigo(null), null);
    });
});

describe('elegirEquipo', () => {
    const FLOTA = [
        { id: 1, codigo: 'PL-807' },
        { id: 2, codigo: 'PL-506' },
        { id: 3, codigo: 'GH-1807' },
        { id: 4, codigo: 'BR-80' },
    ];

    test('encuentra el equipo por el numero interno, con o sin ceros', () => {
        assert.strictEqual(elegirEquipo('807', FLOTA).id, 1);
        assert.strictEqual(elegirEquipo('0807', FLOTA).id, 1);
        assert.strictEqual(elegirEquipo('506', FLOTA).id, 2);
    });

    test('exige el numero completo, no un trozo', () => {
        // 807 no es GH-1807 ni BR-80
        assert.strictEqual(elegirEquipo('1807', FLOTA).id, 3);
        assert.strictEqual(elegirEquipo('07', FLOTA), null);
    });

    test('con dos equipos del mismo numero no adivina', () => {
        const repetida = [...FLOTA, { id: 5, codigo: 'GH-807' }];
        assert.strictEqual(elegirEquipo('807', repetida), null);
    });

    test('sin numero o sin coincidencia devuelve null', () => {
        assert.strictEqual(elegirEquipo(null, FLOTA), null);
        assert.strictEqual(elegirEquipo('', FLOTA), null);
        assert.strictEqual(elegirEquipo('999', FLOTA), null);
        assert.strictEqual(elegirEquipo("1 OR 1=1", FLOTA), null);
    });
});
