// Pruebas de escritura del recurso de clientes: giro, plazo de pago e historial
// (GET /api/clientes/:id/historial). Mismo patron que mapaEscritura.test.js: rutas en memoria sobre la
// base de DATABASE_URL, datos propios que se borran al terminar y tokens firmados con un secreto de la prueba.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-del-historial-de-clientes';

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
const datos = { clientes: [], equipos: [], guias: [], ordenes: [], facturas: [] };

async function pedir(metodo, ruta, rol, cuerpo) {
    const headers = { 'Content-Type': 'application/json' };
    if (rol) headers.Authorization = `Bearer ${tokens[rol]}`;
    const r = await fetch(`${base}${ruta}`, {
        method: metodo,
        headers,
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    return leerRespuesta(r);
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
         WHERE email IN ('administrativo@gomaq.test', 'mecanico@gomaq.test', 'admin@gomaq.test', 'cliente@gomaq.test')`
    );
    const porEmail = Object.fromEntries(usuarios.rows.map((u) => [u.email, u]));
    const firmar = (u) => jwt.sign({ id: u.id, rol: u.rol, cliente_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokens.administrativo = firmar(porEmail['administrativo@gomaq.test']);
    tokens.gerente = firmar(porEmail['admin@gomaq.test']);
    tokens.mecanico = firmar(porEmail['mecanico@gomaq.test']);
    tokens.cliente = firmar(porEmail['cliente@gomaq.test']);
});

after(async () => {
    if (!HABILITADO) return;
    if (datos.facturas.length) await pool.query('DELETE FROM facturas WHERE id = ANY($1)', [datos.facturas]);
    if (datos.ordenes.length) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL gomaq.purga = 'on'");
            await client.query('DELETE FROM ordenes_eventos WHERE orden_trabajo_id = ANY($1)', [datos.ordenes]);
            await client.query('DELETE FROM ordenes_trabajo WHERE id = ANY($1)', [datos.ordenes]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
    if (datos.guias.length) await pool.query('DELETE FROM guias WHERE id = ANY($1)', [datos.guias]);
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

async function crearEquipo() {
    const r = await pool.query(
        'INSERT INTO maquinarias (codigo, tipo) VALUES ($1, $2) RETURNING id, codigo',
        [`HIS-${crypto.randomUUID().slice(0, 6).toUpperCase()}`, 'Grua de prueba']
    );
    datos.equipos.push(r.rows[0].id);
    return r.rows[0];
}

test('sin token responde 401; mecanico y cliente reciben 403', async (t) => {
    if (!requiereBase(t)) return;
    assert.equal((await pedir('GET', '/api/clientes/1/historial', null)).status, 401);
    for (const rol of ['mecanico', 'cliente']) {
        assert.equal((await pedir('GET', '/api/clientes/1/historial', rol)).status, 403, rol);
    }
});

test('id invalido responde 400 e id inexistente 404', async (t) => {
    if (!requiereBase(t)) return;
    for (const id of ['abc', '0', '-3', '1.5']) {
        assert.equal((await pedir('GET', `/api/clientes/${id}/historial`, 'administrativo')).status, 400, id);
    }
    assert.equal((await pedir('GET', '/api/clientes/2147483647/historial', 'gerente')).status, 404);
});

test('el historial trae lo del cliente y nada de otro, sin documentos', async (t) => {
    if (!requiereBase(t)) return;
    const a = await crearCliente('Historial A');
    const b = await crearCliente('Historial B');
    const equipoA = await crearEquipo();
    const equipoB = await crearEquipo();
    const guiaA = (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id)
         VALUES ($1, 'despacho', 'guias/secreto-a.pdf', '2026-03-10T14:00:00-03:00', $2) RETURNING id`, [equipoA.id, a])).rows[0].id;
    const guiaB = (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id)
         VALUES ($1, 'despacho', 'guias/secreto-b.pdf', '2026-03-11T14:00:00-03:00', $2) RETURNING id`, [equipoB.id, b])).rows[0].id;
    datos.guias.push(guiaA, guiaB);
    const otA = (await pool.query(
        `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, motivo) VALUES ($1, $2, 'prueba') RETURNING id`, [equipoA.id, a])).rows[0].id;
    const otB = (await pool.query(
        `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, motivo) VALUES ($1, $2, 'prueba') RETURNING id`, [equipoB.id, b])).rows[0].id;
    datos.ordenes.push(otA, otB);
    const facA = (await pool.query(
        `INSERT INTO facturas (folio, archivo_url, monto, fecha_emision, cliente_id, maquinaria_id, guia_despacho_id)
         VALUES ('HA-1', 'facturas/secreto-a.pdf', 119000, '2026-04-01', $1, $2, $3) RETURNING id`, [a, equipoA.id, guiaA])).rows[0].id;
    const facB = (await pool.query(
        `INSERT INTO facturas (folio, archivo_url, monto, fecha_emision, cliente_id, maquinaria_id, guia_despacho_id)
         VALUES ('HB-1', 'facturas/secreto-b.pdf', 500000, '2026-04-02', $1, $2, $3) RETURNING id`, [b, equipoB.id, guiaB])).rows[0].id;
    datos.facturas.push(facA, facB);

    for (const rol of ['administrativo', 'gerente']) {
        const r = await pedir('GET', `/api/clientes/${a}/historial`, rol);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.cliente.id, a);
        assert.deepEqual(r.body.arriendos.map((x) => x.maquinaria_id), [equipoA.id]);
        assert.equal(r.body.arriendos[0].en_curso, true);
        assert.deepEqual(r.body.facturas.map((x) => x.folio), ['HA-1']);
        assert.deepEqual(r.body.ordenes.map((x) => x.id), [otA]);
        assert.equal(r.body.resumen.total_facturado, 119000);
        assert.equal(r.body.resumen.facturas, 1);
        assert.equal(r.body.resumen.equipos_arrendados_hoy, 1);
        const texto = JSON.stringify(r.body);
        assert.equal(texto.includes('secreto'), false, 'no hay documentos');
        assert.equal(texto.includes('archivo_url'), false);
        assert.equal(texto.includes('HB-1'), false, 'nada del otro cliente');
        assert.equal(texto.includes(equipoB.codigo), false);
    }
});

test('crear y editar guardan giro y plazo; el plazo se valida', async (t) => {
    if (!requiereBase(t)) return;
    const crear = await pedir('POST', '/api/clientes', 'administrativo', {
        nombre: `Plazo ${crypto.randomUUID().slice(0, 6)}`, giro: 'Construccion', direccion: 'Calle 1', plazo_pago_dias: 30,
    });
    assert.equal(crear.status, 201, JSON.stringify(crear.body));
    datos.clientes.push(crear.body.id);
    assert.equal(crear.body.giro, 'Construccion');
    assert.equal(crear.body.direccion, 'Calle 1');
    assert.equal(crear.body.plazo_pago_dias, 30);

    // sin los campos nuevos (panel anterior): nulos
    const vieja = await pedir('POST', '/api/clientes', 'gerente', { nombre: `Sin plazo ${crypto.randomUUID().slice(0, 6)}` });
    assert.equal(vieja.status, 201);
    datos.clientes.push(vieja.body.id);
    assert.equal(vieja.body.plazo_pago_dias, null);
    assert.equal(vieja.body.giro, null);

    assert.equal((await pedir('POST', '/api/clientes', 'administrativo', { nombre: 'X', plazo_pago_dias: 366 })).status, 400);
    assert.equal((await pedir('POST', '/api/clientes', 'administrativo', { nombre: 'X', plazo_pago_dias: 1.5 })).status, 400);

    const edit = await pedir('PATCH', `/api/clientes/${crear.body.id}`, 'administrativo', { plazo_pago_dias: 0, giro: 'Mineria' });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    assert.equal(edit.body.plazo_pago_dias, 0, '0 es contado');
    assert.equal(edit.body.giro, 'Mineria');
    assert.equal((await pedir('PATCH', `/api/clientes/${crear.body.id}`, 'administrativo', { plazo_pago_dias: -1 })).status, 400);
    assert.equal((await pedir('PATCH', `/api/clientes/${crear.body.id}`, 'administrativo', { plazo_pago_dias: 'abc' })).status, 400);

    const lista = await pedir('GET', '/api/clientes', 'gerente');
    const fila = lista.body.find((c) => c.id === crear.body.id);
    assert.equal(fila.plazo_pago_dias, 0);
    assert.equal(fila.giro, 'Mineria');
});
