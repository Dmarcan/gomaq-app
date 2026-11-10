// Pruebas de escritura del mapa operativo (GET /api/mapa y la bodega). Mismo patron que
// escritura.test.js: rutas en memoria sobre la base de DATABASE_URL, datos propios que se borran al
// terminar y tokens firmados con un secreto de la prueba.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-del-mapa';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
const tokens = {};
const datos = { ordenes: [], equipos: [], bodegaOriginal: null, mecanicoId: null };

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

before(async () => {
    if (!HABILITADO) return;
    const express = require('express');
    pool = require('../src/config/db');
    const app = express();
    app.use(express.json());
    app.use('/api/mapa', require('../src/routes/mapa'));
    app.use('/api/maquinarias', require('../src/routes/guias'));
    app.use('/api/geocodificar', require('../src/routes/geocodificar'));
    await new Promise((resolve) => { servidor = app.listen(0, resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;

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
    datos.mecanicoId = porEmail['mecanico@gomaq.test'].id;
    datos.bodegaOriginal = (await pool.query(
        "SELECT id, latitud, longitud, ubicacion_actualizada_por, ubicacion_actualizada_at FROM ubicaciones_stock WHERE tipo = 'bodega' ORDER BY id LIMIT 1"
    )).rows[0];
});

after(async () => {
    if (!HABILITADO) return;
    if (datos.ordenes.length) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL gomaq.purga = 'on'");
            await client.query('DELETE FROM ordenes_eventos WHERE orden_trabajo_id = ANY($1)', [datos.ordenes]);
            await client.query('DELETE FROM posiciones_mecanico WHERE orden_trabajo_id = ANY($1)', [datos.ordenes]);
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
        await pool.query('DELETE FROM guias WHERE maquinaria_id = ANY($1)', [datos.equipos]);
        await pool.query('DELETE FROM maquinarias WHERE id = ANY($1)', [datos.equipos]);
    }
    if (datos.bodegaOriginal) {
        const b = datos.bodegaOriginal;
        await pool.query(
            'UPDATE ubicaciones_stock SET latitud = $1, longitud = $2, ubicacion_actualizada_por = $3, ubicacion_actualizada_at = $4 WHERE id = $5',
            [b.latitud, b.longitud, b.ubicacion_actualizada_por, b.ubicacion_actualizada_at, b.id]
        );
    }
    await new Promise((resolve) => servidor.close(resolve));
    await pool.end();
});

async function crearEquipo(clienteId) {
    const r = await pool.query(
        'INSERT INTO maquinarias (codigo, tipo, cliente_id) VALUES ($1, $2, $3) RETURNING id, codigo',
        [`MAP-${crypto.randomUUID().slice(0, 6).toUpperCase()}`, 'Grua de prueba', clienteId]
    );
    datos.equipos.push(r.rows[0].id);
    return r.rows[0];
}

test('el cliente y el mecanico no ven el mapa ni la bodega: 403', async (t) => {
    if (!requiereBase(t)) return;
    for (const rol of ['cliente', 'mecanico']) {
        assert.equal((await pedir('GET', '/api/mapa', rol)).status, 403, `GET /mapa ${rol}`);
        assert.equal((await pedir('GET', '/api/mapa/bodega', rol)).status, 403, `GET bodega ${rol}`);
        assert.equal((await pedir('PUT', '/api/mapa/bodega', rol, { latitud: -33, longitud: -70 })).status, 403, `PUT bodega ${rol}`);
    }
});

test('bodega: administrativo y gerente la fijan; el GET lo refleja; null la borra', async (t) => {
    if (!requiereBase(t)) return;
    const a = await pedir('PUT', '/api/mapa/bodega', 'administrativo', { latitud: -33.5, longitud: -70.7 });
    assert.equal(a.status, 200);
    assert.equal(a.body.latitud, -33.5);
    assert.equal(a.body.longitud, -70.7);
    const g = await pedir('PUT', '/api/mapa/bodega', 'gerente', { latitud: -33.51, longitud: -70.71 });
    assert.equal(g.status, 200);
    const leida = await pedir('GET', '/api/mapa/bodega', 'administrativo');
    assert.equal(leida.body.latitud, -33.51);
    assert.ok(leida.body.ubicacion_actualizada_at);
    const borrada = await pedir('PUT', '/api/mapa/bodega', 'administrativo', { latitud: null, longitud: null });
    assert.equal(borrada.status, 200);
    assert.equal(borrada.body.latitud, null);
});

test('bodega: texto, una sola coordenada o fuera de rango se rechazan con 400 y no cambian nada', async (t) => {
    if (!requiereBase(t)) return;
    await pedir('PUT', '/api/mapa/bodega', 'administrativo', { latitud: -33.5, longitud: -70.7 });
    for (const cuerpo of [
        { latitud: '-33.5', longitud: '-70.7' }, { latitud: -33.5 }, { longitud: -70.7 },
        { latitud: 91, longitud: 0 }, { latitud: 0, longitud: 181 },
    ]) {
        const r = await pedir('PUT', '/api/mapa/bodega', 'administrativo', cuerpo);
        assert.equal(r.status, 400, JSON.stringify(cuerpo));
    }
    assert.equal((await pedir('GET', '/api/mapa/bodega', 'gerente')).body.latitud, -33.5);
});

test('GET /api/mapa: equipo en bodega, arrendado con guia y furgon en camino; al llegar el furgon desaparece', async (t) => {
    if (!requiereBase(t)) return;
    await pedir('PUT', '/api/mapa/bodega', 'administrativo', { latitud: -33.5, longitud: -70.7 });
    const cliente = (await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 1')).rows[0].id;
    const enBodega = await crearEquipo(null);
    const arrendado = await crearEquipo(cliente);
    await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id, latitud, longitud)
         VALUES ($1, 'despacho', 'sin_documento', CURRENT_DATE, $2, -33.45, -70.65)`, [arrendado.id, cliente]);
    const ot = (await pool.query(
        `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo,
                eta_segundos, eta_calculada_at, eta_fuente, eta_ajustada_llegada_at)
         VALUES ($1, $2, $3, 'en_camino', 'mapa', 600, now(), 'ors', now() + interval '20 minutes') RETURNING id`,
        [arrendado.id, cliente, datos.mecanicoId])).rows[0].id;
    datos.ordenes.push(ot);
    await pool.query(
        `INSERT INTO posiciones_mecanico (usuario_id, orden_trabajo_id, latitud, longitud, precision_m, capturada_en, quieto_desde)
         VALUES ($1, $2, -33.42, -70.61, 8, now(), now() - interval '12 minutes')
         ON CONFLICT (usuario_id) DO UPDATE SET orden_trabajo_id = $2, latitud = -33.42, longitud = -70.61, capturada_en = now(),
                quieto_desde = now() - interval '12 minutes'`,
        [datos.mecanicoId, ot]);

    const r = await pedir('GET', '/api/mapa', 'administrativo');
    assert.equal(r.status, 200);
    assert.equal(r.body.bodega.latitud, -33.5);
    const eb = r.body.equipos.find((e) => e.id === enBodega.id);
    assert.equal(eb.situacion, 'bodega');
    assert.equal(eb.origen_ubicacion, 'bodega');
    assert.equal(eb.latitud, -33.5);
    const ea = r.body.equipos.find((e) => e.id === arrendado.id);
    assert.equal(ea.situacion, 'arrendado');
    assert.equal(ea.origen_ubicacion, 'guia');
    assert.equal(ea.latitud, -33.45);
    assert.ok(ea.cliente.nombre);
    const f = r.body.furgones.find((x) => x.orden_trabajo_id === ot);
    assert.ok(f, 'el furgon en camino aparece');
    assert.equal(f.latitud, -33.42);
    assert.ok(f.posicion_at && f.eta_llegada_at);
    // la hora ajustada manda sobre calculada_at + segundos (que serian ~10 min, no 20)
    const minutos = (new Date(f.eta_llegada_at).getTime() - Date.now()) / 60000;
    assert.ok(minutos > 15 && minutos < 25, `usa la hora ajustada: ${minutos}`);
    assert.equal(f.eta_aproximada, false, 'la hora escalada viene de la ruta real');
    assert.equal(f.maquinaria_id, arrendado.id, 'trae el id del equipo para Ver equipo');
    assert.ok(f.quieto_desde, 'trae desde cuando esta quieto');
    const texto = JSON.stringify(r.body);
    for (const prohibido of ['precision_m', 'destino_lat', 'eta_origen', 'eta_consultas', 'telefono']) {
        assert.ok(!texto.includes(prohibido), `no debe exponer ${prohibido}`);
    }

    // al llegar, el furgon deja de estar en camino y sale del mapa
    await pool.query("UPDATE ordenes_trabajo SET estado = 'en_terreno' WHERE id = $1", [ot]);
    const despues = await pedir('GET', '/api/mapa', 'gerente');
    assert.ok(!despues.body.furgones.some((x) => x.orden_trabajo_id === ot), 'ya no esta en camino');
});

test('un furgon en camino sin posicion sigue en la lista, sin coordenadas', async (t) => {
    if (!requiereBase(t)) return;
    const equipo = await crearEquipo(null);
    const ot = (await pool.query(
        `INSERT INTO ordenes_trabajo (maquinaria_id, mecanico_id, estado, motivo)
         VALUES ($1, $2, 'en_camino', 'mapa sin posicion') RETURNING id`, [equipo.id, datos.mecanicoId])).rows[0].id;
    datos.ordenes.push(ot);
    await pool.query('DELETE FROM posiciones_mecanico WHERE usuario_id = $1', [datos.mecanicoId]);
    const r = await pedir('GET', '/api/mapa', 'administrativo');
    const f = r.body.furgones.find((x) => x.orden_trabajo_id === ot);
    assert.ok(f);
    assert.equal(f.latitud, null);
    assert.equal(f.posicion_at, null);
});

test('la base rechaza coordenadas fijas en una ubicacion que no es la bodega', async (t) => {
    if (!requiereBase(t)) return;
    const veh = (await pool.query(
        'INSERT INTO vehiculos (patente) VALUES ($1) RETURNING id', [`M${crypto.randomUUID().slice(0, 6).toUpperCase()}`]
    )).rows[0];
    const furgon = (await pool.query(
        "INSERT INTO ubicaciones_stock (nombre, tipo, vehiculo_id) VALUES ('Furgon de prueba del mapa', 'furgon', $1) RETURNING id", [veh.id]
    )).rows[0];
    try {
        await assert.rejects(
            pool.query('UPDATE ubicaciones_stock SET latitud = -33, longitud = -70 WHERE id = $1', [furgon.id]),
            /chk_ubicaciones_stock_coordenadas/
        );
    } finally {
        await pool.query('DELETE FROM ubicaciones_stock WHERE id = $1', [furgon.id]);
        await pool.query('DELETE FROM vehiculos WHERE id = $1', [veh.id]);
    }
});

test('guia de despacho: guarda las coordenadas opcionales y el mapa ubica ahi el equipo', async (t) => {
    if (!requiereBase(t)) return;
    const cliente = (await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 1')).rows[0].id;
    const equipo = await crearEquipo(null);
    const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo', {
        tipo: 'despacho', cliente_id: cliente, sin_documento: true, latitud: '-33.123456', longitud: -70.5,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const g = (await pool.query('SELECT latitud, longitud FROM guias WHERE maquinaria_id = $1', [equipo.id])).rows[0];
    assert.equal(Number(g.latitud), -33.123456);
    assert.equal(Number(g.longitud), -70.5);
    const mapa = await pedir('GET', '/api/mapa', 'administrativo');
    const e = mapa.body.equipos.find((x) => x.id === equipo.id);
    assert.equal(e.origen_ubicacion, 'guia');
    assert.equal(e.latitud, -33.123456);
});

test('guia de despacho: una sola coordenada o fuera de rango se rechaza con 400 y no registra nada', async (t) => {
    if (!requiereBase(t)) return;
    const cliente = (await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 1')).rows[0].id;
    const equipo = await crearEquipo(null);
    for (const extra of [{ latitud: -33.1 }, { longitud: -70.1 }, { latitud: 95, longitud: -70 }, { latitud: 'abc', longitud: '-70' }]) {
        const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo', {
            tipo: 'despacho', cliente_id: cliente, sin_documento: true, ...extra,
        });
        assert.equal(r.status, 400, JSON.stringify(extra));
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM guias WHERE maquinaria_id = $1', [equipo.id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [equipo.id])).rows[0].cliente_id, null);
});

test('guia sin coordenadas: el equipo cae a la ubicacion del cliente; una recepcion no guarda coordenadas', async (t) => {
    if (!requiereBase(t)) return;
    const cliente = (await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 1')).rows[0].id;
    const equipo = await crearEquipo(null);
    assert.equal((await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo', {
        tipo: 'despacho', cliente_id: cliente, sin_documento: true,
    })).status, 201);
    const g = (await pool.query('SELECT latitud FROM guias WHERE maquinaria_id = $1', [equipo.id])).rows[0];
    assert.equal(g.latitud, null);
    const rec = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo', {
        tipo: 'recepcion', sin_documento: true, latitud: -33.1, longitud: -70.1,
    });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
    const recibida = (await pool.query("SELECT latitud FROM guias WHERE maquinaria_id = $1 AND tipo = 'recepcion'", [equipo.id])).rows[0];
    assert.equal(recibida.latitud, null, 'una recepcion no guarda donde esta el equipo');
});

test('buscador de direcciones: solo la oficina, minimo de letras y sin llave responde 503 sin llamar al proveedor', async (t) => {
    if (!requiereBase(t)) return;
    for (const rol of ['cliente', 'mecanico']) {
        assert.equal((await pedir('GET', '/api/geocodificar?texto=Providencia', rol)).status, 403, rol);
    }
    assert.equal((await pedir('GET', '/api/geocodificar?texto=ab', 'administrativo')).status, 400);
    assert.equal((await pedir('GET', '/api/geocodificar', 'gerente')).status, 400);
    // nunca se consulta el servicio real desde las pruebas: sin llave, el endpoint avisa que no esta configurado
    const llave = process.env.ORS_API_KEY;
    delete process.env.ORS_API_KEY;
    try {
        const r = await pedir('GET', '/api/geocodificar?texto=Providencia%201234', 'administrativo');
        assert.equal(r.status, 503);
        assert.match(r.body.error, /no está configurado/);
    } finally {
        if (llave !== undefined) process.env.ORS_API_KEY = llave;
    }
});
