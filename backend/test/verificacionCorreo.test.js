// Verificacion del correo del cliente al registrarse (migracion 035 sobre codigos_cuenta de la 034).
//
// Los flujos escriben en la base local, igual que cuentasCodigos.test.js:
//
//   GOMAQ_TEST_ESCRITURA=1 npm test
//
// Nunca se llama a Resend: la llamada a su API se intercepta y se lee el codigo del texto del correo.

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-verificacion-de-correo';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { requiereBase, servirApp, leerRespuesta } = require('./utils/http');
const jwt = require('jsonwebtoken');
const { URL_RESEND } = require('../src/services/correoResend');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);
const MARCA = `verif-${Date.now()}`;
const correoPrueba = (n) => `${MARCA}-${n}@gomaq.test`;

let servidor;
let base;
let pool;
let tokenAdministrativo;
const correosEnviados = [];
const fetchReal = globalThis.fetch;

let ipSiguiente = 1;
async function pedir(metodo, ruta, { token, cuerpo } = {}) {
    const ip = `10.78.${Math.floor(ipSiguiente / 250)}.${(ipSiguiente++ % 250) + 1}`;
    const r = await fetchReal(`${base}${ruta}`, {
        method: metodo,
        headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': ip,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    return leerRespuesta(r);
}

function codigoDelTexto(texto) {
    const m = /código: (\d{3}) (\d{3})/.exec(texto || '');
    assert.ok(m, `el texto trae el código: ${texto}`);
    return `${m[1]}${m[2]}`;
}

const sinCorreoConfigurado = () => { delete process.env.RESEND_API_KEY; delete process.env.CORREO_REMITENTE; };
const conCorreoConfigurado = () => {
    process.env.RESEND_API_KEY = 're_prueba';
    process.env.CORREO_REMITENTE = 'GOMAQ <avisos@correo.example>';
};

/** Espera a que el correo (que sale despues de responder) llegue a la API simulada. */
async function esperarCorreo(antes) {
    for (let i = 0; i < 100 && correosEnviados.length === antes; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(correosEnviados.length, antes + 1, 'se envio un correo');
    return correosEnviados[correosEnviados.length - 1];
}

const registrar = (email, extra = {}) => pedir('POST', '/api/registro-cliente', {
    cuerpo: { nombre_contacto: 'Cliente Prueba', email, password: 'clave-de-prueba-1', ...extra },
});

before(async () => {
    if (HABILITADO) exigirBaseLocal();
    sinCorreoConfigurado();
    globalThis.fetch = async (url, opciones) => {
        if (url === URL_RESEND) {
            correosEnviados.push(JSON.parse(opciones.body));
            return new Response(JSON.stringify({ id: `prueba-${correosEnviados.length}` }), { status: 200 });
        }
        return fetchReal(url, opciones);
    };

    const express = require('express');
    const auth = require('../src/middleware/auth');
    if (HABILITADO) pool = require('../src/config/db');
    auth.usarBuscadorDeUsuarios(async (id, claims) => {
        if (id >= 987000 || !HABILITADO) return { rol: claims.rol, cliente_id: null, estado_cuenta: 'activo' };
        const r = await pool.query('SELECT rol, cliente_id, estado_cuenta, password_cambiada_at FROM usuarios WHERE id = $1', [id]);
        return r.rows[0] || null;
    });

    const app = express();
    app.use(express.json());
    app.use('/api/registro-cliente', require('../src/routes/registro'));
    app.use('/api/usuarios', require('../src/routes/usuarios'));
    ({ servidor, base } = await servirApp(app));

    if (HABILITADO) {
        const r = await pool.query(
            `SELECT id, rol, COALESCE(floor(extract(epoch FROM password_cambiada_at) * 1000), 0)::float8 AS pc
             FROM usuarios WHERE email = 'administrativo@gomaq.test'`
        );
        tokenAdministrativo = jwt.sign({ id: r.rows[0].id, rol: r.rows[0].rol, cliente_id: null, pc: r.rows[0].pc }, process.env.JWT_SECRET, { expiresIn: '1h' });
    }
});

after(async () => {
    globalThis.fetch = fetchReal;
    sinCorreoConfigurado();
    if (servidor) await new Promise((resolve) => servidor.close(resolve));
    if (pool) {
        await pool.query('DELETE FROM solicitudes_cliente WHERE email LIKE $1', [`${MARCA}-%`]);
        await pool.query('DELETE FROM usuarios WHERE email LIKE $1', [`${MARCA}-%`]);
        await pool.query('DELETE FROM clientes WHERE email LIKE $1', [`${MARCA}-%`]);
        await pool.end();
    }
});

/** Borra lo que dejo aprobar una solicitud: primero la solicitud (referencia al usuario), luego usuario y cliente. */
async function limpiar(email) {
    await pool.query('DELETE FROM solicitudes_cliente WHERE lower(email) = $1', [email]);
    await pool.query('DELETE FROM usuarios WHERE lower(email) = $1', [email]);
    await pool.query('DELETE FROM clientes WHERE lower(email) = $1', [email]);
}

describe('validaciones antes de tocar la base', () => {
    test('verificar exige correo y un codigo de 6 digitos', async () => {
        assert.equal((await pedir('POST', '/api/registro-cliente/verificar', { cuerpo: {} })).status, 400);
        assert.equal((await pedir('POST', '/api/registro-cliente/verificar', { cuerpo: { email: 'a@b.cl', codigo: '12' } })).status, 400);
    });

    test('reenviar exige correo', async () => {
        assert.equal((await pedir('POST', '/api/registro-cliente/reenviar-codigo', { cuerpo: {} })).status, 400);
    });
});

describe('verificar el correo del cliente', () => {
    test('al volver a postular tras un rechazo, el codigo anterior no sirve aunque no se pueda enviar uno nuevo', async (t) => {
        if (!requiereBase(t)) return;
        conCorreoConfigurado();
        const email = correoPrueba('codigo-viejo');
        const antes = correosEnviados.length;
        await registrar(email);
        const viejo = codigoDelTexto((await esperarCorreo(antes)).text);
        const lista = await pedir('GET', '/api/usuarios/solicitudes', { token: tokenAdministrativo });
        const s = lista.body.find((x) => x.email === email);
        assert.equal((await pedir('POST', `/api/usuarios/solicitudes/${s.id}/rechazar`, { token: tokenAdministrativo, cuerpo: {} })).status, 200);

        sinCorreoConfigurado();
        const de_nuevo = await registrar(email);
        assert.equal(de_nuevo.status, 201, JSON.stringify(de_nuevo.body));
        assert.equal(de_nuevo.body.verificacion, 'no_disponible');
        assert.equal((await pedir('POST', '/api/registro-cliente/verificar', { cuerpo: { email, codigo: viejo } })).status, 400);
        const fila = await pool.query('SELECT correo_verificado_at FROM solicitudes_cliente WHERE id = $1', [s.id]);
        assert.equal(fila.rows[0].correo_verificado_at, null);
    });

    test('sin correo configurado el registro funciona y queda sin verificar', async (t) => {
        if (!requiereBase(t)) return;
        sinCorreoConfigurado();
        const email = correoPrueba('sin-correo');
        const r = await registrar(email);
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.verificacion, 'no_disponible');
        const lista = await pedir('GET', '/api/usuarios/solicitudes', { token: tokenAdministrativo });
        const s = lista.body.find((x) => x.email === email);
        assert.equal(s.correo_verificado, false);
        // sin envio configurado no se exige confirmar: aprobar solo se rechaza si no hay cliente, aqui es valido
        const aprobar = await pedir('POST', `/api/usuarios/solicitudes/${s.id}/aprobar`, { token: tokenAdministrativo, cuerpo: {} });
        assert.equal(aprobar.status, 200, JSON.stringify(aprobar.body));
        await limpiar(email);
    });

    test('el codigo llega por correo, verifica la solicitud y no se puede usar dos veces', async (t) => {
        if (!requiereBase(t)) return;
        conCorreoConfigurado();
        const email = correoPrueba('flujo');
        const antes = correosEnviados.length;
        const r = await registrar(email);
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.verificacion, 'enviada');
        const enviado = await esperarCorreo(antes);
        assert.equal(enviado.to[0], email);
        const codigo = codigoDelTexto(enviado.text);

        const mal = await pedir('POST', '/api/registro-cliente/verificar', { cuerpo: { email, codigo: codigo === '000000' ? '000001' : '000000' } });
        assert.equal(mal.status, 400);
        const ok = await pedir('POST', '/api/registro-cliente/verificar', { cuerpo: { email, codigo } });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        const otra = await pedir('POST', '/api/registro-cliente/verificar', { cuerpo: { email, codigo } });
        assert.equal(otra.status, 400);

        const lista = await pedir('GET', '/api/usuarios/solicitudes', { token: tokenAdministrativo });
        const s = lista.body.find((x) => x.email === email);
        assert.equal(s.correo_verificado, true);
        const aprobar = await pedir('POST', `/api/usuarios/solicitudes/${s.id}/aprobar`, { token: tokenAdministrativo, cuerpo: {} });
        assert.equal(aprobar.status, 200, JSON.stringify(aprobar.body));
        await limpiar(email);
        sinCorreoConfigurado();
    });

    test('aprobar una solicitud sin verificar pide confirmacion explicita', async (t) => {
        if (!requiereBase(t)) return;
        conCorreoConfigurado();
        const email = correoPrueba('sin-verificar');
        const r = await registrar(email);
        assert.equal(r.status, 201);
        const lista = await pedir('GET', '/api/usuarios/solicitudes', { token: tokenAdministrativo });
        const s = lista.body.find((x) => x.email === email);
        assert.equal(s.correo_verificado, false);

        const sin = await pedir('POST', `/api/usuarios/solicitudes/${s.id}/aprobar`, { token: tokenAdministrativo, cuerpo: {} });
        assert.equal(sin.status, 409);
        assert.equal(sin.body.codigo, 'correo_sin_verificar');
        const aun = await pool.query('SELECT estado FROM solicitudes_cliente WHERE id = $1', [s.id]);
        assert.equal(aun.rows[0].estado, 'pendiente', 'no se aprobo');

        const con = await pedir('POST', `/api/usuarios/solicitudes/${s.id}/aprobar`, { token: tokenAdministrativo, cuerpo: { confirmar_sin_verificar: true } });
        assert.equal(con.status, 200, JSON.stringify(con.body));
        await limpiar(email);
        sinCorreoConfigurado();
    });

    test('cinco intentos fallidos bloquean el codigo', async (t) => {
        if (!requiereBase(t)) return;
        conCorreoConfigurado();
        const email = correoPrueba('intentos');
        const antes = correosEnviados.length;
        await registrar(email);
        const codigo = codigoDelTexto((await esperarCorreo(antes)).text);
        const otro = codigo === '000000' ? '000001' : '000000';
        for (let i = 0; i < 5; i++) {
            assert.equal((await pedir('POST', '/api/registro-cliente/verificar', { cuerpo: { email, codigo: otro } })).status, 400);
        }
        assert.equal((await pedir('POST', '/api/registro-cliente/verificar', { cuerpo: { email, codigo } })).status, 400);
        sinCorreoConfigurado();
    });

    test('reenviar entrega un codigo nuevo y el anterior deja de servir; respeta 1 por minuto', async (t) => {
        if (!requiereBase(t)) return;
        conCorreoConfigurado();
        const email = correoPrueba('reenviar');
        const antes = correosEnviados.length;
        await registrar(email);
        const primero = codigoDelTexto((await esperarCorreo(antes)).text);

        // dentro del primer minuto no sale otro correo (misma respuesta de todos modos)
        const pronto = await pedir('POST', '/api/registro-cliente/reenviar-codigo', { cuerpo: { email } });
        assert.equal(pronto.status, 200);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(correosEnviados.length, antes + 1);

        // se envejece el codigo para saltar el tope de 1 por minuto
        await pool.query(`UPDATE codigos_cuenta SET created_at = now() - interval '2 minutes' WHERE lower(email) = $1`, [email]);
        const reenviado = await pedir('POST', '/api/registro-cliente/reenviar-codigo', { cuerpo: { email } });
        assert.deepEqual(reenviado.body, pronto.body, 'misma respuesta');
        const segundo = codigoDelTexto((await esperarCorreo(antes + 1)).text);
        assert.notEqual(segundo, primero);

        assert.equal((await pedir('POST', '/api/registro-cliente/verificar', { cuerpo: { email, codigo: primero } })).status, 400);
        assert.equal((await pedir('POST', '/api/registro-cliente/verificar', { cuerpo: { email, codigo: segundo } })).status, 200);

        // un correo que no existe recibe la misma respuesta y no envia nada
        const n = correosEnviados.length;
        const nadie = await pedir('POST', '/api/registro-cliente/reenviar-codigo', { cuerpo: { email: correoPrueba('nadie') } });
        assert.deepEqual(nadie.body, pronto.body);
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(correosEnviados.length, n);
        sinCorreoConfigurado();
    });

    test('un codigo de verificacion no sirve para otro correo ni al reemplazar una solicitud rechazada', async (t) => {
        if (!requiereBase(t)) return;
        conCorreoConfigurado();
        const email = correoPrueba('reemplazo');
        const antes = correosEnviados.length;
        await registrar(email);
        const codigo = codigoDelTexto((await esperarCorreo(antes)).text);

        // el mismo codigo con otro correo no verifica nada
        assert.equal((await pedir('POST', '/api/registro-cliente/verificar', { cuerpo: { email: correoPrueba('otro'), codigo } })).status, 400);

        // se verifica, el administrativo rechaza y una nueva postulacion parte sin verificar
        assert.equal((await pedir('POST', '/api/registro-cliente/verificar', { cuerpo: { email, codigo } })).status, 200);
        const lista = await pedir('GET', '/api/usuarios/solicitudes', { token: tokenAdministrativo });
        const s = lista.body.find((x) => x.email === email);
        const rechazo = await pedir('POST', `/api/usuarios/solicitudes/${s.id}/rechazar`, { token: tokenAdministrativo, cuerpo: {} });
        assert.equal(rechazo.status, 200, JSON.stringify(rechazo.body));
        const n = correosEnviados.length;
        const de_nuevo = await registrar(email);
        assert.equal(de_nuevo.status, 201, JSON.stringify(de_nuevo.body));
        await esperarCorreo(n);
        const fila = await pool.query('SELECT correo_verificado_at, estado FROM solicitudes_cliente WHERE id = $1', [s.id]);
        assert.equal(fila.rows[0].estado, 'pendiente');
        assert.equal(fila.rows[0].correo_verificado_at, null, 'la verificacion anterior no se hereda');
        sinCorreoConfigurado();
    });
});
