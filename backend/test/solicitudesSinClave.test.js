// La clave de una solicitud de cuenta (solicitudes_cliente.password_hash) solo existe mientras esta pendiente
// (migracion 043): al aprobar o rechazar se pone en NULL, y un CHECK impide una pendiente sin clave.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-solicitudes-sin-clave';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { requiereBase, servirApp, leerRespuesta } = require('./utils/http');
const jwt = require('jsonwebtoken');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);
const MARCA = `sinclave-${Date.now()}`;
const correoPrueba = (n) => `${MARCA}-${n}@gomaq.test`;
const CLAVE = 'clave-de-prueba-1';

let servidor;
let base;
let pool;
let tokenAdministrativo;

let ipSiguiente = 1;
async function pedir(metodo, ruta, { token, cuerpo } = {}) {
    const ip = `10.79.${Math.floor(ipSiguiente / 250)}.${(ipSiguiente++ % 250) + 1}`;
    const r = await fetch(`${base}${ruta}`, {
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

const registrar = (email) => pedir('POST', '/api/registro-cliente', {
    cuerpo: { nombre_contacto: 'Cliente Prueba', email, password: CLAVE },
});
const iniciarSesion = (email, password = CLAVE) => pedir('POST', '/api/auth/login', { cuerpo: { email, password } });
const filaSolicitud = async (email) => (await pool.query('SELECT id, estado, password_hash FROM solicitudes_cliente WHERE email = $1', [email])).rows[0];

before(async () => {
    if (!HABILITADO) return;
    exigirBaseLocal();
    delete process.env.RESEND_API_KEY;
    delete process.env.CORREO_REMITENTE;

    const express = require('express');
    const auth = require('../src/middleware/auth');
    pool = require('../src/config/db');
    auth.usarBuscadorDeUsuarios(async (id) => {
        const r = await pool.query('SELECT rol, cliente_id, estado_cuenta, password_cambiada_at FROM usuarios WHERE id = $1', [id]);
        return r.rows[0] || null;
    });

    const app = express();
    app.use(express.json());
    app.use('/api/registro-cliente', require('../src/routes/registro'));
    app.use('/api/usuarios', require('../src/routes/usuarios'));
    app.use('/api/auth', require('../src/routes/auth'));
    ({ servidor, base } = await servirApp(app));

    const r = await pool.query(
        `SELECT id, rol, COALESCE(floor(extract(epoch FROM password_cambiada_at) * 1000), 0)::float8 AS pc
         FROM usuarios WHERE email = 'administrativo@gomaq.test'`
    );
    tokenAdministrativo = jwt.sign({ id: r.rows[0].id, rol: r.rows[0].rol, cliente_id: null, pc: r.rows[0].pc }, process.env.JWT_SECRET, { expiresIn: '1h' });
});

after(async () => {
    if (servidor) await new Promise((resolve) => servidor.close(resolve));
    if (pool) {
        await pool.query('DELETE FROM sesiones WHERE usuario_id IN (SELECT id FROM usuarios WHERE email LIKE $1)', [`${MARCA}-%`]);
        await pool.query('DELETE FROM solicitudes_cliente WHERE email LIKE $1', [`${MARCA}-%`]);
        await pool.query('DELETE FROM usuarios WHERE email LIKE $1', [`${MARCA}-%`]);
        await pool.query('DELETE FROM clientes WHERE email LIKE $1', [`${MARCA}-%`]);
        await pool.end();
    }
});

describe('la clave de la solicitud solo vive mientras esta pendiente', () => {
    test('pendiente: guarda la clave, y el aviso "en revision" sigue funcionando', async (t) => {
        if (!requiereBase(t)) return;
        const email = correoPrueba('pendiente');
        assert.equal((await registrar(email)).status, 201);
        const s = await filaSolicitud(email);
        assert.equal(s.estado, 'pendiente');
        assert.ok(s.password_hash, 'la pendiente conserva el hash');
        assert.equal((await iniciarSesion(email)).status, 403);
        assert.equal((await iniciarSesion(email, 'otra-clave-distinta')).status, 401);
    });

    test('aprobar deja password_hash en NULL y el usuario aprobado inicia sesion con su clave', async (t) => {
        if (!requiereBase(t)) return;
        const email = correoPrueba('aprobada');
        assert.equal((await registrar(email)).status, 201);
        const antes = await filaSolicitud(email);
        const aprobar = await pedir('POST', `/api/usuarios/solicitudes/${antes.id}/aprobar`, { token: tokenAdministrativo, cuerpo: {} });
        assert.equal(aprobar.status, 200, JSON.stringify(aprobar.body));

        const despues = await filaSolicitud(email);
        assert.equal(despues.estado, 'aprobada');
        assert.equal(despues.password_hash, null);
        const usuario = await pool.query('SELECT password_hash FROM usuarios WHERE email = $1', [email]);
        assert.equal(usuario.rows[0].password_hash, antes.password_hash, 'el hash se copio al usuario antes de borrarlo de la solicitud');

        const login = await iniciarSesion(email);
        assert.equal(login.status, 200, JSON.stringify(login.body));
        assert.equal((await iniciarSesion(email, 'otra-clave-distinta')).status, 401);
    });

    test('rechazar deja password_hash en NULL y la solicitud rechazada no permite iniciar sesion', async (t) => {
        if (!requiereBase(t)) return;
        const email = correoPrueba('rechazada');
        assert.equal((await registrar(email)).status, 201);
        const s = await filaSolicitud(email);
        const rechazar = await pedir('POST', `/api/usuarios/solicitudes/${s.id}/rechazar`, { token: tokenAdministrativo, cuerpo: {} });
        assert.equal(rechazar.status, 200, JSON.stringify(rechazar.body));

        const despues = await filaSolicitud(email);
        assert.equal(despues.estado, 'rechazada');
        assert.equal(despues.password_hash, null);
        assert.equal((await iniciarSesion(email)).status, 401);
    });

    test('volver a postular tras un rechazo guarda la clave nueva y la deja pendiente', async (t) => {
        if (!requiereBase(t)) return;
        const email = correoPrueba('repostula');
        assert.equal((await registrar(email)).status, 201);
        const s = await filaSolicitud(email);
        assert.equal((await pedir('POST', `/api/usuarios/solicitudes/${s.id}/rechazar`, { token: tokenAdministrativo, cuerpo: {} })).status, 200);
        assert.equal((await registrar(email)).status, 201);
        const despues = await filaSolicitud(email);
        assert.equal(despues.estado, 'pendiente');
        assert.ok(despues.password_hash);
    });
});

describe('restriccion chk_solicitud_pendiente_con_clave', () => {
    test('una pendiente sin clave no pasa el CHECK, ni al insertar ni al vaciar la clave', async (t) => {
        if (!requiereBase(t)) return;
        const email = correoPrueba('check');
        await assert.rejects(
            pool.query(`INSERT INTO solicitudes_cliente (nombre_contacto, email, password_hash, estado) VALUES ('Prueba', $1, NULL, 'pendiente')`, [email]),
            (err) => err.code === '23514' && /chk_solicitud_pendiente_con_clave/.test(err.constraint || err.message)
        );
        assert.equal((await registrar(email)).status, 201);
        await assert.rejects(
            pool.query(`UPDATE solicitudes_cliente SET password_hash = NULL WHERE email = $1`, [email]),
            (err) => err.code === '23514'
        );
    });

    test('las que ya no estan pendientes admiten clave NULL', async (t) => {
        if (!requiereBase(t)) return;
        const email = correoPrueba('check-ok');
        const r = await pool.query(
            `INSERT INTO solicitudes_cliente (nombre_contacto, email, password_hash, estado) VALUES ('Prueba', $1, NULL, 'rechazada') RETURNING id`,
            [email]
        );
        assert.equal(r.rows.length, 1);
    });
});
