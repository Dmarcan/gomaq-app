const test = require('node:test');
const assert = require('node:assert/strict');
const { armarCorreoCuentaAprobada, ASUNTO_CUENTA_APROBADA } = require('../src/utils/correoCuentaAprobada');
const { armarCorreoMarca, armarCorreoFactura } = require('../src/utils/plantillaCorreoFactura');

const LOGO = { filename: 'logo-gomaq.png', content: 'AAAA', content_id: 'logo-gomaq' };
const PAYLOAD = { tipo: 'cuenta_aprobada', nombre_contacto: 'Ana Pérez', url: 'https://panel.gomaq.test' };

test('el correo de cuenta aprobada trae asunto, saludo, enlace y el logo como unico adjunto', () => {
    const { correo, adjuntos } = armarCorreoCuentaAprobada({ payload: PAYLOAD, logo: LOGO, contacto: 'ayuda@gomaq.cl' });
    assert.equal(correo.asunto, ASUNTO_CUENTA_APROBADA);
    assert.equal(correo.asunto, 'Tu cuenta de GOMAQ fue aprobada');
    assert.match(correo.texto, /^Hola Ana Pérez,/);
    assert.match(correo.texto, /Ya puedes iniciar sesión/);
    assert.match(correo.texto, /Iniciar sesión: https:\/\/panel\.gomaq\.test/);
    assert.match(correo.html, /<a href="https:\/\/panel\.gomaq\.test"/);
    assert.match(correo.html, /src="cid:logo-gomaq"/);
    assert.equal(correo.replyTo, 'ayuda@gomaq.cl');
    assert.deepEqual(adjuntos, [LOGO]);
});

test('escapa el nombre de contacto en el HTML', () => {
    const { correo } = armarCorreoCuentaAprobada({
        payload: { ...PAYLOAD, nombre_contacto: '<script>alert(1)</script> & "x"' }, logo: LOGO,
    });
    assert.equal(correo.html.includes('<script>'), false);
    assert.match(correo.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;x&quot;/);
});

test('sin datos internos: solo el nombre y el enlace al panel', () => {
    const { correo } = armarCorreoCuentaAprobada({
        payload: { ...PAYLOAD, password_hash: 'secreto', rut_empresa: '11.111.111-1', usuario_id: 7 }, logo: LOGO,
    });
    for (const texto of [correo.texto, correo.html]) {
        assert.equal(texto.includes('secreto'), false);
        assert.equal(texto.includes('11.111.111-1'), false);
    }
});

test('con y sin contacto, con y sin logo, con y sin URL', () => {
    const sinContacto = armarCorreoCuentaAprobada({ payload: PAYLOAD, logo: LOGO });
    assert.equal(sinContacto.correo.replyTo, null);
    assert.match(sinContacto.correo.texto, /no responda a este correo/);

    const sinLogo = armarCorreoCuentaAprobada({ payload: PAYLOAD, logo: null, contacto: 'ayuda@gomaq.cl' });
    assert.deepEqual(sinLogo.adjuntos, []);
    assert.equal(sinLogo.correo.html.includes('cid:'), false);
    assert.match(sinLogo.correo.html, /GOMAQ Maquinarias/);

    const sinUrl = armarCorreoCuentaAprobada({ payload: { tipo: 'cuenta_aprobada', nombre_contacto: '  ' }, logo: LOGO });
    assert.match(sinUrl.correo.texto, /^Hola,\n/);
    assert.equal(sinUrl.correo.texto.includes('http'), false);
    assert.equal(sinUrl.correo.html.includes('<a '), false);
});

test('una URL que no es http(s) o trae comillas no se convierte en enlace', () => {
    for (const url of ['javascript:alert(1)', 'https://x.cl/" onclick="y', 'https://x.cl/<b>', 'ftp://x.cl', 'https://a b.cl']) {
        const { correo } = armarCorreoCuentaAprobada({ payload: { ...PAYLOAD, url }, logo: LOGO });
        assert.equal(correo.html.includes('<a '), false, url);
        assert.equal(correo.texto.includes('Iniciar sesión:'), false, url);
    }
});

test('el correo de factura sigue siendo el mismo (alias) y no lleva enlace si no se pide', () => {
    assert.equal(armarCorreoFactura, armarCorreoMarca);
    const c = armarCorreoFactura({ asunto: 'A', cuerpo: 'Hola', contacto: 'a@b.cl' });
    assert.equal(c.html.includes('<a '), false);
});
