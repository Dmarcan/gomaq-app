// Pruebas de escritura del detalle de una orden para el cliente (GET /api/ordenes-trabajo/mias/:id).
// Mismo patron que lineaTiempoEscritura.test.js: rutas en memoria sobre la base de DATABASE_URL, datos
// propios que se borran al terminar, tokens firmados con un secreto de la prueba y Supabase simulado.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-del-detalle-de-ot-del-cliente';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { requiereBase, servirApp } = require('./utils/http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
const tokens = {};
const datos = { clientes: [], equipos: [], ordenes: [] };

async function pedir(ruta, token) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const r = await fetch(`${base}${ruta}`, { headers });
    let body = null;
    try { body = await r.json(); } catch (_) { /* sin cuerpo */ }
    return { status: r.status, body, cabeceras: r.headers };
}

const tokenCliente = (idUsuario, clienteId) => jwt.sign({ id: idUsuario, rol: 'cliente', cliente_id: clienteId }, process.env.JWT_SECRET, { expiresIn: '1h' });

before(async () => {
    if (!HABILITADO) return;
    exigirBaseLocal();
    const express = require('express');
    pool = require('../src/config/db');
    // los tokens de relleno de cliente (ids 98770x, que no existen) valen lo que firman; los usuarios reales se buscan en la base
    require('../src/middleware/auth').usarBuscadorDeUsuarios(async (id, claims) => {
        if (id >= 987000) return { rol: claims.rol, cliente_id: claims.cliente_id ?? null, estado_cuenta: 'activo' };
        const r = await pool.query('SELECT rol, cliente_id, estado_cuenta, password_cambiada_at FROM usuarios WHERE id = $1', [id]);
        return r.rows[0] || null;
    });
    // Supabase simulado: la firma devuelve una URL de mentira y la ruta nunca debe llegar al cliente
    const { supabase } = require('../src/config/supabase');
    supabase.storage.from = () => ({
        createSignedUrl: async (ruta) => ({ data: { signedUrl: `https://firmada.test/${ruta}?token=t` }, error: null }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api/ordenes-trabajo', require('../src/routes/ordenes'));
    ({ servidor, base } = await servirApp(app));

    const usuarios = await pool.query(
        `SELECT id, rol, email FROM usuarios
         WHERE email IN ('administrativo@gomaq.test', 'mecanico@gomaq.test', 'admin@gomaq.test')`
    );
    const porEmail = Object.fromEntries(usuarios.rows.map((u) => [u.email, u]));
    const firmar = (u) => jwt.sign({ id: u.id, rol: u.rol, cliente_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokens.administrativo = firmar(porEmail['administrativo@gomaq.test']);
    tokens.gerente = firmar(porEmail['admin@gomaq.test']);
    tokens.mecanico = firmar(porEmail['mecanico@gomaq.test']);
    datos.mecanicoId = porEmail['mecanico@gomaq.test'].id;
    tokens.clienteSinEmpresa = tokenCliente(987701, null);
});

after(async () => {
    if (!HABILITADO) return;
    const ots = datos.ordenes;
    if (ots.length) {
        await pool.query('DELETE FROM evidencias_fotograficas WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM movimientos_insumo WHERE orden_trabajo_id = ANY($1)', [ots]);
        // ordenes_eventos es de solo insercion: borrarlos exige la via de purga (migracion 020)
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL gomaq.purga = 'on'");
            await client.query('DELETE FROM ordenes_eventos WHERE orden_trabajo_id = ANY($1)', [ots]);
            await client.query('DELETE FROM ordenes_trabajo WHERE id = ANY($1)', [ots]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
    if (datos.equipos.length) await pool.query('DELETE FROM maquinarias WHERE id = ANY($1)', [datos.equipos]);
    if (datos.clientes.length) await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [datos.clientes]);
    await new Promise((resolve) => servidor.close(resolve));
    await pool.end();
});

async function crearCliente(nombre) {
    const r = await pool.query('INSERT INTO clientes (nombre) VALUES ($1) RETURNING id', [`${nombre} ${crypto.randomUUID().slice(0, 6)}`]);
    datos.clientes.push(r.rows[0].id);
    return r.rows[0].id;
}

/** OT finalizada de un cliente, valorizada y con una linea con precio, con eventos y dos fotos. */
async function crearOtCompleta(clienteId) {
    const equipo = (await pool.query(
        'INSERT INTO maquinarias (codigo, tipo) VALUES ($1, $2) RETURNING id, codigo',
        [`DET-${crypto.randomUUID().slice(0, 6).toUpperCase()}`, 'Grua de prueba']
    )).rows[0];
    datos.equipos.push(equipo.id);
    const ot = (await pool.query(
        `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo, diagnostico, observacion_final,
                                      facturable, valorizacion, fecha_cierre)
         VALUES ($1, $2, $3, 'finalizada', 'No levanta la pluma', 'Manguera rota', 'Se cambio la manguera', true, 987654, now())
         RETURNING id`,
        [equipo.id, clienteId, datos.mecanicoId]
    )).rows[0].id;
    datos.ordenes.push(ot);
    await pool.query(
        `INSERT INTO movimientos_insumo (orden_trabajo_id, cantidad, tipo, precio_unitario, descripcion, facturable)
         VALUES ($1, 1, 'salida', 55555, 'manguera hidraulica', 'si')`,
        [ot]
    );
    await pool.query(
        `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, estado_nuevo, rol, ocurrio_en, origen, detalle)
         VALUES ($1, 'creacion', 'pendiente', 'cliente', now() - interval '3 hours', 'panel', '{"secreto": 424242}'),
                ($1, 'asignacion', 'asignada', 'administrativo', now() - interval '2 hours', 'panel', NULL),
                ($1, 'cambio_estado', 'en_terreno', 'mecanico', now() - interval '1 hour', 'terreno', NULL),
                ($1, 'valorizacion', NULL, 'gerente', now() - interval '30 minutes', 'panel', '{"valorizacion": 987654}'),
                ($1, 'cierre', 'finalizada', 'mecanico', now(), 'terreno', NULL)`,
        [ot]
    );
    await pool.query(
        `INSERT INTO evidencias_fotograficas (orden_trabajo_id, path, tipo)
         VALUES ($1, $2, 'antes'), ($1, $3, 'despues')`,
        [ot, `ot-${ot}/antes-secreta.jpg`, `ot-${ot}/despues-secreta.jpg`]
    );
    return ot;
}

test('el cliente ve el detalle de su orden: linea de tiempo, fotos con URL y sin datos internos', async (t) => {
    if (!requiereBase(t)) return;
    const cliente = await crearCliente('Detalle');
    const ot = await crearOtCompleta(cliente);
    const r = await pedir(`/api/ordenes-trabajo/mias/${ot}`, tokenCliente(987702, cliente));
    assert.equal(r.status, 200);
    assert.equal(r.cabeceras.get('cache-control'), 'no-store');
    assert.equal(r.body.id, ot);
    assert.equal(r.body.motivo, 'No levanta la pluma');
    assert.equal(r.body.diagnostico, 'Manguera rota');
    assert.equal(r.body.observacion_final, 'Se cambio la manguera');
    assert.equal(r.body.cobro, 'con_cobro');
    assert.deepEqual(r.body.linea_tiempo.map((p) => p.texto),
        ['Solicitud recibida', 'Técnico asignado', 'Trabajando en tu equipo', 'Finalizada']);
    assert.equal(r.body.fotos.length, 2);
    assert.deepEqual(r.body.fotos.map((f) => f.tipo).sort(), ['antes', 'despues']);
    for (const f of r.body.fotos) {
        assert.match(f.url, /^https:\/\/firmada\.test\//);
        assert.ok(!('path' in f), 'la ruta del bucket no sale');
    }
    // la ruta del bucket no se busca como texto: el mock de la URL firmada la incluye por construccion (arriba se
    // comprueba que no viaje como campo `path`)
    const texto = JSON.stringify(r.body);
    for (const prohibido of ['987654', '55555', '424242', 'valorizacion', 'precio', 'facturable', 'usuario_id']) {
        assert.ok(!texto.includes(prohibido), `no debe aparecer ${prohibido}`);
    }
});

test('una orden de otra empresa o inexistente responde 404 igual; un id invalido, 400', async (t) => {
    if (!requiereBase(t)) return;
    const duena = await crearCliente('Duena');
    const otra = await crearCliente('Otra');
    const ot = await crearOtCompleta(duena);
    const ajena = await pedir(`/api/ordenes-trabajo/mias/${ot}`, tokenCliente(987703, otra));
    const inexistente = await pedir('/api/ordenes-trabajo/mias/99999999', tokenCliente(987703, otra));
    assert.equal(ajena.status, 404);
    assert.equal(inexistente.status, 404);
    assert.deepEqual(ajena.body, inexistente.body, 'no se distingue una ajena de una que no existe');
    for (const id of ['abc', '0', '-3', '1.5']) {
        assert.equal((await pedir(`/api/ordenes-trabajo/mias/${id}`, tokenCliente(987703, otra))).status, 400, `id ${id}`);
    }
});

test('el personal no usa esta ruta (403) y un cliente sin empresa recibe 400', async (t) => {
    if (!requiereBase(t)) return;
    const cliente = await crearCliente('Roles');
    const ot = await crearOtCompleta(cliente);
    for (const rol of ['administrativo', 'gerente', 'mecanico']) {
        assert.equal((await pedir(`/api/ordenes-trabajo/mias/${ot}`, tokens[rol])).status, 403, rol);
    }
    assert.equal((await pedir(`/api/ordenes-trabajo/mias/${ot}`, tokens.clienteSinEmpresa)).status, 400);
    assert.equal((await pedir(`/api/ordenes-trabajo/mias/${ot}`, null)).status, 401);
});
