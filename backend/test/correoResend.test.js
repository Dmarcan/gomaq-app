const test = require('node:test');
const assert = require('node:assert/strict');
const { armarCorreoFactura, escaparHtml } = require('../src/utils/plantillaCorreoFactura');
const { errorDeResend, segundosHastaMedianocheUtc } = require('../src/utils/errorResend');
const { planificarReintento } = require('../src/utils/reintentosNotificacion');
const { enviarCorreoResend } = require('../src/services/correoResend');

test('la plantilla escapa el HTML del cuerpo y de la linea de contacto', () => {
    const c = armarCorreoFactura({ asunto: 'Factura <1>', cuerpo: 'Hola <script>alert(1)</script> & "co"\nlinea 2', contacto: 'a@b.cl' });
    assert.ok(!c.html.includes('<script>'));
    assert.match(c.html, /&lt;script&gt;/);
    assert.match(c.html, /&amp;/);
    assert.match(c.html, /<br>/);
    assert.match(c.html, /<title>Factura &lt;1&gt;<\/title>/);
    assert.match(c.texto, /Hola <script>/); // el texto plano va tal cual
});

test('con contacto valido el pie invita a responder y el correo lleva reply_to', () => {
    const c = armarCorreoFactura({ asunto: 'A', cuerpo: 'C', contacto: 'ayuda@gomaq.cl' });
    assert.match(c.texto, /Puede responder a este correo o escribir a ayuda@gomaq\.cl\./);
    assert.equal(c.replyTo, 'ayuda@gomaq.cl');
});

test('sin contacto valido no hay reply_to, el pie no inventa una direccion y no queda ningun xxxx', () => {
    for (const contacto of [undefined, '', '  ', 'xxxx', 'no es un correo', 'a@b', 'a b@c.cl', '<a@b.cl>']) {
        const c = armarCorreoFactura({ asunto: 'A', cuerpo: 'C', contacto });
        assert.equal(c.replyTo, null, `contacto ${JSON.stringify(contacto)}`);
        assert.match(c.texto, /no responda a este correo/);
        assert.doesNotMatch(c.texto + c.html, /xxxx/);
    }
});

test('escaparHtml tolera valores no texto', () => {
    assert.equal(escaparHtml(null), '');
    assert.equal(escaparHtml(5), '5');
});

test('429 usa Retry-After, la cuota diaria espera a la medianoche UTC', () => {
    const e = errorDeResend({ status: 429, cuerpo: { name: 'rate_limit_exceeded' }, headers: { 'retry-after': '7' } });
    assert.equal(e.reintentarEnSegundos, 7);
    const ahora = new Date(Date.UTC(2026, 10, 10, 23, 0, 0));
    const d = errorDeResend({ status: 429, cuerpo: { name: 'daily_quota_exceeded' }, ahora });
    assert.equal(d.reintentarEnSegundos, 3600);
    assert.equal(segundosHastaMedianocheUtc(ahora), 3600);
    assert.equal(errorDeResend({ status: 429, cuerpo: { name: 'monthly_quota_exceeded' } }).reintentarEnSegundos, 3600);
});

test('401 y 403 son de configuracion: esperan sin gastar intento', () => {
    for (const status of [401, 403]) {
        const e = errorDeResend({ status, cuerpo: { message: 'x' } });
        assert.equal(e.reintentarEnSegundos, 3600);
        assert.notEqual(e.permanente, true);
    }
});

test('400 y 422 son permanentes; 5xx es transitorio', () => {
    assert.equal(errorDeResend({ status: 422, cuerpo: { name: 'validation_error' } }).permanente, true);
    assert.equal(errorDeResend({ status: 400 }).permanente, true);
    const e = errorDeResend({ status: 503 });
    assert.equal(e.permanente, undefined);
    assert.equal(e.reintentarEnSegundos, undefined);
});

test('un error permanente deja la fila en error sin esperar los 5 intentos', () => {
    const error = Object.assign(new Error('x'), { permanente: true });
    const r = planificarReintento({ intentos: 0, maxIntentos: 5, error });
    assert.equal(r.estado, 'error');
    assert.equal(r.intentos, 1);
});

test('enviarCorreoResend arma la peticion y devuelve el id', async () => {
    let visto;
    const fetchFn = async (url, opciones) => {
        visto = { url, opciones };
        return { ok: true, json: async () => ({ id: 'abc' }) };
    };
    const signal = new AbortController().signal;
    const id = await enviarCorreoResend({
        apiKey: 'k', desde: 'GOMAQ <a@b.cl>', para: 'c@d.cl', asunto: 'As', texto: 'T', html: '<p>T</p>',
        adjuntos: [{ filename: 'f.pdf', content: 'QQ==' }], claveIdempotencia: 'gomaq-notif-9', signal, fetchFn,
    });
    assert.equal(id, 'abc');
    assert.equal(visto.url, 'https://api.resend.com/emails');
    assert.equal(visto.opciones.signal, signal);
    assert.equal(visto.opciones.headers.Authorization, 'Bearer k');
    assert.equal(visto.opciones.headers['Idempotency-Key'], 'gomaq-notif-9');
    const cuerpo = JSON.parse(visto.opciones.body);
    assert.deepEqual(cuerpo.to, ['c@d.cl']);
    assert.equal(cuerpo.attachments[0].filename, 'f.pdf');
});

test('enviarCorreoResend traduce una respuesta de error', async () => {
    const fetchFn = async () => ({
        ok: false, status: 429, headers: { get: () => '12' },
        json: async () => ({ name: 'rate_limit_exceeded', message: 'lento' }),
    });
    await assert.rejects(
        enviarCorreoResend({ apiKey: 'k', desde: 'a', para: 'b', asunto: 's', texto: 't', html: 'h', claveIdempotencia: 'x', fetchFn }),
        (e) => e.reintentarEnSegundos === 12
    );
});
