// GET /api/notificaciones agrega `factura_existe` a los correos de factura: el panel ofrece "Reenviar correo" solo
// donde la factura sigue existiendo. Rutas en memoria sobre la base de DATABASE_URL, datos propios que se borran al
// terminar y tokens firmados con un secreto de la prueba.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-factura-existe-en-notificaciones';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { requiereBase, servirApp } = require('./utils/http');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
let token;
let equipo;
let factura;
const marca = `FEX-${crypto.randomUUID().slice(0, 8)}`; // identifica las filas de esta prueba en la lista
const avisos = [];

async function listar(ruta) {
    const r = await fetch(`${base}${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json() };
}

async function insertarAviso(canal, destinatario, payload, estado = 'enviado', ultimoError = null) {
    const r = await pool.query(
        `INSERT INTO notificaciones_pendientes (canal, destinatario, payload, estado, ultimo_error) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [canal, destinatario, JSON.stringify(payload), estado, ultimoError]
    );
    avisos.push(r.rows[0].id);
    return r.rows[0].id;
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
    const app = express();
    app.use(express.json());
    app.use('/api/notificaciones', require('../src/routes/notificaciones'));
    ({ servidor, base } = await servirApp(app));
    const u = (await pool.query(`SELECT id, rol FROM usuarios WHERE email = 'administrativo@gomaq.test'`)).rows[0];
    token = jwt.sign({ id: u.id, rol: u.rol, cliente_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' });

    equipo = (await pool.query('INSERT INTO maquinarias (codigo, tipo) VALUES ($1, $2) RETURNING id', [marca, 'Grua de prueba'])).rows[0].id;
    factura = (await pool.query(
        `INSERT INTO facturas (folio, archivo_url, monto, maquinaria_id) VALUES ($1, 'facturas/prueba.pdf', 1000, $2) RETURNING id`, [marca, equipo]
    )).rows[0].id;
});

after(async () => {
    if (!HABILITADO) return;
    if (avisos.length) await pool.query('DELETE FROM notificaciones_pendientes WHERE id = ANY($1)', [avisos]);
    if (factura) await pool.query('DELETE FROM facturas WHERE id = $1', [factura]);
    if (equipo) await pool.query('DELETE FROM maquinarias WHERE id = $1', [equipo]);
    await new Promise((resolve) => servidor.close(resolve));
    await pool.end();
});

test('un correo de factura dice si la factura existe; el resto de las filas trae null', async (t) => {
    if (!requiereBase(t)) return;
    const FACTURA_BORRADA = 987654321;
    await insertarAviso('email', `${marca}-vigente@x.cl`, { tipo: 'factura_emitida', factura_id: factura, folio: marca });
    await insertarAviso('email', `${marca}-borrada@x.cl`, { tipo: 'factura_emitida', factura_id: FACTURA_BORRADA, folio: marca });
    await insertarAviso('email', `${marca}-textoid@x.cl`, { tipo: 'factura_emitida', factura_id: 'abc', folio: marca });
    await insertarAviso('email', `${marca}-sinid@x.cl`, { tipo: 'factura_emitida', folio: marca });
    await insertarAviso('email', `${marca}-otrotipo@x.cl`, { tipo: 'cuenta_aprobada', factura_id: factura });
    await insertarAviso('whatsapp', `${marca}-wsp`, { tipo: 'factura_emitida', factura_id: factura });

    const r = await listar('/api/notificaciones');
    assert.equal(r.status, 200);
    const de = (sufijo) => r.body.find((n) => String(n.destinatario).startsWith(marca) && String(n.destinatario).includes(sufijo));
    assert.equal(de('vigente').factura_existe, true);
    assert.equal(de('borrada').factura_existe, false);
    assert.equal(de('textoid').factura_existe, null, 'un id que no es numerico no se castea ni revienta la consulta');
    assert.equal(de('sinid').factura_existe, null);
    assert.equal(de('otrotipo').factura_existe, null, 'solo los correos de factura_emitida');
    assert.equal(de('wsp').factura_existe, null, 'solo el canal email');
});

test('tambien viene en la lista de avisos con problemas y con el filtro de canal', async (t) => {
    if (!requiereBase(t)) return;
    await insertarAviso('email', `${marca}-error@x.cl`, { tipo: 'factura_emitida', factura_id: factura, folio: marca }, 'error', 'El proveedor rechazo el correo');
    const problemas = await listar('/api/notificaciones?problemas=1');
    assert.equal(problemas.status, 200);
    const fila = problemas.body.items.find((n) => n.destinatario === `${marca}-error@x.cl`);
    assert.ok(fila, 'el aviso con error debe estar en la lista de problemas');
    assert.equal(fila.factura_existe, true);
    const porCanal = await listar('/api/notificaciones?canal=email');
    assert.equal(porCanal.status, 200);
    assert.equal(porCanal.body.find((n) => n.destinatario === `${marca}-error@x.cl`).factura_existe, true);
});
