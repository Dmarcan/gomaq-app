// Pruebas de escritura de GET /api/maquinarias/:id/linea-tiempo. Mismo patron que
// mapaEscritura.test.js: rutas en memoria sobre la base de DATABASE_URL, datos propios que se borran
// al terminar y tokens firmados con un secreto de la prueba.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-linea-de-tiempo';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
const tokens = {};
const datos = { equipo: null, clientes: [], ordenes: [], insumo: null };
const ids = {};

function requiereBase(t) {
    if (!HABILITADO) {
        t.skip('pruebas de escritura deshabilitadas: usar GOMAQ_TEST_ESCRITURA=1 con una base local');
        return false;
    }
    return true;
}

async function pedir(ruta, rol) {
    const cabeceras = rol ? { Authorization: `Bearer ${tokens[rol]}` } : {};
    const r = await fetch(`${base}${ruta}`, { headers: cabeceras });
    let json = null;
    try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
    return { status: r.status, body: json };
}

const nuevoCliente = async (nombre) => {
    const r = await pool.query(
        "INSERT INTO clientes (nombre, email) VALUES ($1, 'linea@gomaq.test') RETURNING id",
        [`${nombre} ${crypto.randomUUID().slice(0, 6)}`]
    );
    datos.clientes.push(r.rows[0].id);
    return r.rows[0].id;
};

before(async () => {
    if (!HABILITADO) return;
    exigirBaseLocal();
    const express = require('express');
    pool = require('../src/config/db');
    const app = express();
    app.use(express.json());
    app.use('/api/maquinarias', require('../src/routes/maquinarias'));
    app.use('/api/rentabilidad', require('../src/routes/rentabilidad'));
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

    // un equipo que pasa por dos clientes sucesivos, con un tramo en bodega entre medio
    const acsa = await nuevoCliente('ACSA');
    const prize = await nuevoCliente('Prize');
    datos.equipo = (await pool.query(
        'INSERT INTO maquinarias (codigo, tipo) VALUES ($1, $2) RETURNING id',
        [`LT-${crypto.randomUUID().slice(0, 6).toUpperCase()}`, 'Grua de prueba']
    )).rows[0].id;
    const equipo = datos.equipo;
    const guia = async (tipo, fecha, cliente) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id)
         VALUES ($1, $2::tipo_guia, $3, $4, $5) RETURNING id`,
        [equipo, tipo, `guias/${crypto.randomUUID()}.pdf`, fecha, cliente]
    )).rows[0].id;

    ids.acsa = acsa;
    ids.prize = prize;
    ids.g1 = await guia('despacho', '2026-01-02T09:00:00-03:00', acsa);
    ids.r1 = await guia('recepcion', '2026-01-20T10:00:00-03:00', acsa);
    ids.f1 = (await pool.query(
        `INSERT INTO facturas (maquinaria_id, cliente_id, folio, archivo_url, monto, monto_traslado, fecha_emision)
         VALUES ($1, $2, 'LT-1', 'facturas/secreta-lt1.pdf', 210000, 140000, '2026-01-25') RETURNING id`,
        [equipo, acsa]
    )).rows[0].id;
    ids.ot = (await pool.query(
        `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo, tipo_servicio, fecha_creacion)
         VALUES ($1, $2, 'finalizada', 'Preventiva Prize', 'preventivo', '2026-02-05T10:00:00-03:00') RETURNING id`,
        [equipo, prize]
    )).rows[0].id;
    datos.ordenes.push(ids.ot);
    ids.g2 = await guia('despacho', '2026-02-02T09:00:00-03:00', prize);
    ids.l1 = (await pool.query(
        `INSERT INTO lecturas_horometro (maquinaria_id, valor, origen, cliente_id, fecha)
         VALUES ($1, 100, 'movil', $2, '2026-02-03T10:00:00-03:00') RETURNING id`,
        [equipo, prize]
    )).rows[0].id;
    ids.l2 = (await pool.query(
        `INSERT INTO lecturas_horometro (maquinaria_id, valor, origen, cliente_id, fecha, observacion)
         VALUES ($1, 160.5, 'panel', $2, '2026-02-06T10:00:00-03:00', 'Mantencion preventiva registrada desde el panel') RETURNING id`,
        [equipo, prize]
    )).rows[0].id;
    // una orden de taller sin cliente, mas reciente que todo
    ids.otTaller = (await pool.query(
        `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo, fecha_creacion)
         VALUES ($1, NULL, 'finalizada', 'Taller sin cliente', '2026-03-01T10:00:00-03:00') RETURNING id`,
        [equipo]
    )).rows[0].id;
    datos.ordenes.push(ids.otTaller);

    // repuestos de la orden de Prize: uno con precio, uno sin precio y uno anulado
    const insumo = (await pool.query(
        "INSERT INTO insumos (nombre, unidad_medida) VALUES ($1, 'un') RETURNING id", [`Insumo linea ${crypto.randomUUID().slice(0, 6)}`]
    )).rows[0];
    datos.insumo = insumo.id;
    {
        const usuarioId = porEmail['administrativo@gomaq.test'].id;
        const salida = (cantidad, precio, anulada) => pool.query(
            `INSERT INTO movimientos_insumo (insumo_id, tipo, cantidad, precio_unitario, orden_trabajo_id, usuario_id, anulada_at)
             VALUES ($1, 'salida', $2, $3, $4, $5, $6)`,
            [insumo.id, cantidad, precio, ids.ot, usuarioId, anulada ? new Date() : null]
        );
        await salida(2, 1500, false);
        await salida(1, null, false);
        await salida(5, 9999, true);
    }
});

after(async () => {
    if (!HABILITADO) return;
    const equipo = datos.equipo;
    if (equipo) {
        await pool.query('DELETE FROM lecturas_horometro WHERE maquinaria_id = $1', [equipo]);
        await pool.query('DELETE FROM facturas WHERE maquinaria_id = $1', [equipo]);
        await pool.query('DELETE FROM guias WHERE maquinaria_id = $1', [equipo]);
    }
    if (datos.ordenes.length) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL gomaq.purga = 'on'");
            await client.query('DELETE FROM movimientos_insumo WHERE orden_trabajo_id = ANY($1)', [datos.ordenes]);
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
    if (equipo) await pool.query('DELETE FROM maquinarias WHERE id = $1', [equipo]);
    if (datos.insumo) await pool.query('DELETE FROM insumos WHERE id = $1', [datos.insumo]);
    if (datos.clientes.length) await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [datos.clientes]);
    await new Promise((resolve) => servidor.close(resolve));
    await pool.end();
});

test('linea de tiempo: sin sesion 401; cliente y mecanico 403', async (t) => {
    if (!requiereBase(t)) return;
    const ruta = `/api/maquinarias/${datos.equipo}/linea-tiempo`;
    assert.equal((await pedir(ruta, null)).status, 401);
    assert.equal((await pedir(ruta, 'cliente')).status, 403);
    assert.equal((await pedir(ruta, 'mecanico')).status, 403);
});

test('linea de tiempo: id invalido 400 y equipo inexistente 404', async (t) => {
    if (!requiereBase(t)) return;
    for (const malo of ['abc', '0', '-1', '1.5', '99999999999999999999', '2147483648']) {
        assert.equal((await pedir(`/api/maquinarias/${malo}/linea-tiempo`, 'administrativo')).status, 400, malo);
    }
    assert.equal((await pedir('/api/maquinarias/2147483647/linea-tiempo', 'gerente')).status, 404);
});

test('linea de tiempo: dos clientes sucesivos y una orden de taller dan tramos separados', async (t) => {
    if (!requiereBase(t)) return;
    for (const rol of ['administrativo', 'gerente']) {
        const r = await pedir(`/api/maquinarias/${datos.equipo}/linea-tiempo`, rol);
        assert.equal(r.status, 200, rol);
        assert.equal(r.body.maquinaria.id, datos.equipo);
        assert.equal(r.body.hay_mas, false);
        // taller (sin cliente), Prize, ACSA
        assert.deepEqual(r.body.tramos.map((x) => x.cliente_id), [null, ids.prize, ids.acsa]);
        const [taller, prize, acsa] = r.body.tramos;
        assert.equal(taller.eventos[0].tipo, 'orden_trabajo');
        assert.equal(taller.eventos[0].id, ids.otTaller);
        assert.match(prize.cliente_nombre, /^Prize/);
        assert.match(acsa.cliente_nombre, /^ACSA/);
        assert.deepEqual(prize.eventos.map((e) => `${e.tipo}:${e.id}`), [
            `lectura_horometro:${ids.l2}`, `orden_trabajo:${ids.ot}`, `lectura_horometro:${ids.l1}`, `guia_despacho:${ids.g2}`,
        ]);
        assert.deepEqual(acsa.eventos.map((e) => `${e.tipo}:${e.id}`), [
            `factura:${ids.f1}`, `guia_recepcion:${ids.r1}`, `guia_despacho:${ids.g1}`,
        ]);
    }
});

test('linea de tiempo: detalle de factura, orden, lecturas y sin archivos ni URLs', async (t) => {
    if (!requiereBase(t)) return;
    const r = await pedir(`/api/maquinarias/${datos.equipo}/linea-tiempo`, 'administrativo');
    const eventos = r.body.tramos.flatMap((x) => x.eventos);
    const porClave = Object.fromEntries(eventos.map((e) => [`${e.tipo}:${e.id}`, e]));

    const f = porClave[`factura:${ids.f1}`];
    assert.equal(f.folio, 'LT-1');
    assert.equal(f.monto, 210000);
    assert.equal(f.monto_traslado, 140000);
    assert.equal(f.ingreso, 70000);

    const ot = porClave[`orden_trabajo:${ids.ot}`];
    assert.equal(ot.es_mantencion, true);
    assert.equal(ot.tipo_servicio, 'preventivo');
    // 2 x 1500 con precio; la linea sin precio se cuenta aparte; la anulada no entra
    assert.equal(ot.costo_repuestos, 3000);
    assert.equal(ot.lineas_sin_precio, 1);

    const l1 = porClave[`lectura_horometro:${ids.l1}`];
    const l2 = porClave[`lectura_horometro:${ids.l2}`];
    assert.equal(l1.horas_desde_anterior, null);
    assert.equal(l2.horas_desde_anterior, 60.5);
    assert.equal(l1.es_mantencion, false);
    assert.equal(l2.es_mantencion, true);

    assert.doesNotMatch(JSON.stringify(r.body), /archivo_url|secreta-lt1|\.pdf|https?:/);
});

test('rentabilidad del equipo: cada linea y cada factura trae su cliente, sin cambiar las cifras', async (t) => {
    if (!requiereBase(t)) return;
    const desde = '2020-01-01';
    const hasta = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const r = await pedir(`/api/rentabilidad/maquinaria/${datos.equipo}?desde=${desde}&hasta=${hasta}`, 'gerente');
    assert.equal(r.status, 200);
    assert.ok(r.body.lineas.length >= 1);
    for (const l of r.body.lineas) {
        assert.equal(l.cliente_id, ids.prize);
        assert.match(l.cliente_nombre, /^Prize/);
    }
    const f = r.body.facturas.find((x) => x.id === ids.f1);
    assert.equal(f.cliente_id, ids.acsa);
    assert.match(f.cliente_nombre, /^ACSA/);
    // 3000 de repuestos con precio; ingreso = 210000 - 140000
    assert.equal(r.body.gasto, 3000);
    assert.equal(r.body.ingreso, 70000);
});
