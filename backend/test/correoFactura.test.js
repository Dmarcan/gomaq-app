const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { formatearDia, textoPorDefecto, validarTexto, validarFolio, MAX_ASUNTO, MAX_CUERPO } = require('../src/utils/correoFactura');

describe('formatearDia', () => {
    test('convierte YYYY-MM-DD a dd-mm-aaaa', () => {
        assert.equal(formatearDia('2026-03-05'), '05-03-2026');
        assert.equal(formatearDia('2026-12-31T00:00:00.000Z'), '31-12-2026');
    });
    test('un valor vacio o invalido da null', () => {
        assert.equal(formatearDia(null), null);
        assert.equal(formatearDia(''), null);
        assert.equal(formatearDia('ayer'), null);
    });
});

describe('textoPorDefecto', () => {
    test('factura de reparacion sin periodo', () => {
        const t = textoPorDefecto({ folio: 'F-10', orden_trabajo_id: 7, cliente_nombre: 'Acsa' });
        assert.equal(t.asunto, 'Factura folio F-10 · Orden de trabajo #7 · GOMAQ');
        assert.match(t.cuerpo, /Estimado\/a Acsa:/);
        assert.match(t.cuerpo, /orden de trabajo #7/);
        assert.doesNotMatch(t.cuerpo, /período/);
    });

    test('factura de arriendo con periodo en dd-mm-aaaa', () => {
        const t = textoPorDefecto({
            folio: 'F-11', maquinaria_codigo: 'GH-204', periodo_desde: '2026-09-02', periodo_hasta: '2026-10-05', cliente_nombre: null,
        });
        assert.equal(t.asunto, 'Factura folio F-11 · Arriendo equipo GH-204 · GOMAQ');
        assert.match(t.cuerpo, /arriendo del equipo GH-204/);
        assert.match(t.cuerpo, /período del 02-09-2026 al 05-10-2026/);
        assert.match(t.cuerpo, /Estimado\/a cliente:/);
    });

    test('sin orden ni equipo usa un concepto generico', () => {
        assert.match(textoPorDefecto({ folio: 'F-12' }).cuerpo, /su servicio/);
        assert.equal(textoPorDefecto({ folio: 'F-12' }).asunto, 'Factura folio F-12 · GOMAQ');
    });
});

describe('validarTexto', () => {
    const porDefecto = { asunto: 'Asunto base', cuerpo: 'Cuerpo base' };

    test('sin texto o vacio usa el texto por defecto', () => {
        assert.deepEqual(validarTexto({}, porDefecto), porDefecto);
        assert.deepEqual(validarTexto(undefined, porDefecto), porDefecto);
        assert.deepEqual(validarTexto({ asunto: '   ', cuerpo: '' }, porDefecto), porDefecto);
    });

    test('recorta espacios y conserva lo editado', () => {
        const r = validarTexto({ asunto: '  Hola  ', cuerpo: ' Texto\ncon salto ' }, porDefecto);
        assert.equal(r.asunto, 'Hola');
        assert.equal(r.cuerpo, 'Texto\ncon salto');
    });

    test('el asunto no admite saltos de linea', () => {
        for (const asunto of ['Uno\nDos', 'Uno\r\nBcc: x@y.cl', 'Uno\rDos', 'Uno\u2028Dos', 'Uno\u2029Dos', 'Uno\u0085Dos', 'Uno\u000BDos', 'Uno\u0000Dos', 'Uno\u007FDos']) {
            assert.ok(validarTexto({ asunto }, porDefecto).error, JSON.stringify(asunto));
        }
    });

    test('topes de largo', () => {
        assert.ok(validarTexto({ asunto: 'a'.repeat(MAX_ASUNTO + 1) }, porDefecto).error);
        assert.ok(validarTexto({ cuerpo: 'c'.repeat(MAX_CUERPO + 1) }, porDefecto).error);
        assert.ok(!validarTexto({ asunto: 'a'.repeat(MAX_ASUNTO), cuerpo: 'c'.repeat(MAX_CUERPO) }, porDefecto).error);
    });

    test('un valor que no es texto se rechaza', () => {
        assert.ok(validarTexto({ asunto: 5 }, porDefecto).error);
        assert.ok(validarTexto({ cuerpo: ['x'] }, porDefecto).error);
        assert.ok(validarTexto({ asunto: { a: 1 } }, porDefecto).error);
    });
});

describe('caracteres de control del cuerpo', () => {
    const porDefecto = { asunto: 'A', cuerpo: 'C' };
    test('se rechazan NUL, VT y otros de control; se aceptan salto de linea, tabulacion y CRLF', () => {
        for (const cuerpo of ['a\u0000b', 'a\u000Bb', 'a\u001Bb', 'a\u007Fb']) {
            assert.ok(validarTexto({ cuerpo }, porDefecto).error, JSON.stringify(cuerpo));
        }
        assert.equal(validarTexto({ cuerpo: 'a\tb\nc' }, porDefecto).cuerpo, 'a\tb\nc');
        assert.equal(validarTexto({ cuerpo: 'a\r\nb' }, porDefecto).cuerpo, 'a\nb');
    });
});

describe('validarFolio', () => {
    test('acepta folios normales y recorta espacios', () => {
        for (const folio of ['F-1001', 'T 22/B', 'A.1_2', '123456', 98765]) {
            assert.ok(!validarFolio(folio).error, String(folio));
        }
        assert.equal(validarFolio('  F-1  ').folio, 'F-1');
    });
    test('rechaza saltos de linea, simbolos, vacios y largos', () => {
        for (const folio of ['F\n1', 'F\r1', 'F<1>', 'F;1', '', '   ', 'a'.repeat(51), null, undefined, ['x'], { a: 1 }]) {
            assert.ok(validarFolio(folio).error, JSON.stringify(folio));
        }
    });
});
