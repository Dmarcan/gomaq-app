// Pruebas de escritura de "Mi empresa": GET y PATCH /api/clientes/mia (el cliente edita la ficha de su
// empresa desde el portal) y el registro de sus cambios en clientes_cambios (migracion 047).
// Mismo patron que historialClienteEscritura.test.js: rutas en memoria sobre la base de DATABASE_URL,
// datos propios que se borran al terminar y tokens firmados con un secreto de la prueba.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-mi-empresa';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { requiereBase, servirApp, leerRespuesta } = require('./utils/http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
const tokens = {};
const datos = { clientes: [], usuarios: [] };
let A;
let B;
let sinEmpresa;

const CAMPOS_FICHA = [
    'direccion', 'email', 'giro', 'horario_colacion', 'horario_trabajo', 'latitud', 'longitud',
    'nombre', 'plazo_pago_dias', 'rut', 'telefono',
];

function pedirConToken(metodo, ruta, token, cuerpo) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${base}${ruta}`, {
        method: metodo,
        headers,
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    }).then(leerRespuesta);
}
const pedir = (metodo, ruta, rol, cuerpo) => pedirConToken(metodo, ruta, rol ? tokens[rol] : null, cuerpo);

function firmar(u, clienteId = null) {
    return jwt.sign({ id: u.id, rol: u.rol, cliente_id: clienteId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function crearEmpresaConCuenta(etiqueta, extra = {}) {
    const marca = crypto.randomUUID().slice(0, 8);
    const c = (await pool.query(
        `INSERT INTO clientes (nombre, rut, giro, email, telefono, direccion, plazo_pago_dias)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [`Mi empresa ${etiqueta} ${marca}`, extra.rut ?? null, extra.giro ?? 'Giro de prueba', `contacto-${marca}@empresa.test`,
            '+56 9 1111 2222', `Calle ${etiqueta} 1`, 30]
    )).rows[0].id;
    datos.clientes.push(c);
    const u = (await pool.query(
        `INSERT INTO usuarios (nombre, email, password_hash, rol, cliente_id)
         VALUES ($1, $2, 'x', 'cliente', $3) RETURNING id, rol`,
        [`Cuenta ${etiqueta}`, `portal-${etiqueta.toLowerCase()}-${marca}@portal.test`, c]
    )).rows[0];
    datos.usuarios.push(u.id);
    return { clienteId: c, usuario: u, token: firmar(u, c) };
}

before(async () => {
    if (!HABILITADO) return;
    exigirBaseLocal();
    const express = require('express');
    pool = require('../src/config/db');
    const app = express();
    app.use(express.json());
    app.use('/api/clientes', require('../src/routes/clientes'));
    ({ servidor, base } = await servirApp(app));

    const usuarios = await pool.query(
        `SELECT id, rol, email FROM usuarios
         WHERE email IN ('administrativo@gomaq.test', 'mecanico@gomaq.test', 'admin@gomaq.test')`
    );
    const porEmail = Object.fromEntries(usuarios.rows.map((u) => [u.email, u]));
    tokens.administrativo = firmar(porEmail['administrativo@gomaq.test']);
    tokens.gerente = firmar(porEmail['admin@gomaq.test']);
    tokens.mecanico = firmar(porEmail['mecanico@gomaq.test']);

    A = await crearEmpresaConCuenta('A');
    B = await crearEmpresaConCuenta('B');
    // una cuenta de cliente que quedo sin empresa asociada
    const u = (await pool.query(
        `INSERT INTO usuarios (nombre, email, password_hash, rol)
         VALUES ('Sin empresa', $1, 'x', 'cliente') RETURNING id, rol`,
        [`sin-empresa-${crypto.randomUUID().slice(0, 8)}@portal.test`]
    )).rows[0];
    datos.usuarios.push(u.id);
    sinEmpresa = { usuario: u, token: firmar(u, null) };
});

after(async () => {
    if (!HABILITADO) return;
    // clientes_cambios es de solo insercion: se borra por la via de purga, solo en esta transaccion
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL gomaq.purga = 'on'");
        if (datos.clientes.length) await client.query('DELETE FROM clientes_cambios WHERE cliente_id = ANY($1)', [datos.clientes]);
        if (datos.usuarios.length) await client.query('DELETE FROM usuarios WHERE id = ANY($1)', [datos.usuarios]);
        if (datos.clientes.length) await client.query('DELETE FROM clientes WHERE id = ANY($1)', [datos.clientes]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
    await new Promise((resolve) => servidor.close(resolve));
    await pool.end();
});

const filaCliente = async (id) => (await pool.query('SELECT * FROM clientes WHERE id = $1', [id])).rows[0];
const cambiosDe = async (id) => (await pool.query('SELECT * FROM clientes_cambios WHERE cliente_id = $1 ORDER BY id', [id])).rows;

test('sin token responde 401; administrativo, gerente y mecanico reciben 403 en /mia', async (t) => {
    if (!requiereBase(t)) return;
    for (const metodo of ['GET', 'PATCH']) {
        assert.equal((await pedir(metodo, '/api/clientes/mia', null, metodo === 'PATCH' ? { telefono: '1' } : undefined)).status, 401, metodo);
        for (const rol of ['administrativo', 'gerente', 'mecanico']) {
            const r = await pedir(metodo, '/api/clientes/mia', rol, metodo === 'PATCH' ? { telefono: '+56 9 1234 5678' } : undefined);
            assert.equal(r.status, 403, `${metodo} ${rol}`);
        }
    }
});

test('un cliente sin empresa asociada recibe 404', async (t) => {
    if (!requiereBase(t)) return;
    const g = await pedirConToken('GET', '/api/clientes/mia', sinEmpresa.token);
    assert.equal(g.status, 404);
    assert.match(g.body.error, /no tiene una empresa/);
    assert.equal((await pedirConToken('PATCH', '/api/clientes/mia', sinEmpresa.token, { telefono: '+56 9 1234 5678' })).status, 404);
});

test('GET /mia devuelve solo la ficha de su empresa, campo por campo, sin cache', async (t) => {
    if (!requiereBase(t)) return;
    const r = await fetch(`${base}/api/clientes/mia`, { headers: { Authorization: `Bearer ${A.token}` } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const ficha = await r.json();
    assert.deepEqual(Object.keys(ficha).sort(), CAMPOS_FICHA);
    const fila = await filaCliente(A.clienteId);
    assert.equal(ficha.nombre, fila.nombre);
    assert.equal(ficha.email, fila.email);
    assert.equal(ficha.plazo_pago_dias, 30);
    assert.equal(ficha.ejecutivo_id, undefined);
    assert.equal(ficha.created_at, undefined);
    assert.equal(ficha.id, undefined);
});

test('la empresa sale de la cuenta: un cliente_id en el cuerpo o en la URL se rechaza y B no se toca', async (t) => {
    if (!requiereBase(t)) return;
    const antesB = await filaCliente(B.clienteId);
    const antesA = await filaCliente(A.clienteId);
    for (const cuerpo of [
        { cliente_id: B.clienteId, telefono: '+56 9 9999 9999' },
        { id: B.clienteId, telefono: '+56 9 9999 9999' },
    ]) {
        assert.equal((await pedirConToken('PATCH', '/api/clientes/mia', A.token, cuerpo)).status, 400, JSON.stringify(cuerpo));
    }
    assert.equal((await pedirConToken('PATCH', `/api/clientes/mia?cliente_id=${B.clienteId}`, A.token, { telefono: '+56 9 9999 9999' })).status, 400);
    // /mia no se confunde con /:id ni con el id de otra empresa
    assert.equal((await pedirConToken('PATCH', `/api/clientes/${B.clienteId}`, A.token, { telefono: '+56 9 9999 9999' })).status, 403);
    assert.equal((await pedirConToken('PATCH', `/api/clientes/${A.clienteId}`, A.token, { telefono: '+56 9 9999 9999' })).status, 403);
    assert.deepEqual(await filaCliente(B.clienteId), antesB);
    assert.deepEqual(await filaCliente(A.clienteId), antesA);
    assert.equal((await cambiosDe(A.clienteId)).length, 0);
    assert.equal((await cambiosDe(B.clienteId)).length, 0);
});

test('nombre, RUT, giro, plazo de pago y ejecutivo no se pueden cambiar desde el portal', async (t) => {
    if (!requiereBase(t)) return;
    const antes = await filaCliente(A.clienteId);
    for (const cuerpo of [
        { nombre: 'Otro nombre SpA' }, { rut: '76.809.295-8' }, { giro: 'Otro giro' }, { plazo_pago_dias: 90 },
        { ejecutivo_id: 1 }, { telefono: '+56 9 1234 5678', nombre: 'Otro' }, {},
    ]) {
        assert.equal((await pedirConToken('PATCH', '/api/clientes/mia', A.token, cuerpo)).status, 400, JSON.stringify(cuerpo));
    }
    assert.deepEqual(await filaCliente(A.clienteId), antes);
    assert.equal((await cambiosDe(A.clienteId)).length, 0);
});

test('PATCH /mia valida el correo, los largos y las coordenadas a medias', async (t) => {
    if (!requiereBase(t)) return;
    const antes = await filaCliente(A.clienteId);
    for (const cuerpo of [
        { email: '' }, { email: null }, { email: 'no-es-correo' }, { horario_trabajo: 'x'.repeat(101) },
        { latitud: -38.7 }, { latitud: 200, longitud: 0 },
    ]) {
        assert.equal((await pedirConToken('PATCH', '/api/clientes/mia', A.token, cuerpo)).status, 400, JSON.stringify(cuerpo));
    }
    assert.deepEqual(await filaCliente(A.clienteId), antes);
});

test('PATCH /mia actualiza solo lo enviado, devuelve la ficha y registra el cambio', async (t) => {
    if (!requiereBase(t)) return;
    const antes = await filaCliente(A.clienteId);
    const r = await pedirConToken('PATCH', '/api/clientes/mia', A.token, {
        email: ' Nuevo.Contacto@Empresa.CL ', telefono: '+56 9 5555 4444', horario_trabajo: '08:00-18:00',
        latitud: -38.7359, longitud: -72.5904,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), CAMPOS_FICHA);
    assert.equal(r.body.email, 'nuevo.contacto@empresa.cl');
    assert.equal(r.body.telefono, '+56 9 5555 4444');
    assert.equal(r.body.latitud, -38.7359);
    assert.equal(r.body.direccion, antes.direccion, 'lo que no viene no cambia');
    assert.equal(r.body.nombre, antes.nombre);

    const filas = await cambiosDe(A.clienteId);
    assert.equal(filas.length, 1);
    assert.equal(filas[0].usuario_id, A.usuario.id);
    assert.equal(filas[0].rol, 'cliente');
    assert.equal(filas[0].origen, 'portal');
    assert.deepEqual(filas[0].cambios.email, { antes: antes.email, despues: 'nuevo.contacto@empresa.cl' });
    assert.deepEqual(filas[0].cambios.telefono, { antes: '+56 9 1111 2222', despues: '+56 9 5555 4444' });
    assert.deepEqual(filas[0].cambios.horario_trabajo, { antes: null, despues: '08:00-18:00' });
    assert.deepEqual(filas[0].cambios.latitud, { antes: null, despues: -38.7359 });
    assert.equal(filas[0].cambios.direccion, undefined, 'solo queda lo que cambio');

    // GET devuelve lo mismo; B sigue igual
    const g = await pedirConToken('GET', '/api/clientes/mia', A.token);
    assert.deepEqual(g.body, r.body);
    assert.notEqual((await pedirConToken('GET', '/api/clientes/mia', B.token)).body.email, r.body.email);
    assert.equal((await cambiosDe(B.clienteId)).length, 0);
});

test('un PATCH que no cambia nada no escribe registro; quitar la ubicacion si queda registrado', async (t) => {
    if (!requiereBase(t)) return;
    const ficha = (await pedirConToken('GET', '/api/clientes/mia', A.token)).body;
    const antes = (await cambiosDe(A.clienteId)).length;
    const igual = await pedirConToken('PATCH', '/api/clientes/mia', A.token, { email: ficha.email, telefono: ficha.telefono });
    assert.equal(igual.status, 200);
    assert.deepEqual(igual.body, ficha);
    assert.equal((await cambiosDe(A.clienteId)).length, antes);

    const borrar = await pedirConToken('PATCH', '/api/clientes/mia', A.token, { latitud: null, longitud: null, direccion: '' });
    assert.equal(borrar.status, 200);
    assert.equal(borrar.body.latitud, null);
    assert.equal(borrar.body.direccion, null);
    const filas = await cambiosDe(A.clienteId);
    assert.equal(filas.length, antes + 1);
    assert.deepEqual(filas.at(-1).cambios.latitud, { antes: -38.7359, despues: null });
});

test('clientes_cambios es de solo insercion: UPDATE, DELETE y TRUNCATE fallan', async (t) => {
    if (!requiereBase(t)) return;
    const [fila] = await cambiosDe(A.clienteId);
    assert.ok(fila, 'la prueba anterior dejo un registro');
    await assert.rejects(pool.query("UPDATE clientes_cambios SET rol = 'otro' WHERE id = $1", [fila.id]), /solo insercion/);
    await assert.rejects(pool.query('DELETE FROM clientes_cambios WHERE id = $1', [fila.id]), /solo insercion/);
    await assert.rejects(pool.query('TRUNCATE clientes_cambios'), /solo insercion/);
    // la clave foranea impide borrar la empresa y dejar el historial huerfano
    await assert.rejects(pool.query('DELETE FROM clientes WHERE id = $1', [A.clienteId]));
});

test('la edicion de la oficina (PATCH /:id) no registra cambios en clientes_cambios', async (t) => {
    if (!requiereBase(t)) return;
    const antes = (await cambiosDe(B.clienteId)).length;
    const r = await pedir('PATCH', `/api/clientes/${B.clienteId}`, 'administrativo', { telefono: '+56 9 7777 6666' });
    assert.equal(r.status, 200);
    assert.equal((await cambiosDe(B.clienteId)).length, antes);
});
