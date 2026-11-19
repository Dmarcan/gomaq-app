const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { enviarPushFcm, leerCuentaServicio, firmarJwt, limpiarCacheToken, URL_TOKEN, SCOPE_FCM } = require('../src/services/fcm');

// llave RSA generada aqui: el CI nunca recibe una clave real de Firebase
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const CUENTA = { clientEmail: 'push@proyecto-prueba.iam.gserviceaccount.com', privateKey, projectId: 'proyecto-prueba' };
const MENSAJE = { titulo: 'Nueva orden asignada', cuerpo: 'OT #5, equipo EXC-04', data: { tipo: 'ot_asignada', orden_trabajo_id: '5' }, tag: 'ot-5-ot_asignada' };

function respuesta(status, cuerpo, cabeceras = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => (cabeceras[k.toLowerCase()] === undefined ? null : cabeceras[k.toLowerCase()]) },
        json: async () => { if (cuerpo === undefined) throw new Error('sin json'); return cuerpo; },
    };
}

/** fetch falso: guia las respuestas por URL (la ultima de cada cola se repite) y deja registro de cada llamada. */
function fetchFalso({ token = [respuesta(200, { access_token: 'AT-1', expires_in: 3600 })], envio = [respuesta(200, { name: 'projects/p/messages/1' })] } = {}) {
    const llamadas = [];
    const colas = { token: [...token], envio: [...envio] };
    const fn = async (url, opciones) => {
        llamadas.push({ url, opciones });
        const cola = url === URL_TOKEN ? colas.token : colas.envio;
        return cola.length > 1 ? cola.shift() : cola[0];
    };
    fn.llamadas = llamadas;
    return fn;
}

test.beforeEach(() => limpiarCacheToken());

test('firmarJwt: RS256 con scope de FCM, audiencia de Google y firma verificable', () => {
    const jwt = firmarJwt(CUENTA, 1_700_000_000_000);
    const [cab, claims, firma] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(cab, 'base64url')), { alg: 'RS256', typ: 'JWT' });
    const c = JSON.parse(Buffer.from(claims, 'base64url'));
    assert.equal(c.iss, CUENTA.clientEmail);
    assert.equal(c.scope, SCOPE_FCM);
    assert.equal(c.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(c.aud, 'https://oauth2.googleapis.com/token');
    assert.equal(c.iat, 1_700_000_000);
    assert.equal(c.exp, 1_700_003_600);
    const ok = crypto.createVerify('RSA-SHA256').update(`${cab}.${claims}`).verify(publicKey, Buffer.from(firma, 'base64url'));
    assert.equal(ok, true);
});

test('leerCuentaServicio: sin variable, mal formada o incompleta es error de configuracion', () => {
    const base64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
    for (const env of [{}, { FCM_CUENTA_SERVICIO: '%%%no-es-base64-json' }, { FCM_CUENTA_SERVICIO: base64({ client_email: 'a' }) }]) {
        assert.throws(() => leerCuentaServicio(env), (e) => e.reintentarEnSegundos === 3600);
    }
    const cuenta = leerCuentaServicio({ FCM_CUENTA_SERVICIO: base64({ client_email: 'a@b', private_key: 'k', project_id: 'p', otro: 'x' }) });
    assert.deepEqual(cuenta, { clientEmail: 'a@b', privateKey: 'k', projectId: 'p' });
});

test('el error de configuracion no revela la clave privada', () => {
    const crudo = Buffer.from(JSON.stringify({ client_email: 'a', private_key: privateKey })).toString('base64');
    try {
        leerCuentaServicio({ FCM_CUENTA_SERVICIO: crudo });
        assert.fail('debia lanzar');
    } catch (e) {
        assert.ok(!e.message.includes('PRIVATE KEY'));
    }
});

test('enviarPushFcm: canjea el JWT, llama a la API v1 con el token de acceso y el cuerpo en lista blanca', async () => {
    const f = fetchFalso();
    const nombre = await enviarPushFcm({ cuenta: CUENTA, token: 'tok-dispositivo', mensaje: MENSAJE, signal: new AbortController().signal, fetchFn: f });
    assert.equal(nombre, 'projects/p/messages/1');
    assert.equal(f.llamadas.length, 2);

    const canje = f.llamadas[0];
    assert.equal(canje.url, 'https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(canje.opciones.body);
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(form.get('assertion').split('.').length, 3);

    const envio = f.llamadas[1];
    assert.equal(envio.url, 'https://fcm.googleapis.com/v1/projects/proyecto-prueba/messages:send');
    assert.equal(envio.opciones.method, 'POST');
    assert.equal(envio.opciones.headers.Authorization, 'Bearer AT-1');
    assert.ok(envio.opciones.signal, 'el fetch recibe el signal');
    const cuerpo = JSON.parse(envio.opciones.body);
    assert.equal(cuerpo.message.token, 'tok-dispositivo');
    assert.deepEqual(cuerpo.message.notification, { title: MENSAJE.titulo, body: MENSAJE.cuerpo });
    assert.deepEqual(cuerpo.message.data, { tipo: 'ot_asignada', orden_trabajo_id: '5' });
    assert.equal(cuerpo.message.android.notification.tag, 'ot-5-ot_asignada');
    assert.equal(cuerpo.message.webpush.notification.tag, 'ot-5-ot_asignada');
});

test('enviarPushFcm: el token de acceso se reutiliza y se renueva al pasar ~50 min', async () => {
    const f = fetchFalso();
    let reloj = 1_000_000;
    const comun = { cuenta: CUENTA, token: 't', mensaje: MENSAJE, fetchFn: f, ahora: () => reloj };
    await enviarPushFcm(comun);
    await enviarPushFcm(comun);
    assert.equal(f.llamadas.filter((l) => l.url === URL_TOKEN).length, 1, 'un solo canje');
    reloj += 51 * 60 * 1000;
    await enviarPushFcm(comun);
    assert.equal(f.llamadas.filter((l) => l.url === URL_TOKEN).length, 2, 'renovado');
});

test('enviarPushFcm: UNREGISTERED marca descartar', async () => {
    const f = fetchFalso({ envio: [respuesta(404, { error: { code: 404, message: 'x', status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })] });
    await assert.rejects(
        enviarPushFcm({ cuenta: CUENTA, token: 't', mensaje: MENSAJE, fetchFn: f }),
        (e) => e.descartar === true && !e.reintentarEnSegundos
    );
});

test('enviarPushFcm: 429 reintenta segun Retry-After y 503 con espera por defecto', async () => {
    const f429 = fetchFalso({ envio: [respuesta(429, { error: { status: 'RESOURCE_EXHAUSTED', details: [{ errorCode: 'QUOTA_EXCEEDED' }] } }, { 'retry-after': '90' })] });
    await assert.rejects(
        enviarPushFcm({ cuenta: CUENTA, token: 't', mensaje: MENSAJE, fetchFn: f429 }),
        (e) => e.reintentarEnSegundos === 90 && !e.descartar
    );
    limpiarCacheToken();
    const f503 = fetchFalso({ envio: [respuesta(503, { error: { status: 'UNAVAILABLE' } })] });
    await assert.rejects(
        enviarPushFcm({ cuenta: CUENTA, token: 't', mensaje: MENSAJE, fetchFn: f503 }),
        (e) => e.reintentarEnSegundos === 30
    );
});

test('enviarPushFcm: SENDER_ID_MISMATCH espera 1 h sin gastar intento', async () => {
    const f = fetchFalso({ envio: [respuesta(403, { error: { status: 'PERMISSION_DENIED', details: [{ errorCode: 'SENDER_ID_MISMATCH' }] } })] });
    await assert.rejects(
        enviarPushFcm({ cuenta: CUENTA, token: 't', mensaje: MENSAJE, fetchFn: f }),
        (e) => e.reintentarEnSegundos === 3600
    );
});

test('enviarPushFcm: un 401 renueva el token de acceso y reintenta una vez', async () => {
    const f = fetchFalso({
        token: [respuesta(200, { access_token: 'AT-viejo' }), respuesta(200, { access_token: 'AT-nuevo' })],
        envio: [respuesta(401, { error: { status: 'UNAUTHENTICATED' } }), respuesta(200, { name: 'm' })],
    });
    assert.equal(await enviarPushFcm({ cuenta: CUENTA, token: 't', mensaje: MENSAJE, fetchFn: f }), 'm');
    const envios = f.llamadas.filter((l) => l.url !== URL_TOKEN);
    assert.equal(envios[0].opciones.headers.Authorization, 'Bearer AT-viejo');
    assert.equal(envios[1].opciones.headers.Authorization, 'Bearer AT-nuevo');
});

test('enviarPushFcm: si Google rechaza la cuenta de servicio es error de configuracion', async () => {
    const f = fetchFalso({ token: [respuesta(400, { error: 'invalid_grant' })] });
    await assert.rejects(
        enviarPushFcm({ cuenta: CUENTA, token: 't', mensaje: MENSAJE, fetchFn: f }),
        (e) => e.reintentarEnSegundos === 3600
    );
    assert.equal(f.llamadas.length, 1, 'no intenta enviar sin token de acceso');
});

test('enviarPushFcm: una clave privada invalida es error de configuracion y no sale a la red', async () => {
    const f = fetchFalso();
    await assert.rejects(
        enviarPushFcm({ cuenta: { ...CUENTA, privateKey: 'no-es-una-clave' }, token: 't', mensaje: MENSAJE, fetchFn: f }),
        (e) => e.reintentarEnSegundos === 3600
    );
    assert.equal(f.llamadas.length, 0);
});

test('enviarPushFcm: un 400 por el mensaje es permanente', async () => {
    const f = fetchFalso({ envio: [respuesta(400, { error: { status: 'INVALID_ARGUMENT', message: 'Invalid value at message.data', details: [{ errorCode: 'INVALID_ARGUMENT' }] } })] });
    await assert.rejects(
        enviarPushFcm({ cuenta: CUENTA, token: 't', mensaje: MENSAJE, fetchFn: f }),
        (e) => e.permanente === true
    );
});
