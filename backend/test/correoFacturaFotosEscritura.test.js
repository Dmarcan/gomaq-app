// Pruebas de escritura de las fotos del antes y el despues en el correo de factura: vista previa con
// miniaturas, autorizar el envio con foto_ids y las reglas de pertenencia, sobre la base de DATABASE_URL.
// Rutas en memoria, datos propios que se borran al terminar, tokens firmados con un secreto de la prueba y
// Supabase simulado (la firma devuelve una URL de mentira y la descarga entrega una foto generada aqui).
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-fotos-del-correo-de-factura';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { requiereBase, servirApp } = require('./utils/http');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
let fotoJpeg;
const tokens = {};
const datos = { clientes: [], equipos: [], ordenes: [], facturas: [] };

async function llamar(metodo, ruta, token, cuerpo) {
    const r = await fetch(`${base}${ruta}`, {
        method: metodo,
        headers: { Authorization: `Bearer ${token}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    let body = null;
    try { body = await r.json(); } catch (_) { /* sin cuerpo */ }
    return { status: r.status, body };
}

before(async () => {
    if (!HABILITADO) return;
    exigirBaseLocal();
    const express = require('express');
    pool = require('../src/config/db');
    require('../src/middleware/auth').usarBuscadorDeUsuarios(async (id) => {
        const r = await pool.query('SELECT rol, cliente_id, estado_cuenta, password_cambiada_at FROM usuarios WHERE id = $1', [id]);
        return r.rows[0] || null;
    });
    fotoJpeg = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: { r: 30, g: 120, b: 200 } } }).jpeg().toBuffer();
    const { supabase } = require('../src/config/supabase');
    supabase.storage.from = () => ({
        createSignedUrl: async (ruta) => ({ data: { signedUrl: `https://firmada.test/${ruta}?token=t` }, error: null }),
        download: async (ruta) => (ruta.includes('inexistente')
            ? { data: null, error: { message: 'Object not found', statusCode: '404' } }
            : { data: { arrayBuffer: async () => fotoJpeg.buffer.slice(fotoJpeg.byteOffset, fotoJpeg.byteOffset + fotoJpeg.byteLength) }, error: null }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api/ordenes-trabajo', require('../src/routes/facturas'));
    app.use('/api/facturacion', require('../src/routes/facturacion'));
    ({ servidor, base } = await servirApp(app));

    const usuarios = await pool.query(`SELECT id, rol, email FROM usuarios WHERE email IN ('administrativo@gomaq.test', 'admin@gomaq.test')`);
    const porEmail = Object.fromEntries(usuarios.rows.map((u) => [u.email, u]));
    const firmar = (u) => jwt.sign({ id: u.id, rol: u.rol, cliente_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokens.administrativo = firmar(porEmail['administrativo@gomaq.test']);
    tokens.gerente = firmar(porEmail['admin@gomaq.test']);
});

after(async () => {
    if (!HABILITADO) return;
    if (datos.facturas.length) {
        await pool.query(
            `DELETE FROM notificaciones_pendientes WHERE payload->>'tipo' = 'factura_emitida' AND (payload->>'factura_id')::int = ANY($1)`,
            [datos.facturas]
        );
        await pool.query('DELETE FROM facturas WHERE id = ANY($1)', [datos.facturas]);
    }
    if (datos.ordenes.length) {
        await pool.query('DELETE FROM evidencias_fotograficas WHERE orden_trabajo_id = ANY($1)', [datos.ordenes]);
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
    if (datos.equipos.length) await pool.query('DELETE FROM maquinarias WHERE id = ANY($1)', [datos.equipos]);
    if (datos.clientes.length) await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [datos.clientes]);
    await new Promise((resolve) => servidor.close(resolve));
    await pool.end();
});

/** Cliente con correo, equipo, OT finalizada con 2 fotos antes y 1 despues, y su factura de reparacion. */
async function crearFacturaConFotos() {
    const cliente = (await pool.query(
        'INSERT INTO clientes (nombre, email) VALUES ($1, $2) RETURNING id', [`Fotos ${crypto.randomUUID().slice(0, 6)}`, 'cliente.fotos@gomaq.test']
    )).rows[0].id;
    datos.clientes.push(cliente);
    const equipo = (await pool.query(
        'INSERT INTO maquinarias (codigo, tipo) VALUES ($1, $2) RETURNING id', [`FOT-${crypto.randomUUID().slice(0, 6).toUpperCase()}`, 'Grua de prueba']
    )).rows[0].id;
    datos.equipos.push(equipo);
    const ot = (await pool.query(
        `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo, facturable, fecha_cierre)
         VALUES ($1, $2, 'finalizada', 'Falla', true, now()) RETURNING id`, [equipo, cliente]
    )).rows[0].id;
    datos.ordenes.push(ot);
    const fotos = (await pool.query(
        `INSERT INTO evidencias_fotograficas (orden_trabajo_id, path, tipo)
         VALUES ($1, $2, 'antes'), ($1, $3, 'antes'), ($1, $4, 'despues') RETURNING id, tipo`,
        [ot, `antes/ot-${ot}/a1.jpg`, `antes/ot-${ot}/a2.jpg`, `despues/ot-${ot}/d1.jpg`]
    )).rows;
    const factura = (await pool.query(
        `INSERT INTO facturas (folio, archivo_url, monto, orden_trabajo_id, cliente_id) VALUES ($1, 'facturas/prueba.pdf', 1000, $2, $3) RETURNING id`,
        [`FT-${crypto.randomUUID().slice(0, 6)}`, ot, cliente]
    )).rows[0].id;
    datos.facturas.push(factura);
    return { cliente, ot, factura, fotos };
}

test('la vista previa no repite las fotos (las trae /evidencia) y sin correo anterior no hay seleccion previa', async (t) => {
    if (!requiereBase(t)) return;
    const { factura } = await crearFacturaConFotos();
    const r = await llamar('GET', `/api/facturacion/${factura}/vista-previa`, tokens.gerente);
    assert.equal(r.status, 200);
    assert.equal('fotos' in r.body, false);
    assert.deepEqual(r.body.fotos_elegidas_antes, []);
    assert.ok(r.body.orden_trabajo_id);
});

test('una factura sin orden de trabajo (arriendo) no tiene seleccion previa de fotos', async (t) => {
    if (!requiereBase(t)) return;
    const { cliente } = await crearFacturaConFotos();
    const equipo = datos.equipos[datos.equipos.length - 1];
    const f = (await pool.query(
        `INSERT INTO facturas (folio, archivo_url, monto, maquinaria_id, cliente_id) VALUES ($1, 'facturas/prueba.pdf', 500, $2, $3) RETURNING id`,
        [`FA-${crypto.randomUUID().slice(0, 6)}`, equipo, cliente]
    )).rows[0].id;
    datos.facturas.push(f);
    const r = await llamar('GET', `/api/facturacion/${f}/vista-previa`, tokens.gerente);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.fotos_elegidas_antes, []);
});

test('autorizar el envio con fotos guarda foto_ids en el aviso, y la vista previa recuerda la seleccion', async (t) => {
    if (!requiereBase(t)) return;
    const { factura, fotos } = await crearFacturaConFotos();
    const elegidas = [fotos[0].id, fotos[2].id];
    const r = await llamar('POST', `/api/facturacion/${factura}/autorizar-envio`, tokens.administrativo, { foto_ids: elegidas });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const aviso = (await pool.query(
        `SELECT payload FROM notificaciones_pendientes WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1::text`, [factura]
    )).rows;
    assert.equal(aviso.length, 1);
    assert.deepEqual(aviso[0].payload.foto_ids, elegidas);
    const vista = await llamar('GET', `/api/facturacion/${factura}/vista-previa`, tokens.gerente);
    assert.deepEqual(vista.body.fotos_elegidas_antes, elegidas);
});

test('un reenvio sin foto_ids repite la seleccion del ultimo correo; con una lista vacia, sin fotos', async (t) => {
    if (!requiereBase(t)) return;
    const { factura, fotos } = await crearFacturaConFotos();
    const elegidas = [fotos[2].id, fotos[0].id];
    const autorizar = (cuerpo) => llamar('POST', `/api/facturacion/${factura}/autorizar-envio`, tokens.administrativo, cuerpo);
    const avisos = async () => (await pool.query(
        `SELECT id, payload FROM notificaciones_pendientes WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1::text ORDER BY id`, [factura]
    )).rows;
    const marcarEnviados = async () => pool.query(`UPDATE notificaciones_pendientes SET estado = 'enviado' WHERE id = ANY($1)`, [(await avisos()).map((a) => a.id)]);

    assert.equal((await autorizar({ foto_ids: elegidas })).status, 200);
    await marcarEnviados(); // si no, el reenvio responderia 409 por envio pendiente
    assert.equal((await autorizar({})).status, 200);
    let todos = await avisos();
    assert.deepEqual(todos[todos.length - 1].payload.foto_ids, elegidas);

    const vista = await llamar('GET', `/api/facturacion/${factura}/vista-previa`, tokens.gerente);
    assert.deepEqual(vista.body.fotos_elegidas_antes, elegidas);

    await marcarEnviados();
    assert.equal((await autorizar({ foto_ids: [] })).status, 200);
    todos = await avisos();
    assert.equal('foto_ids' in todos[todos.length - 1].payload, false);
});

test('sin foto_ids el correo se encola como siempre, sin el campo', async (t) => {
    if (!requiereBase(t)) return;
    const { factura } = await crearFacturaConFotos();
    const r = await llamar('POST', `/api/facturacion/${factura}/autorizar-envio`, tokens.administrativo, {});
    assert.equal(r.status, 200);
    const aviso = (await pool.query(
        `SELECT payload FROM notificaciones_pendientes WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1::text`, [factura]
    )).rows[0];
    assert.equal('foto_ids' in aviso.payload, false);
});

test('el aviso lleva las fechas de emision y vencimiento (para el resumen del correo), y sin ellas queda en null', async (t) => {
    if (!requiereBase(t)) return;
    const conFechas = await crearFacturaConFotos();
    await pool.query(`UPDATE facturas SET fecha_emision = '2026-11-19', fecha_vencimiento = '2026-12-19' WHERE id = $1`, [conFechas.factura]);
    const sinFechas = await crearFacturaConFotos();
    for (const { factura } of [conFechas, sinFechas]) {
        assert.equal((await llamar('POST', `/api/facturacion/${factura}/autorizar-envio`, tokens.administrativo, {})).status, 200);
    }
    const payloadDe = async (factura) => (await pool.query(
        `SELECT payload FROM notificaciones_pendientes WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1::text`, [factura]
    )).rows[0].payload;
    const a = await payloadDe(conFechas.factura);
    assert.equal(a.fecha_emision, '2026-11-19');
    assert.equal(a.fecha_vencimiento, '2026-12-19');
    const b = await payloadDe(sinFechas.factura);
    assert.equal(b.fecha_emision, null);
    assert.equal(b.fecha_vencimiento, null);
    // el asunto propuesto por el servidor ya viene con la orden de trabajo
    const vista = await llamar('GET', `/api/facturacion/${conFechas.factura}/vista-previa`, tokens.gerente);
    assert.match(vista.body.asunto, new RegExp(`^Factura folio .+ · Orden de trabajo #${conFechas.ot} · GOMAQ$`));
});

test('una factura que no existe responde 404 y no encola nada, con o sin fotos en la peticion', async (t) => {
    if (!requiereBase(t)) return;
    const inexistente = 987654321;
    for (const cuerpo of [{}, { foto_ids: [] }, { foto_ids: [1] }]) {
        const r = await llamar('POST', `/api/facturacion/${inexistente}/autorizar-envio`, tokens.administrativo, cuerpo);
        assert.equal(r.status, 404, `cuerpo ${JSON.stringify(cuerpo)}: ${JSON.stringify(r.body)}`);
    }
    const n = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM notificaciones_pendientes WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1::text`, [inexistente]
    )).rows[0].n;
    assert.equal(n, 0);
});

test('la ruta por orden tambien acepta foto_ids', async (t) => {
    if (!requiereBase(t)) return;
    const { ot, factura, fotos } = await crearFacturaConFotos();
    const r = await llamar('POST', `/api/ordenes-trabajo/${ot}/factura/${factura}/autorizar-envio`, tokens.administrativo, { foto_ids: [fotos[1].id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const aviso = (await pool.query(
        `SELECT payload FROM notificaciones_pendientes WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1::text`, [factura]
    )).rows[0];
    assert.deepEqual(aviso.payload.foto_ids, [fotos[1].id]);
});

test('una foto de otra orden se rechaza y no se encola nada', async (t) => {
    if (!requiereBase(t)) return;
    const a = await crearFacturaConFotos();
    const b = await crearFacturaConFotos();
    const r = await llamar('POST', `/api/facturacion/${a.factura}/autorizar-envio`, tokens.administrativo, { foto_ids: [b.fotos[0].id] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /no pertenece a esta orden/);
    const n = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM notificaciones_pendientes WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1::text`, [a.factura]
    )).rows[0].n;
    assert.equal(n, 0);
});

test('un archivo de foto que ya no esta en el almacenamiento responde 409', async (t) => {
    if (!requiereBase(t)) return;
    const { ot, factura } = await crearFacturaConFotos();
    const f = (await pool.query(
        `INSERT INTO evidencias_fotograficas (orden_trabajo_id, path, tipo) VALUES ($1, $2, 'despues') RETURNING id`, [ot, `despues/ot-${ot}/inexistente.jpg`]
    )).rows[0].id;
    const r = await llamar('POST', `/api/facturacion/${factura}/autorizar-envio`, tokens.administrativo, { foto_ids: [f] });
    assert.equal(r.status, 409);
});

test('ids invalidos y mas de 12 fotos responden 400', async (t) => {
    if (!requiereBase(t)) return;
    const { factura } = await crearFacturaConFotos();
    assert.equal((await llamar('POST', `/api/facturacion/${factura}/autorizar-envio`, tokens.administrativo, { foto_ids: 'todas' })).status, 400);
    assert.equal((await llamar('POST', `/api/facturacion/${factura}/autorizar-envio`, tokens.administrativo, { foto_ids: Array.from({ length: 13 }, (_, i) => i + 1) })).status, 400);
});

test('solo el administrativo autoriza el envio (el gerente no)', async (t) => {
    if (!requiereBase(t)) return;
    const { factura, fotos } = await crearFacturaConFotos();
    assert.equal((await llamar('POST', `/api/facturacion/${factura}/autorizar-envio`, tokens.gerente, { foto_ids: [fotos[0].id] })).status, 403);
});
