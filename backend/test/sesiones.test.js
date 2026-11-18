// Sesiones guardadas en la base (migracion 036): token opaco "gs1_", solo su hash en la tabla, revocables.
//
// Las reglas puras corren siempre. Los flujos completos escriben en la base local, igual que
// cuentasCodigos.test.js:
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-sesiones-en-base';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const s = require('../src/utils/sesiones');

describe('reglas de sesiones', () => {
    test('el token lleva el prefijo, es largo y distinto cada vez; la base guarda solo su hash', () => {
        const a = s.generarToken();
        const b = s.generarToken();
        assert.match(a, /^gs1_[A-Za-z0-9_-]{43}$/);
        assert.notEqual(a, b);
        assert.ok(s.esTokenDeSesion(a));
        const h = s.hashToken(a);
        assert.match(h, /^[0-9a-f]{64}$/);
        assert.ok(!h.includes(a.slice(4, 20)));
        assert.equal(h, s.hashToken(a), 'el hash es estable');
    });

    test('un JWT antiguo o un texto raro no es un token de sesion', () => {
        assert.equal(s.esTokenDeSesion(jwt.sign({ id: 1 }, 'x')), false);
        assert.equal(s.esTokenDeSesion('gs1_'), false);
        assert.equal(s.esTokenDeSesion(undefined), false);
        assert.equal(s.esTokenDeSesion(`gs1_${'a'.repeat(300)}`), false);
    });

    test('la app se normaliza', () => {
        assert.equal(s.normalizarApp('panel'), 'panel');
        assert.equal(s.normalizarApp('terreno'), 'terreno');
        assert.equal(s.normalizarApp('cualquier cosa'), 'otro');
        assert.equal(s.normalizarApp(undefined), 'otro');
    });

    test('estadoSesion: vigente, revocada, vencida e inactiva', () => {
        const ahora = new Date('2026-01-31T12:00:00Z');
        const base = {
            revocada_at: null,
            expira_at: new Date('2026-02-20T00:00:00Z'),
            ultimo_uso_at: new Date('2026-01-30T12:00:00Z'),
            inactividad_min: s.INACTIVIDAD_MINUTOS,
        };
        assert.equal(s.estadoSesion(base, ahora), 'ok');
        assert.equal(s.estadoSesion({ ...base, revocada_at: new Date('2026-01-31T00:00:00Z') }, ahora), 'revocada');
        assert.equal(s.estadoSesion({ ...base, expira_at: new Date('2026-01-31T11:59:59Z') }, ahora), 'vencida');
        assert.equal(s.estadoSesion({ ...base, ultimo_uso_at: new Date('2026-01-16T12:00:00Z') }, ahora), 'inactiva');
        assert.equal(s.estadoSesion({ ...base, ultimo_uso_at: new Date('2026-01-17T12:00:01Z') }, ahora), 'ok');
        assert.equal(s.estadoSesion(null, ahora), 'revocada');
    });

    test('duraciones: 30 dias como tope y 14 sin usar', () => {
        assert.equal(s.DURACION_ABSOLUTA_DIAS, 30);
        assert.equal(s.INACTIVIDAD_MINUTOS, 14 * 24 * 60);
        const ahora = new Date('2026-01-01T00:00:00Z');
        assert.equal(s.vencimientoAbsoluto(ahora).toISOString(), '2026-01-31T00:00:00.000Z');
    });
});

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);
const MARCA = `sesion-${Date.now()}`;
const correoPrueba = (n) => `${MARCA}-${n}@gomaq.test`;
const CLAVE = 'clave-de-prueba-1';

let servidor;
let base;
let pool;
const fetchReal = globalThis.fetch;

let ipSiguiente = 1;
async function pedir(metodo, ruta, { token, cuerpo } = {}) {
    const ip = `10.79.${Math.floor(ipSiguiente / 250)}.${(ipSiguiente++ % 250) + 1}`;
    const r = await fetchReal(`${base}${ruta}`, {
        method: metodo,
        headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': ip,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    let json = null;
    try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
    return { status: r.status, body: json };
}

async function crearCuenta(nombre, rol = 'administrativo') {
    const email = correoPrueba(nombre);
    const hash = await bcrypt.hash(CLAVE, 4);
    const r = await pool.query(
        `INSERT INTO usuarios (nombre, email, password_hash, rol, estado_cuenta) VALUES ($1, $2, $3, $4, 'activo') RETURNING id`,
        [nombre, email, hash, rol]
    );
    return { id: r.rows[0].id, email };
}

async function entrar(email, extra = {}) {
    const r = await pedir('POST', '/api/auth/login', { cuerpo: { email, password: CLAVE, ...extra } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token;
}

// una ruta cualquiera que exige sesion y rol interno
const consulta = (token) => pedir('GET', '/api/usuarios?rol=mecanico', { token });

before(async () => {
    if (HABILITADO) exigirBaseLocal();
    delete process.env.SESIONES_EN_BASE;
    const express = require('express');
    if (HABILITADO) pool = require('../src/config/db');
    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../src/routes/auth'));
    app.use('/api/usuarios', require('../src/routes/usuarios'));
    await new Promise((resolve) => { servidor = app.listen(0, resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
    delete process.env.SESIONES_EN_BASE;
    if (servidor) await new Promise((resolve) => servidor.close(resolve));
    if (pool) {
        await pool.query('DELETE FROM usuarios WHERE email LIKE $1', [`${MARCA}-%`]);
        await pool.end();
    }
});

function requiereBase(t) {
    if (!HABILITADO) {
        t.skip('pruebas de escritura deshabilitadas: usar GOMAQ_TEST_ESCRITURA=1 con una base local');
        return false;
    }
    return true;
}

describe('sesiones en la base', () => {
    test('el login entrega un token opaco, la base guarda su hash y logout lo revoca', async (t) => {
        if (!requiereBase(t)) return;
        const { id, email } = await crearCuenta('login');
        const token = await entrar(email, { app: 'panel' });
        assert.match(token, /^gs1_/);

        const fila = await pool.query('SELECT token_hash, app, expira_at, inactividad_min FROM sesiones WHERE usuario_id = $1', [id]);
        assert.equal(fila.rows.length, 1);
        assert.equal(fila.rows[0].token_hash, s.hashToken(token));
        assert.ok(!fila.rows[0].token_hash.includes(token));
        assert.equal(fila.rows[0].app, 'panel');
        assert.equal(fila.rows[0].inactividad_min, s.INACTIVIDAD_MINUTOS);

        assert.equal((await consulta(token)).status, 200);
        assert.equal((await pedir('POST', '/api/auth/logout', { token })).status, 204);
        assert.equal((await consulta(token)).status, 401, 'la sesion revocada ya no vale');
        assert.equal((await pedir('POST', '/api/auth/logout', { token })).status, 401, 'cerrar dos veces no hace dano');
    });

    test('logout-todas cierra todas las sesiones de la cuenta, y solo las de esa cuenta', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearCuenta('todas-a');
        const b = await crearCuenta('todas-b');
        const a1 = await entrar(a.email);
        const a2 = await entrar(a.email, { app: 'terreno' });
        const b1 = await entrar(b.email);
        assert.equal((await pedir('POST', '/api/auth/logout-todas', { token: a1 })).status, 204);
        assert.equal((await consulta(a1)).status, 401);
        assert.equal((await consulta(a2)).status, 401);
        assert.equal((await consulta(b1)).status, 200);
    });

    test('cambiar la clave propia cierra las otras sesiones y conserva la actual con el mismo token', async (t) => {
        if (!requiereBase(t)) return;
        const { email } = await crearCuenta('cambio');
        const actual = await entrar(email);
        const otra = await entrar(email);
        const r = await pedir('POST', '/api/auth/cambiar-password', { token: actual, cuerpo: { actual: CLAVE, nueva: 'otra-clave-de-prueba-2' } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.token, actual);
        assert.equal((await consulta(actual)).status, 200);
        assert.equal((await consulta(otra)).status, 401);
    });

    test('restablecer la clave desde la oficina cierra las sesiones de la persona', async (t) => {
        if (!requiereBase(t)) return;
        const jefe = await crearCuenta('jefe', 'gerente');
        const { id, email } = await crearCuenta('restablecida', 'mecanico');
        const jefeToken = await entrar(jefe.email);
        const suyo = await entrar(email);
        assert.equal((await consulta(suyo)).status, 403, 'un mecanico no entra a esa ruta, pero su sesion vale');
        const r = await pedir('POST', `/api/usuarios/${id}/password`, { token: jefeToken, cuerpo: { password: 'clave-restablecida-3' } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal((await consulta(suyo)).status, 401);
        assert.equal((await consulta(jefeToken)).status, 200, 'la sesion de quien restablece sigue');
    });

    test('desactivar y reactivar una cuenta no revive las sesiones que tenia', async (t) => {
        if (!requiereBase(t)) return;
        const jefe = await crearCuenta('jefe2', 'gerente');
        const { id, email } = await crearCuenta('desactivada');
        const jefeToken = await entrar(jefe.email);
        const suyo = await entrar(email);
        assert.equal((await consulta(suyo)).status, 200);
        assert.equal((await pedir('PATCH', `/api/usuarios/${id}/estado`, { token: jefeToken, cuerpo: { activo: false } })).status, 200);
        assert.equal((await consulta(suyo)).status, 401);
        assert.equal((await pedir('PATCH', `/api/usuarios/${id}/estado`, { token: jefeToken, cuerpo: { activo: true } })).status, 200);
        assert.equal((await consulta(suyo)).status, 401, 'reactivar no la revive');
        assert.equal((await consulta(await entrar(email))).status, 200, 'entrando de nuevo, si');
    });

    test('una sesion sin uso mas de 14 dias o vencida deja de valer; el uso la mantiene viva', async (t) => {
        if (!requiereBase(t)) return;
        const { id, email } = await crearCuenta('inactiva');
        const token = await entrar(email);
        await pool.query(`UPDATE sesiones SET ultimo_uso_at = now() - interval '13 days' WHERE usuario_id = $1`, [id]);
        assert.equal((await consulta(token)).status, 200);
        // el uso se anota (la marca se escribe sin esperar la respuesta)
        for (let i = 0; i < 50; i++) {
            const f = await pool.query('SELECT ultimo_uso_at > now() - interval \'1 hour\' AS reciente FROM sesiones WHERE usuario_id = $1', [id]);
            if (f.rows[0].reciente) break;
            await new Promise((r) => setTimeout(r, 20));
        }
        await pool.query(`UPDATE sesiones SET ultimo_uso_at = now() - interval '15 days' WHERE usuario_id = $1`, [id]);
        assert.equal((await consulta(token)).status, 401, 'inactiva');

        const otra = await entrar(email);
        await pool.query(`UPDATE sesiones SET expira_at = now() - interval '1 minute' WHERE token_hash = $1`, [s.hashToken(otra)]);
        assert.equal((await consulta(otra)).status, 401, 'vencida');
    });

    test('un JWT antiguo sigue valiendo; un token inventado no', async (t) => {
        if (!requiereBase(t)) return;
        const { id } = await crearCuenta('antiguo');
        const antiguo = jwt.sign({ id, rol: 'administrativo', cliente_id: null, pc: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
        assert.equal((await consulta(antiguo)).status, 200);
        assert.equal((await consulta(s.generarToken())).status, 401);
        assert.equal((await consulta(`gs1_${'x'.repeat(43)}`)).status, 401);
    });

    test('con SESIONES_EN_BASE=0 el login vuelve al JWT firmado', async (t) => {
        if (!requiereBase(t)) return;
        const { email } = await crearCuenta('interruptor');
        process.env.SESIONES_EN_BASE = '0';
        try {
            const token = await entrar(email);
            assert.ok(!token.startsWith('gs1_'));
            assert.equal((await consulta(token)).status, 200);
        } finally {
            delete process.env.SESIONES_EN_BASE;
        }
    });

    test('una cuenta mantiene como maximo 20 sesiones abiertas: las mas viejas se cierran', async (t) => {
        if (!requiereBase(t)) return;
        const { crearSesion } = require('../src/services/sesiones');
        const { id } = await crearCuenta('limite');
        const tokens = [];
        for (let i = 0; i < s.MAX_SESIONES_ACTIVAS + 2; i++) tokens.push((await crearSesion(pool, id)).token);
        const activas = await pool.query('SELECT count(*)::int AS n FROM sesiones WHERE usuario_id = $1 AND revocada_at IS NULL', [id]);
        assert.equal(activas.rows[0].n, s.MAX_SESIONES_ACTIVAS);
        assert.equal((await consulta(tokens[0])).status, 401, 'la mas vieja se cerro');
        assert.equal((await consulta(tokens[tokens.length - 1])).status, 200);
    });
});
