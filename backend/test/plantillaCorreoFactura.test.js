const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
    armarCorreoFactura, correoDeContacto, formatearPesos, diaCorto, textoFotos, filasResumen, resumenDePayload, LOGO_CID,
} = require('../src/utils/plantillaCorreoFactura');
const { leerLogoCorreo, contarFotos, armarEnvioFactura, RUTA_LOGO } = require('../src/utils/envioFactura');
const { enviarCorreoResend } = require('../src/services/correoResend');

const PAYLOAD = {
    tipo: 'factura_emitida', factura_id: 29, folio: '1512', monto: '1000.00', orden_trabajo_id: 17, maquinaria_codigo: 'EXC-04',
    periodo_desde: null, periodo_hasta: null, fecha_emision: '2026-11-19', fecha_vencimiento: '2026-12-19',
    asunto: 'Factura folio 1512 · Orden de trabajo #17 · GOMAQ', cuerpo: 'Estimado/a Acme:\n\nAdjuntamos la factura.\n\nGOMAQ Maquinarias',
    // datos internos que NUNCA deben llegar al cliente
    valorizacion: 987654, costo_interno: 424242, mecanico_rut: '12.345.678-5', mecanico_nombre: 'Juan Perez',
};

describe('formatearPesos', () => {
    test('separa los miles con punto y redondea', () => {
        assert.equal(formatearPesos(1000), '$ 1.000');
        assert.equal(formatearPesos('1000.00'), '$ 1.000');
        assert.equal(formatearPesos(1234567), '$ 1.234.567');
        assert.equal(formatearPesos('999.6'), '$ 1.000');
        assert.equal(formatearPesos(0), '$ 0');
        assert.equal(formatearPesos(-2500), '-$ 2.500');
    });
    test('algo que no es un monto da null', () => {
        for (const v of [null, undefined, '', 'abc', NaN]) assert.equal(formatearPesos(v), null);
    });
});

describe('diaCorto y textoFotos', () => {
    test('dd-mm-aaaa, o null si no es un dia', () => {
        assert.equal(diaCorto('2026-12-19'), '19-12-2026');
        assert.equal(diaCorto('2026-12-19T03:00:00.000Z'), '19-12-2026');
        assert.equal(diaCorto(null), null);
        assert.equal(diaCorto('ayer'), null);
    });
    test('singular, plural y solo los grupos que existen', () => {
        assert.equal(textoFotos({ antes: 1, despues: 1 }), '2 adjuntas: 1 del antes y 1 del después');
        assert.equal(textoFotos({ antes: 0, despues: 1 }), '1 adjunta: 1 del después');
        assert.equal(textoFotos({ antes: 3, despues: 0 }), '3 adjuntas: 3 del antes');
        assert.equal(textoFotos({ antes: 0, despues: 0 }), null);
        assert.equal(textoFotos(undefined), null);
    });
});

describe('correoDeContacto', () => {
    test('acepta una direccion y rechaza lo que no lo es', () => {
        assert.equal(correoDeContacto('  maquinarias@maquinariasgomaq.cl '), 'maquinarias@maquinariasgomaq.cl');
        for (const malo of [undefined, null, '', 'xxxx', 'a@b', 'a b@c.cl', 'a@b.cl, c@d.cl', '"x"@b.cl', 'Nombre <a@b.cl>', 5]) {
            assert.equal(correoDeContacto(malo), null, JSON.stringify(malo));
        }
    });
});

describe('filasResumen', () => {
    test('una reparacion: folio, monto, orden con equipo, fechas y fotos', () => {
        const filas = filasResumen(resumenDePayload(PAYLOAD, { antes: 1, despues: 1 }));
        assert.deepEqual(filas, [
            ['Folio', '1512'],
            ['Monto total', '$ 1.000'],
            ['Orden de trabajo', '#17 (equipo EXC-04)'],
            ['Emitida', '19-11-2026'],
            ['Vence', '19-12-2026'],
            ['Fotos del trabajo', '2 adjuntas: 1 del antes y 1 del después'],
        ]);
    });

    test('un arriendo: el equipo y el periodo, sin orden de trabajo', () => {
        const filas = filasResumen(resumenDePayload({
            folio: 'A-9', monto: 500000, maquinaria_codigo: 'GH-204', periodo_desde: '2026-09-02', periodo_hasta: '2026-10-05',
        }));
        assert.deepEqual(filas, [
            ['Folio', 'A-9'], ['Monto total', '$ 500.000'], ['Arriendo del equipo', 'GH-204'], ['Período', '02-09-2026 al 05-10-2026'],
        ]);
    });

    test('un dato que falta no deja una fila vacia (un aviso antiguo sin fechas ni monto)', () => {
        const filas = filasResumen(resumenDePayload({ folio: '77', orden_trabajo_id: 3 }));
        assert.deepEqual(filas, [['Folio', '77'], ['Orden de trabajo', '#3']]);
        assert.deepEqual(filasResumen(undefined), []);
        assert.deepEqual(filasResumen({}), []);
    });

    test('nunca muestra datos internos aunque vengan en el aviso', () => {
        const c = armarCorreoFactura({
            asunto: 'A', cuerpo: 'C', contacto: 'a@b.cl', resumen: resumenDePayload(PAYLOAD, { antes: 1, despues: 0 }),
        });
        for (const secreto of ['987654', '987.654', '424242', '424.242', '12.345.678-5', 'Juan Perez']) {
            assert.ok(!c.html.includes(secreto) && !c.texto.includes(secreto), `se filtro ${secreto}`);
        }
    });
});

describe('armarCorreoFactura: el HTML', () => {
    const base = { asunto: 'Factura folio 1512', cuerpo: 'Hola\n\nChao', contacto: 'a@b.cl', resumen: resumenDePayload(PAYLOAD, { antes: 1, despues: 1 }) };

    test('el encabezado lleva el logo incrustado con texto alternativo', () => {
        const { html } = armarCorreoFactura(base);
        assert.match(html, new RegExp(`<img src="cid:${LOGO_CID}"`));
        assert.match(html, /alt="GOMAQ Maquinarias"/);
        assert.match(html, /#1B1210/);
        assert.match(html, /#EA5B1F/);
    });

    test('sin logo el encabezado muestra el nombre de la empresa en texto y no cita ningun cid', () => {
        const { html } = armarCorreoFactura({ ...base, conLogo: false });
        assert.doesNotMatch(html, /cid:/);
        assert.doesNotMatch(html, /<img/);
        assert.match(html, />GOMAQ Maquinarias</);
    });

    test('no depende de ninguna imagen ni script externos', () => {
        const { html } = armarCorreoFactura(base);
        assert.doesNotMatch(html, /src="https?:/);
        assert.doesNotMatch(html, /<script|<link|@import|url\(/i);
    });

    test('es de una columna y se ajusta al celular (ancho 100 por ciento con maximo de 600 px)', () => {
        const { html } = armarCorreoFactura(base);
        assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
        assert.match(html, /width:100%;max-width:600px/);
        assert.doesNotMatch(html, /width:\s*[7-9]\d\dpx|width="[7-9]\d\d"/);
    });

    test('la tarjeta y el texto plano llevan el mismo resumen', () => {
        const { html, texto } = armarCorreoFactura(base);
        for (const dato of ['1512', '$ 1.000', '#17 (equipo EXC-04)', '19-11-2026', '19-12-2026', '2 adjuntas: 1 del antes y 1 del después']) {
            assert.ok(html.includes(dato.replace('#', '#')), `html sin ${dato}`);
            assert.ok(texto.includes(dato), `texto sin ${dato}`);
        }
    });

    test('lo que escribe el administrativo y los datos del resumen se escapan', () => {
        const { html } = armarCorreoFactura({
            ...base, cuerpo: '<img src=x onerror=1>', resumen: { folio: '<b>1</b>', equipo: '"><script>', ordenId: 1 },
        });
        assert.ok(!html.includes('<b>1</b>') && !html.includes('onerror=1>') && !html.includes('<script>'));
        assert.match(html, /&lt;b&gt;1&lt;\/b&gt;/);
    });

    test('sin resumen no hay tarjeta, solo el mensaje', () => {
        const { html } = armarCorreoFactura({ asunto: 'A', cuerpo: 'Hola', contacto: 'a@b.cl' });
        assert.doesNotMatch(html, /Monto total|Folio/);
        assert.match(html, /Hola/);
    });
});

describe('armarEnvioFactura', () => {
    const logo = { filename: 'logo-gomaq.png', content: 'AAAA', content_id: LOGO_CID };
    const pdf = [{ filename: 'factura-1512.pdf', content: 'P' }];
    const fotos = [{ filename: 'antes-1.jpg', content: 'a' }, { filename: 'antes-2.jpg', content: 'b' }, { filename: 'despues-1.jpg', content: 'c' }];

    test('los adjuntos van en orden: logo incrustado, PDF y fotos', () => {
        const { adjuntos } = armarEnvioFactura({ payload: PAYLOAD, pdf, fotos, logo, contacto: 'a@b.cl' });
        assert.deepEqual(adjuntos.map((a) => a.filename), ['logo-gomaq.png', 'factura-1512.pdf', 'antes-1.jpg', 'antes-2.jpg', 'despues-1.jpg']);
        assert.equal(adjuntos[0].content_id, LOGO_CID);
        assert.ok(adjuntos.slice(1).every((a) => !('content_id' in a)));
    });

    test('sin logo (el archivo no se pudo leer) el correo sale igual, sin el adjunto ni el cid', () => {
        const { adjuntos, correo } = armarEnvioFactura({ payload: PAYLOAD, pdf, fotos: [], logo: null, contacto: 'a@b.cl' });
        assert.deepEqual(adjuntos.map((a) => a.filename), ['factura-1512.pdf']);
        assert.doesNotMatch(correo.html, /cid:/);
    });

    test('el resumen cuenta las fotos que de verdad van, no las pedidas', () => {
        const pedidasTres = { ...PAYLOAD, foto_ids: [1, 2, 3] };
        const { correo } = armarEnvioFactura({ payload: pedidasTres, pdf, fotos: [fotos[0]], logo, contacto: 'a@b.cl' });
        assert.match(correo.texto, /Fotos del trabajo: 1 adjunta: 1 del antes\b/);
        const sinFotos = armarEnvioFactura({ payload: pedidasTres, pdf, fotos: [], logo, contacto: 'a@b.cl' }).correo;
        assert.doesNotMatch(sinFotos.texto, /Fotos del trabajo/);
    });

    test('contarFotos reconoce solo los nombres que arma el servidor', () => {
        assert.deepEqual(contarFotos([...fotos, { filename: 'factura-1.pdf' }, { filename: 'antes-x.jpg' }]), { antes: 2, despues: 1 });
        assert.deepEqual(contarFotos(undefined), { antes: 0, despues: 0 });
    });

    test('reply_to sale del contacto valido y es null si no lo hay', () => {
        assert.equal(armarEnvioFactura({ payload: PAYLOAD, pdf, fotos: [], logo, contacto: 'x@y.cl' }).correo.replyTo, 'x@y.cl');
        assert.equal(armarEnvioFactura({ payload: PAYLOAD, pdf, fotos: [], logo, contacto: undefined }).correo.replyTo, null);
    });
});

describe('leerLogoCorreo', () => {
    test('el logo del repo existe, es un PNG y va incrustado', () => {
        assert.ok(fs.existsSync(RUTA_LOGO), 'falta backend/src/assets/correo/logo_gomaq.png');
        const l = leerLogoCorreo();
        assert.equal(l.filename, 'logo-gomaq.png');
        assert.equal(l.content_id, LOGO_CID);
        assert.equal(Buffer.from(l.content, 'base64').subarray(1, 4).toString(), 'PNG');
        assert.equal(leerLogoCorreo(), l, 'se lee una vez por proceso');
    });

    test('un archivo que no existe da null y no lanza', () => {
        const original = console.error;
        console.error = () => {};
        try {
            assert.equal(leerLogoCorreo(path.join(__dirname, 'no-existe.png')), null);
        } finally { console.error = original; }
    });
});

describe('enviarCorreoResend: reply_to y adjuntos incrustados', () => {
    async function cuerpoEnviado(extra) {
        let enviado;
        const fetchFn = async (url, opciones) => {
            enviado = JSON.parse(opciones.body);
            return { ok: true, json: async () => ({ id: 'abc' }) };
        };
        const id = await enviarCorreoResend({
            apiKey: 'k', desde: 'GOMAQ <g@d.cl>', para: 'c@d.cl', asunto: 'A', texto: 'T', html: '<p>H</p>',
            claveIdempotencia: 'k1', signal: undefined, fetchFn, ...extra,
        });
        assert.equal(id, 'abc');
        return enviado;
    }

    test('con replyTo manda reply_to; sin el, no manda el campo', async () => {
        assert.equal((await cuerpoEnviado({ replyTo: 'x@y.cl' })).reply_to, 'x@y.cl');
        assert.equal('reply_to' in (await cuerpoEnviado({})), false);
        assert.equal('reply_to' in (await cuerpoEnviado({ replyTo: null })), false);
    });

    test('el adjunto incrustado viaja con su content_id', async () => {
        const c = await cuerpoEnviado({ adjuntos: [{ filename: 'logo-gomaq.png', content: 'AAAA', content_id: LOGO_CID }] });
        assert.deepEqual(c.attachments, [{ filename: 'logo-gomaq.png', content: 'AAAA', content_id: LOGO_CID }]);
    });
});
