// Reglas de los codigos de un solo uso (utils/codigosCuenta.js): invitar cuentas internas y recuperar
// la contrasena. Puras: corren sin base de datos.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/utils/codigosCuenta');

const SECRETO = 'secreto-solo-para-pruebas-de-codigos-0123456789';
const ahora = new Date('2026-11-10T12:00:00Z');
const enMinutos = (m) => new Date(ahora.getTime() + m * 60000);

describe('generar y normalizar el codigo', () => {
    test('siempre 6 digitos, con ceros a la izquierda', () => {
        assert.equal(c.generarCodigo(() => 42), '000042');
        assert.equal(c.generarCodigo(() => 999999), '999999');
        for (let i = 0; i < 50; i++) assert.match(c.generarCodigo(), /^\d{6}$/);
    });

    test('acepta espacios y guiones de lo que escribe la persona, nada mas', () => {
        assert.equal(c.normalizarCodigo('123 456'), '123456');
        assert.equal(c.normalizarCodigo('123-456'), '123456');
        assert.equal(c.normalizarCodigo('12345'), null);
        assert.equal(c.normalizarCodigo('12345a'), null);
        assert.equal(c.normalizarCodigo('1234567'), null);
        assert.equal(c.normalizarCodigo(undefined), null);
    });
});

describe('HMAC del codigo', () => {
    const base = { secreto: SECRETO, proposito: 'invitacion', email: 'ana@gomaq.cl', codigo: '123456' };

    test('es estable y no contiene el codigo', () => {
        const h = c.hmacCodigo(base);
        assert.match(h, /^[0-9a-f]{64}$/);
        assert.equal(h, c.hmacCodigo(base));
        assert.ok(!h.includes('123456'));
    });

    test('queda amarrado al correo (sin distinguir mayusculas), al proposito y al secreto', () => {
        const h = c.hmacCodigo(base);
        assert.equal(h, c.hmacCodigo({ ...base, email: ' Ana@Gomaq.cl ' }));
        assert.notEqual(h, c.hmacCodigo({ ...base, email: 'otra@gomaq.cl' }));
        assert.notEqual(h, c.hmacCodigo({ ...base, proposito: 'recuperar_password' }));
        assert.notEqual(h, c.hmacCodigo({ ...base, secreto: `${SECRETO}x` }));
        assert.notEqual(h, c.hmacCodigo({ ...base, codigo: '123457' }));
    });

    test('sin secreto no genera nada', () => {
        assert.throws(() => c.hmacCodigo({ ...base, secreto: '' }));
    });
});

describe('evaluarCanje', () => {
    const hmac = c.hmacCodigo({ secreto: SECRETO, proposito: 'invitacion', email: 'ana@gomaq.cl', codigo: '123456' });
    const fila = { codigo_hmac: hmac, intentos: 0, expira_at: enMinutos(10), usado_at: null, revocado_at: null };

    test('vale con el codigo correcto dentro del plazo', () => {
        assert.equal(c.evaluarCanje(fila, { hmacIngresado: hmac, ahora }), 'ok');
    });

    test('rechaza el codigo equivocado, vencido, agotado, usado o revocado', () => {
        const otro = c.hmacCodigo({ secreto: SECRETO, proposito: 'invitacion', email: 'ana@gomaq.cl', codigo: '654321' });
        assert.equal(c.evaluarCanje(fila, { hmacIngresado: otro, ahora }), 'incorrecto');
        assert.equal(c.evaluarCanje({ ...fila, expira_at: enMinutos(-1) }, { hmacIngresado: hmac, ahora }), 'vencido');
        assert.equal(c.evaluarCanje({ ...fila, intentos: c.MAX_INTENTOS }, { hmacIngresado: hmac, ahora }), 'agotado');
        assert.equal(c.evaluarCanje({ ...fila, usado_at: ahora }, { hmacIngresado: hmac, ahora }), 'usado');
        assert.equal(c.evaluarCanje({ ...fila, revocado_at: ahora }, { hmacIngresado: hmac, ahora }), 'revocado');
        assert.equal(c.evaluarCanje(null, { hmacIngresado: hmac, ahora }), 'incorrecto');
        assert.equal(c.MAX_INTENTOS, 5);
    });

    test('la invitacion solo activa una cuenta pendiente; recuperar solo vale para una activa', () => {
        assert.equal(c.canjePermitido('invitacion', 'pendiente'), true);
        assert.equal(c.canjePermitido('invitacion', 'activo'), false);
        assert.equal(c.canjePermitido('invitacion', 'rechazado'), false);
        assert.equal(c.canjePermitido('recuperar_password', 'activo'), true);
        assert.equal(c.canjePermitido('recuperar_password', 'rechazado'), false, 'un codigo viejo no reactiva una cuenta desactivada');
        assert.equal(c.canjePermitido('recuperar_password', 'pendiente'), false);
        assert.equal(c.canjePermitido('verificar_correo', 'activo'), false);
    });
});

describe('vigencia y estado de la invitacion', () => {
    test('autoservicio 15 min; lo que genera el administrador dura mas', () => {
        assert.equal(c.vigenciaMinutos('recuperar_password'), 15);
        assert.equal(c.vigenciaMinutos('recuperar_password', { generadoPorAdmin: true }), 24 * 60);
        assert.equal(c.vigenciaMinutos('invitacion', { generadoPorAdmin: true }), 72 * 60);
        assert.throws(() => c.vigenciaMinutos('otro'));
    });

    test('estado para la lista de cuentas', () => {
        const fila = { expira_at: enMinutos(60), intentos: 0, usado_at: null, revocado_at: null };
        assert.equal(c.estadoInvitacion(null, ahora), 'sin_invitacion');
        assert.equal(c.estadoInvitacion(fila, ahora), 'vigente');
        assert.equal(c.estadoInvitacion({ ...fila, expira_at: enMinutos(-1) }, ahora), 'vencida');
        assert.equal(c.estadoInvitacion({ ...fila, intentos: 5 }, ahora), 'bloqueada');
        assert.equal(c.estadoInvitacion({ ...fila, revocado_at: ahora }, ahora), 'revocada');
        assert.equal(c.estadoInvitacion({ ...fila, usado_at: ahora }, ahora), 'aceptada');
    });
});

describe('correo disponible', () => {
    test('exige clave y un remitente que no sea el de pruebas de Resend', () => {
        assert.equal(c.correoDisponible({}).disponible, false);
        assert.equal(c.correoDisponible({ RESEND_API_KEY: 'k' }).disponible, false);
        const pruebas = c.correoDisponible({ RESEND_API_KEY: 'k', CORREO_REMITENTE: 'GOMAQ <onboarding@resend.dev>' });
        assert.equal(pruebas.disponible, false);
        assert.match(pruebas.motivo, /verificar el dominio/);
        assert.deepEqual(c.correoDisponible({ RESEND_API_KEY: 'k', CORREO_REMITENTE: 'GOMAQ <avisos@empresa.example>' }), { disponible: true, motivo: null });
    });

    test('URL del panel: la configurada, la publica de Railway o ninguna', () => {
        assert.equal(c.urlPanel({ PANEL_URL: 'https://panel.example/' }), 'https://panel.example');
        assert.equal(c.urlPanel({ RAILWAY_PUBLIC_DOMAIN: 'app.up.railway.app' }), 'https://app.up.railway.app');
        assert.equal(c.urlPanel({ PANEL_URL: 'no es url' }), null);
        assert.equal(c.urlPanel({}), null);
    });
});

describe('texto del codigo', () => {
    const venceAt = enMinutos(72 * 60);

    test('la invitacion dice donde activar, con que correo y el codigo; el enlace no lleva el codigo', () => {
        const t = c.textoCodigo({ proposito: 'invitacion', nombre: 'Ana', email: 'ana@gomaq.cl', codigo: '123456', venceAt, url: 'https://panel.example' });
        assert.match(t, /Hola Ana:/);
        assert.match(t, /https:\/\/panel\.example\/activar /);
        assert.match(t, /navegador/);
        assert.match(t, /ana@gomaq\.cl/);
        assert.match(t, /123 456/);
        assert.match(t, /una sola vez/);
        assert.ok(!/activar\?|123456/.test(t), 'el codigo va agrupado y nunca dentro de la URL');
    });

    test('recuperar apunta a /recuperar y aclara que la clave actual sigue igual', () => {
        const t = c.textoCodigo({ proposito: 'recuperar_password', nombre: null, email: 'a@b.cl', codigo: '000123', venceAt, url: null });
        assert.match(t, /^Hola:/);
        assert.match(t, /\/recuperar/);
        assert.match(t, /000 123/);
        assert.match(t, /contraseña actual sigue igual/);
    });

    test('valida la confirmacion', () => {
        assert.equal(c.validarConfirmacion({}).ok, false);
        assert.equal(c.validarConfirmacion({ email: 'a@b.cl', codigo: '12', password: 'clave-larga' }).ok, false);
        assert.equal(c.validarConfirmacion({ email: 'a@b.cl', codigo: '123456', password: 'corta' }).ok, false);
        assert.deepEqual(
            c.validarConfirmacion({ email: ' A@B.cl ', codigo: '123 456', password: 'clave-larga' }),
            { ok: true, email: 'a@b.cl', codigo: '123456', password: 'clave-larga' }
        );
        assert.equal(c.validarCanal('correo').ok, true);
        assert.equal(c.validarCanal('whatsapp').ok, false);
    });
});
