// Pruebas de la ruta POST /api/ordenes-trabajo/:id/posicion. Protegen por la ruta la regla de
// privacidad: la posicion del mecanico solo se guarda mientras la OT esta 'en_camino'. Mismo patron
// que mapaEscritura.test.js: rutas en memoria sobre la base de DATABASE_URL, datos propios que se
// borran al terminar y tokens firmados con un secreto de la prueba.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-posicion';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
let llaveOriginal;
const tokens = {};
const datos = { ordenes: [], equipos: [], mecanicoId: null, otroMecanicoId: null };

function requiereBase(t) {
    if (!HABILITADO) {
        t.skip('pruebas de escritura deshabilitadas: usar GOMAQ_TEST_ESCRITURA=1 con una base local');
        return false;
    }
    return true;
}

async function pedir(metodo, ruta, rol, cuerpo) {
    const r = await fetch(`${base}${ruta}`, {
        method: metodo,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[rol]}` },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    let json = null;
    try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
    return { status: r.status, body: json };
}

function posicionValida(extra = {}) {
    return { latitud: -33.42, longitud: -70.61, precision_m: 8, capturada_en: new Date().toISOString(), ...extra };
}

async function crearOt(estado, mecanicoId) {
    const equipo = (await pool.query(
        'INSERT INTO maquinarias (codigo, tipo) VALUES ($1, $2) RETURNING id',
        [`POS-${crypto.randomUUID().slice(0, 6).toUpperCase()}`, 'Grua de prueba']
    )).rows[0];
    datos.equipos.push(equipo.id);
    const ot = (await pool.query(
        `INSERT INTO ordenes_trabajo (maquinaria_id, mecanico_id, estado, motivo)
         VALUES ($1, $2, $3, 'ruta de posicion') RETURNING id`,
        [equipo.id, mecanicoId, estado]
    )).rows[0].id;
    datos.ordenes.push(ot);
    return ot;
}

async function filasPosicion() {
    return (await pool.query(
        'SELECT orden_trabajo_id FROM posiciones_mecanico WHERE usuario_id = $1', [datos.mecanicoId]
    )).rows;
}

before(async () => {
    if (!HABILITADO) return;
    exigirBaseLocal();
    // sin llave, mejorarEtaConRutas no sale a la red despues de responder
    llaveOriginal = process.env.ORS_API_KEY;
    delete process.env.ORS_API_KEY;
    const express = require('express');
    pool = require('../src/config/db');
    const app = express();
    app.use(express.json());
    app.use('/api/ordenes-trabajo', require('../src/routes/ordenes'));
    await new Promise((resolve) => { servidor = app.listen(0, resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;

    const usuarios = await pool.query(
        `SELECT id, rol, email FROM usuarios
         WHERE email IN ('administrativo@gomaq.test', 'mecanico@gomaq.test', 'mecanico2@gomaq.test', 'cliente@gomaq.test')`
    );
    const porEmail = Object.fromEntries(usuarios.rows.map((u) => [u.email, u]));
    const firmar = (u) => jwt.sign({ id: u.id, rol: u.rol, cliente_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokens.administrativo = firmar(porEmail['administrativo@gomaq.test']);
    tokens.mecanico = firmar(porEmail['mecanico@gomaq.test']);
    tokens.otroMecanico = firmar(porEmail['mecanico2@gomaq.test']);
    tokens.cliente = firmar(porEmail['cliente@gomaq.test']);
    datos.mecanicoId = porEmail['mecanico@gomaq.test'].id;
    datos.otroMecanicoId = porEmail['mecanico2@gomaq.test'].id;
    await pool.query('DELETE FROM posiciones_mecanico WHERE usuario_id = $1', [datos.mecanicoId]);
});

after(async () => {
    if (!HABILITADO) return;
    try {
        if (datos.ordenes.length) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query("SET LOCAL gomaq.purga = 'on'");
                await client.query('DELETE FROM posiciones_mecanico WHERE orden_trabajo_id = ANY($1)', [datos.ordenes]);
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
        if (datos.equipos.length) {
            await pool.query('DELETE FROM maquinarias WHERE id = ANY($1)', [datos.equipos]);
        }
    } finally {
        if (llaveOriginal !== undefined) process.env.ORS_API_KEY = llaveOriginal;
        await new Promise((resolve) => servidor.close(resolve));
        await pool.end();
    }
});

test('OT en_terreno del mecanico: 200 con fuera_de_camino y no queda fila de posicion', async (t) => {
    if (!requiereBase(t)) return;
    const ot = await crearOt('en_terreno', datos.mecanicoId);
    const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/posicion`, 'mecanico', posicionValida());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.guardada, false);
    assert.equal(r.body.motivo, 'fuera_de_camino');
    assert.equal((await filasPosicion()).length, 0, 'fuera de camino no se guarda la posicion');
});

test('OT en_camino del mecanico: guardada y queda una sola fila, asociada a la OT', async (t) => {
    if (!requiereBase(t)) return;
    const ot = await crearOt('en_camino', datos.mecanicoId);
    const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/posicion`, 'mecanico', posicionValida());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.guardada, true);
    const filas = await filasPosicion();
    assert.equal(filas.length, 1);
    assert.equal(filas[0].orden_trabajo_id, ot);
    await pool.query('DELETE FROM posiciones_mecanico WHERE usuario_id = $1', [datos.mecanicoId]);
});

test('OT de otro mecanico: 403 y no se guarda nada', async (t) => {
    if (!requiereBase(t)) return;
    const ot = await crearOt('en_camino', datos.otroMecanicoId);
    const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/posicion`, 'mecanico', posicionValida());
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal((await filasPosicion()).length, 0);
    const otra = await pool.query('SELECT 1 FROM posiciones_mecanico WHERE orden_trabajo_id = $1', [ot]);
    assert.equal(otra.rowCount, 0);
});

test('OT inexistente: 404; id que no es numero: 400', async (t) => {
    if (!requiereBase(t)) return;
    assert.equal((await pedir('POST', '/api/ordenes-trabajo/2147483000/posicion', 'mecanico', posicionValida())).status, 404);
    assert.equal((await pedir('POST', '/api/ordenes-trabajo/abc/posicion', 'mecanico', posicionValida())).status, 400);
});

test('coordenadas fuera de rango, faltantes u hora invalida o futura: 400 y sin fila', async (t) => {
    if (!requiereBase(t)) return;
    const ot = await crearOt('en_camino', datos.mecanicoId);
    const futura = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    for (const cuerpo of [
        posicionValida({ latitud: 95 }),
        posicionValida({ longitud: 181 }),
        posicionValida({ latitud: -91, longitud: -181 }),
        posicionValida({ latitud: 'abc' }),
        { capturada_en: new Date().toISOString() },
        posicionValida({ capturada_en: 'no-es-fecha' }),
        posicionValida({ capturada_en: futura }),
        { latitud: -33.42, longitud: -70.61 },
    ]) {
        const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/posicion`, 'mecanico', cuerpo);
        assert.equal(r.status, 400, JSON.stringify(cuerpo));
    }
    assert.equal((await filasPosicion()).length, 0);
});

test('el cliente y el administrativo no pueden enviar posicion: 403 y sin fila', async (t) => {
    if (!requiereBase(t)) return;
    const ot = await crearOt('en_camino', datos.mecanicoId);
    for (const rol of ['cliente', 'administrativo']) {
        const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/posicion`, rol, posicionValida());
        assert.equal(r.status, 403, rol);
    }
    assert.equal((await filasPosicion()).length, 0);
});
