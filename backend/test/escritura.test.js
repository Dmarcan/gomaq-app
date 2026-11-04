// Pruebas de escritura contra una base de datos local.
//
// Verifican las reglas que solo se pueden comprobar escribiendo: que un reintento de la cola
// offline no duplique datos, que anular una linea devuelva el stock y que las transiciones de
// la OT se respeten. Por eso NO corren contra el servidor real: levantan las rutas en memoria,
// sobre la base de `DATABASE_URL`, crean sus propios datos y los borran al terminar.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test
//
// Sin esa variable se omiten con el motivo, igual que la bateria de integracion.
//
// Los tokens se firman con un secreto propio de la prueba: no se usa ninguna credencial real.

require('dotenv').config();
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-escritura';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
const datos = { ordenes: [], insumos: [], equipos: [], ubicaciones: [], solicitudes: [] };
const tokens = {};

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
    app.use('/api/ordenes-trabajo', require('../src/routes/ordenes'));
    app.use('/api/ordenes-trabajo', require('../src/routes/evidencias'));
    app.use('/api/solicitudes', require('../src/routes/solicitudes'));
    app.use('/api/insumos', require('../src/routes/insumos'));
    app.use('/api/horometro', require('../src/routes/horometro').router);
    app.use('/api/facturacion', require('../src/routes/facturacion'));
    app.use('/api/rentabilidad', require('../src/routes/rentabilidad'));
    app.use('/api/maquinarias', require('../src/routes/maquinarias'));
    app.use('/api/maquinarias', require('../src/routes/guias'));
    await new Promise((resolve) => { servidor = app.listen(0, resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;

    const usuarios = await pool.query(
        `SELECT id, rol, email FROM usuarios
         WHERE email IN ('administrativo@gomaq.test', 'mecanico@gomaq.test', 'mecanico2@gomaq.test', 'admin@gomaq.test', 'cliente@gomaq.test')`
    );
    const porEmail = Object.fromEntries(usuarios.rows.map((u) => [u.email, u]));
    const firmar = (u) => jwt.sign({ id: u.id, rol: u.rol, cliente_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokens.administrativo = firmar(porEmail['administrativo@gomaq.test']);
    tokens.gerente = firmar(porEmail['admin@gomaq.test']);
    tokens.mecanico = firmar(porEmail['mecanico@gomaq.test']);
    tokens.mecanicoDos = firmar(porEmail['mecanico2@gomaq.test']);
    tokens.cliente = firmar(porEmail['cliente@gomaq.test']);
    datos.mecanicoId = porEmail['mecanico@gomaq.test'].id;
    datos.mecanicoDosId = porEmail['mecanico2@gomaq.test'].id;

    const maquinaria = await pool.query(
        'SELECT id, alerta_mantencion_enviada, horometro_ultima_mantencion FROM maquinarias ORDER BY id LIMIT 1'
    );
    datos.maquinariaId = maquinaria.rows[0].id;
    // la lectura de horometro de las pruebas puede disparar el aviso de mantencion: se guarda
    // el estado del equipo para dejarlo como estaba
    datos.maquinariaOriginal = maquinaria.rows[0];
    datos.inicio = new Date();
});

/**
 * Borra OT de prueba junto con sus eventos. Los triggers de ordenes_eventos rechazan el DELETE
 * salvo que la transaccion active `gomaq.purga`; SET LOCAL la limita a este BEGIN/COMMIT.
 */
async function purgarOrdenes(ids) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL gomaq.purga = 'on'");
        await client.query('DELETE FROM ordenes_eventos WHERE orden_trabajo_id = ANY($1)', [ids]);
        await client.query('DELETE FROM ordenes_trabajo WHERE id = ANY($1)', [ids]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

after(async () => {
    if (!HABILITADO) return;
    const ots = datos.ordenes;
    if (datos.solicitudes.length) {
        await pool.query('DELETE FROM solicitudes WHERE id = ANY($1)', [datos.solicitudes]);
    }
    if (ots.length) {
        await pool.query('DELETE FROM notificaciones_pendientes WHERE (payload->>\'orden_trabajo_id\')::int = ANY($1)', [ots]);
        await pool.query('DELETE FROM lecturas_horometro WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM tramos_trabajo WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM evidencias_fotograficas WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM firmas_recepcion WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM movimientos_insumo WHERE orden_trabajo_id = ANY($1)', [ots]);
        // ordenes_eventos es de solo insercion (migracion 020): borrar las OT de prueba y su
        // historial exige la via de purga, que vale solo dentro de esta transaccion
        await purgarOrdenes(ots);
    }
    if (datos.equipos.length) {
        await pool.query('DELETE FROM facturas WHERE maquinaria_id = ANY($1)', [datos.equipos]);
        await pool.query('DELETE FROM guias WHERE maquinaria_id = ANY($1)', [datos.equipos]);
        await pool.query('DELETE FROM lecturas_horometro WHERE maquinaria_id = ANY($1)', [datos.equipos]);
        await pool.query('DELETE FROM maquinarias WHERE id = ANY($1)', [datos.equipos]);
    }
    await pool.query(
        `DELETE FROM notificaciones_pendientes
         WHERE created_at >= $1 AND payload->>'tipo' = 'mantencion_proxima'
           AND (payload->>'maquinaria_id')::int = $2`,
        [datos.inicio, datos.maquinariaId]
    );
    await pool.query(
        'UPDATE maquinarias SET alerta_mantencion_enviada = $1, horometro_ultima_mantencion = $2 WHERE id = $3',
        [datos.maquinariaOriginal.alerta_mantencion_enviada, datos.maquinariaOriginal.horometro_ultima_mantencion, datos.maquinariaId]
    );
    if (datos.insumos.length) {
        await pool.query('DELETE FROM movimientos_insumo WHERE insumo_id = ANY($1)', [datos.insumos]);
        await pool.query('DELETE FROM stock_ubicacion WHERE insumo_id = ANY($1)', [datos.insumos]);
        await pool.query('DELETE FROM insumos WHERE id = ANY($1)', [datos.insumos]);
    }
    if (datos.ubicaciones.length) {
        await pool.query('DELETE FROM stock_ubicacion WHERE ubicacion_id = ANY($1)', [datos.ubicaciones]);
        await pool.query('DELETE FROM ubicaciones_stock WHERE id = ANY($1)', [datos.ubicaciones]);
    }
    await new Promise((resolve) => servidor.close(resolve));
    await pool.end();
});

/** OT de prueba asignada al mecanico, creada directo en la base. */
async function crearOt(estado = 'en_terreno', mecanicoId = datos.mecanicoId, maquinariaId = datos.maquinariaId) {
    // con el cliente del equipo, para que cerrar o asignar encolen el aviso como en la realidad
    const r = await pool.query(
        `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo)
         SELECT id, cliente_id, $2, $3, 'OT de prueba automatizada' FROM maquinarias WHERE id = $1
         RETURNING id`,
        [maquinariaId, mecanicoId, estado]
    );
    datos.ordenes.push(r.rows[0].id);
    return r.rows[0].id;
}

/** Insumo de prueba con stock en la bodega central. */
async function crearInsumoConStock(cantidad) {
    const r = await pool.query(
        `INSERT INTO insumos (nombre, unidad_medida) VALUES ($1, 'unidad') RETURNING id`,
        [`Insumo de prueba ${crypto.randomUUID()}`]
    );
    const id = r.rows[0].id;
    datos.insumos.push(id);
    const ingreso = await pedir('POST', `/api/insumos/${id}/ingreso`, 'administrativo', { cantidad });
    assert.equal(ingreso.status, 200);
    return id;
}

/** Ubicacion de stock tipo furgon sin vehiculo, solo para recibir transferencias en las pruebas. */
async function crearFurgonDePrueba() {
    const r = await pool.query(
        `INSERT INTO ubicaciones_stock (nombre, tipo) VALUES ($1, 'furgon') RETURNING id`,
        [`Furgon de prueba ${crypto.randomUUID()}`]
    );
    datos.ubicaciones.push(r.rows[0].id);
    return r.rows[0].id;
}

async function stockBodega(insumoId) {
    const r = await pool.query(
        `SELECT su.cantidad FROM stock_ubicacion su
         JOIN ubicaciones_stock u ON u.id = su.ubicacion_id
         WHERE u.tipo = 'bodega' AND su.insumo_id = $1`,
        [insumoId]
    );
    return r.rows[0] ? Number(r.rows[0].cantidad) : 0;
}

describe('reintentos de la cola offline', () => {
    test('una linea de repuesto reintentada se registra y descuenta una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const insumo = await crearInsumoConStock(10);
        const uuid = crypto.randomUUID();
        const cuerpo = { insumo_id: insumo, cantidad: 3, facturable: 'si', uuid_cliente: uuid };

        const primera = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', cuerpo);
        const segunda = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', cuerpo);

        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200, 'el reintento responde la linea existente');
        assert.equal(segunda.body.id, primera.body.id);
        const lineas = await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(lineas.rows.length, 1);
        assert.equal(await stockBodega(insumo), 7, 'el stock se descuenta una sola vez');
    });

    test('dos reintentos simultaneos tampoco duplican', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const insumo = await crearInsumoConStock(10);
        const cuerpo = { insumo_id: insumo, cantidad: 2, uuid_cliente: crypto.randomUUID() };

        const respuestas = await Promise.all([1, 2, 3].map(() =>
            pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', cuerpo)));

        assert.ok(respuestas.every((r) => r.status === 200 || r.status === 201));
        const lineas = await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(lineas.rows.length, 1);
        assert.equal(await stockBodega(insumo), 8);
    });

    test('una carga de furgon reintentada descuenta la bodega una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const destino = await crearFurgonDePrueba();
        const cuerpo = { insumo_id: insumo, cantidad: 4, ubicacion_destino_id: destino, uuid_cliente: crypto.randomUUID() };

        const primera = await pedir('POST', '/api/insumos/transferencia', 'administrativo', cuerpo);
        const segunda = await pedir('POST', '/api/insumos/transferencia', 'administrativo', cuerpo);

        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200, 'el reintento responde lo ya hecho');
        assert.equal(segunda.body.ya_registrada, true);
        assert.equal(await stockBodega(insumo), 6, 'la bodega se descuenta una sola vez');
        const movimientos = await pool.query(
            'SELECT id FROM movimientos_insumo WHERE insumo_id = $1 AND ubicacion_destino_id = $2', [insumo, destino]);
        assert.equal(movimientos.rows.length, 1);
    });

    test('tres cargas de furgon simultaneas con el mismo uuid no duplican', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const destino = await crearFurgonDePrueba();
        const cuerpo = { insumo_id: insumo, cantidad: 2, ubicacion_destino_id: destino, uuid_cliente: crypto.randomUUID() };

        const respuestas = await Promise.all([1, 2, 3].map(() =>
            pedir('POST', '/api/insumos/transferencia', 'administrativo', cuerpo)));

        assert.ok(respuestas.every((r) => r.status === 200 || r.status === 201), JSON.stringify(respuestas.map((r) => r.status)));
        assert.equal(await stockBodega(insumo), 8);
    });

    test('una carga de furgon con uuid malformado se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(5);
        const r = await pedir('POST', '/api/insumos/transferencia', 'administrativo',
            { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: await crearFurgonDePrueba(), uuid_cliente: 'no-es-un-uuid' });
        assert.equal(r.status, 400);
    });

    test('el catalogo de insumos trae el stock de bodega', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(7);
        const r = await pedir('GET', '/api/insumos', 'mecanico');
        assert.equal(r.status, 200);
        const fila = r.body.find((i) => i.id === insumo);
        assert.equal(fila.stock_bodega, 7);
        assert.equal(fila.stock_furgon, 0);
    });

    test('rechaza un uuid_cliente malformado', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const r = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', {
            descripcion: 'Filtro', cantidad: 1, uuid_cliente: 'no-es-un-uuid',
        });
        assert.equal(r.status, 400);
    });

    test('un tramo reintentado se registra una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const cuerpo = { inicio: new Date().toISOString(), uuid_cliente: crypto.randomUUID() };
        const primera = await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', cuerpo);
        const segunda = await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        const tramos = await pool.query('SELECT id FROM tramos_trabajo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(tramos.rows.length, 1);
    });

    test('cerrar un tramo abierto lo completa en vez de crear otro', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const inicio = new Date(Date.now() - 3600 * 1000).toISOString();
        await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', { inicio, uuid_cliente: crypto.randomUUID() });
        const termino = new Date().toISOString();
        const uuidCierre = crypto.randomUUID();
        const cierre = await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', {
            inicio, termino, uuid_cliente: uuidCierre,
        });
        assert.equal(cierre.status, 200);
        // reintento del mismo cierre (se perdio la respuesta): tampoco debe crear otro tramo
        const reintento = await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', {
            inicio, termino, uuid_cliente: uuidCierre,
        });
        assert.equal(reintento.status, 200);
        const tramos = await pool.query('SELECT termino FROM tramos_trabajo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(tramos.rows.length, 1, 'un solo tramo, ya cerrado');
        assert.ok(tramos.rows[0].termino);
    });

    test('una lectura de horometro reintentada se registra una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const cuerpo = { valor: 1234, orden_trabajo_id: ot, uuid_cliente: crypto.randomUUID() };
        const ruta = `/api/horometro/maquinaria/${datos.maquinariaId}`;
        const primera = await pedir('POST', ruta, 'mecanico', cuerpo);
        const segunda = await pedir('POST', ruta, 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        assert.equal(segunda.body.ya_registrada, true);
        const lecturas = await pool.query('SELECT id FROM lecturas_horometro WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(lecturas.rows.length, 1);
    });

    test('una OT en terreno reintentada devuelve la misma orden', async (t) => {
        if (!requiereBase(t)) return;
        const cuerpo = { maquinaria_id: datos.maquinariaId, uuid_cliente: crypto.randomUUID() };
        const primera = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', cuerpo);
        datos.ordenes.push(primera.body.id);
        const segunda = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        assert.equal(segunda.body.id, primera.body.id);
        assert.ok(primera.body.llegada_at, 'una OT abierta en terreno ya tiene su hora de llegada');
    });
});

describe('anulacion de lineas de repuesto', () => {
    test('anular devuelve el stock, deja la linea tachada y es idempotente', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const insumo = await crearInsumoConStock(10);
        const linea = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', {
            insumo_id: insumo, cantidad: 4, facturable: 'si',
        });
        assert.equal(await stockBodega(insumo), 6);

        const ruta = `/api/insumos/orden/${ot}/linea/${linea.body.id}/anular`;
        const anulada = await pedir('POST', ruta, 'administrativo');
        assert.equal(anulada.status, 200);
        assert.ok(anulada.body.anulada_at, 'queda la fecha de anulacion');
        assert.equal(anulada.body.orden_facturable, false, 'sin lineas vigentes la OT no se cobra');
        assert.equal(await stockBodega(insumo), 10);

        const otraVez = await pedir('POST', ruta, 'administrativo');
        assert.equal(otraVez.status, 200);
        assert.equal(await stockBodega(insumo), 10, 'anular dos veces no devuelve el stock dos veces');
    });

    test('el mecanico no anula lineas de una OT ajena', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno', datos.mecanicoDosId);
        const linea = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanicoDos', { descripcion: 'Correa', cantidad: 1 });
        const r = await pedir('POST', `/api/insumos/orden/${ot}/linea/${linea.body.id}/anular`, 'mecanico');
        assert.equal(r.status, 403);
    });

    test('el mecanico no anula lineas de una OT finalizada, el administrativo si', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Correa', cantidad: 1 });
        await pool.query("UPDATE ordenes_trabajo SET estado = 'finalizada' WHERE id = $1", [ot]);
        const ruta = `/api/insumos/orden/${ot}/linea/${linea.body.id}/anular`;
        assert.equal((await pedir('POST', ruta, 'mecanico')).status, 409);
        assert.equal((await pedir('POST', ruta, 'administrativo')).status, 200);
    });
});

describe('horometro de cualquier equipo', () => {
    test('el mecanico registra la lectura de un equipo que no es de ninguna orden suya', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'mecanico',
            { valor: 321, uuid_cliente: crypto.randomUUID() });
        assert.equal(r.status, 201);
        assert.equal(r.body.lectura.origen, 'movil');
        assert.equal(r.body.lectura.orden_trabajo_id, null);
    });

    test('un reintento de la lectura sin orden no la duplica', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const cuerpo = { valor: 100, uuid_cliente: crypto.randomUUID() };
        const primera = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'mecanico', cuerpo);
        const segunda = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        const filas = await pool.query('SELECT id FROM lecturas_horometro WHERE maquinaria_id = $1', [equipo.id]);
        assert.equal(filas.rows.length, 1);
    });

    test('el mecanico puede reiniciar el contador de un equipo sin tener una orden', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'mecanico',
            { valor: 500, reiniciar_contador: true });
        assert.equal(r.status, 201);
        assert.equal(r.body.contador_reiniciado, true);
    });
});

describe('despacho sin documento', () => {
    test('un despacho sin PDF asigna el equipo al cliente y queda marcado como sin documento', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const cliente = await algunCliente();

        const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo',
            { tipo: 'despacho', cliente_id: cliente, sin_documento: true });

        assert.equal(r.status, 201);
        assert.equal(r.body.archivo_url, null);
        assert.equal(r.body.falta_documento, true);
        assert.ok(r.body.registrada_por, 'queda quien la registro');
        const maq = await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [equipo.id]);
        assert.equal(maq.rows[0].cliente_id, cliente, 'el equipo queda arrendado al cliente');
    });

    test('sin PDF y sin pedirlo expresamente se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo',
            { tipo: 'despacho', cliente_id: await algunCliente() });
        assert.equal(r.status, 400);
    });

    test('el mecanico no puede despachar sin documento', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'mecanico',
            { tipo: 'despacho', cliente_id: await algunCliente(), sin_documento: true });
        assert.equal(r.status, 403);
    });

    test('una recepcion sin documento libera el equipo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(cliente);
        const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo',
            { tipo: 'recepcion', sin_documento: true });
        assert.equal(r.status, 201);
        const maq = await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [equipo.id]);
        assert.equal(maq.rows[0].cliente_id, null);
    });

    test('las guias sin documento se listan completas, sin tope', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const creada = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo',
            { tipo: 'despacho', cliente_id: await algunCliente(), sin_documento: true });
        assert.equal(creada.status, 201);

        const lista = await pedir('GET', '/api/maquinarias/guias/recientes?sin_documento=1', 'administrativo');
        assert.equal(lista.status, 200);
        const fila = lista.body.find((g) => g.id === creada.body.id);
        assert.ok(fila, 'aparece entre las que faltan');
        assert.equal(fila.falta_documento, true);
        assert.equal(fila.url, null);
    });

    test('adjuntar un documento a una guia que ya lo tiene, o que no existe, se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const g = await pool.query(
            `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha) VALUES ($1, 'despacho', 'guias/ya-tiene.pdf', now()) RETURNING id`,
            [equipo.id]
        );
        const enviar = (id) => {
            // un formulario por envio: el cuerpo se consume al enviarlo
            const formulario = new FormData();
            formulario.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'g.pdf');
            return fetch(`${base}/api/maquinarias/guias/${id}/archivo`, {
                method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario,
            });
        };
        assert.equal((await enviar(g.rows[0].id)).status, 409);
        assert.equal((await enviar(999999999)).status, 404);
    });
});

describe('viaje del mecanico y ordenes sin asignar', () => {
    async function estadoDe(ot) {
        const r = await pool.query('SELECT estado, aceptada_at, en_camino_at, llegada_at FROM ordenes_trabajo WHERE id = $1', [ot]);
        return r.rows[0];
    }

    test('aceptar, salir y llegar fijan el estado y su hora, una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');

        const aceptada = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada' });
        assert.equal(aceptada.status, 200);
        const primeraHora = (await estadoDe(ot)).aceptada_at;
        assert.ok(primeraHora, 'queda la hora de aceptacion');

        const camino = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_camino' });
        assert.equal(camino.status, 200);
        const llegada = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno' });
        assert.equal(llegada.status, 200);

        // reintentos atrasados de la cola: no retroceden el estado ni pisan las horas
        const reintento = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada' });
        assert.equal(reintento.status, 200);
        const fila = await estadoDe(ot);
        assert.equal(fila.estado, 'en_terreno');
        assert.equal(fila.aceptada_at.getTime(), primeraHora.getTime());
        assert.ok(fila.en_camino_at && fila.llegada_at);
    });

    test('la hora del toque en el telefono se respeta y nunca queda en el futuro', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '1 day' WHERE id = $1", [ot]);
        const hace2h = new Date(Date.now() - 2 * 3600 * 1000);
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', ocurrio_en: hace2h.toISOString() });
        const fila = await estadoDe(ot);
        assert.ok(Math.abs(fila.aceptada_at.getTime() - hace2h.getTime()) < 1000);

        const ot2 = await crearOt('asignada');
        const manana = new Date(Date.now() + 24 * 3600 * 1000);
        await pedir('PATCH', `/api/ordenes-trabajo/${ot2}/diagnostico`, 'mecanico', { estado: 'en_camino', ocurrio_en: manana.toISOString() });
        assert.ok((await estadoDe(ot2)).en_camino_at.getTime() <= Date.now() + 1000);
    });

    test('un APK anterior puede pasar de asignada directo a en_terreno', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno' });
        assert.equal(r.status, 200);
        assert.equal((await estadoDe(ot)).estado, 'en_terreno');
    });

    test('reasignar una OT del viaje a otro tecnico la deja asignada y borra las horas del anterior', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada' });
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_camino' });
        const antes = await estadoDe(ot);
        assert.ok(antes.aceptada_at && antes.en_camino_at);

        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoDosId });
        assert.equal(r.status, 200);
        const fila = await estadoDe(ot);
        assert.equal(fila.estado, 'asignada');
        assert.equal(fila.aceptada_at, null);
        assert.equal(fila.en_camino_at, null);
    });

    test('asignar otra vez al mismo tecnico una OT en camino no la hace retroceder', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_camino' });
        const antes = await estadoDe(ot);

        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId });
        assert.equal(r.status, 200);
        const fila = await estadoDe(ot);
        assert.equal(fila.estado, 'en_camino');
        assert.equal(fila.en_camino_at.getTime(), antes.en_camino_at.getTime());
    });

    test('la hora del telefono no puede quedar antes de que existiera la orden', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        const antiguo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', ocurrio_en: antiguo.toISOString() });
        const creada = (await pool.query('SELECT fecha_creacion FROM ordenes_trabajo WHERE id = $1', [ot])).rows[0].fecha_creacion;
        assert.ok((await estadoDe(ot)).aceptada_at.getTime() >= creada.getTime());
    });

    test('un id no numerico al tomar una orden responde 400', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('PATCH', '/api/ordenes-trabajo/abc/tomar', 'mecanico');
        assert.equal(r.status, 400);
    });

    test('el mecanico ve las ordenes sin asignar y las puede tomar', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente', null);

        const lista = await pedir('GET', '/api/ordenes-trabajo?sin_asignar=1', 'mecanico');
        assert.equal(lista.status, 200);
        assert.ok(lista.body.items.some((o) => o.id === ot), 'aparece entre las sin asignar');
        const suyas = await pedir('GET', '/api/ordenes-trabajo', 'mecanico');
        assert.ok(!suyas.body.items.some((o) => o.id === ot), 'no aparece en sus ordenes mientras no la tome');

        const tomada = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico');
        assert.equal(tomada.status, 200);
        assert.equal(tomada.body.estado, 'asignada');
        assert.equal(tomada.body.mecanico_id, datos.mecanicoId);

        const reintento = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico');
        assert.equal(reintento.status, 200, 'reintentar la propia toma responde bien');
        const otro = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanicoDos');
        assert.equal(otro.status, 409, 'otro mecanico ya no puede tomarla');
    });

    test('dos mecanicos tomando la misma orden a la vez: solo uno la logra', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente', null);
        const [a, b] = await Promise.all([
            pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico'),
            pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanicoDos'),
        ]);
        assert.deepEqual([a.status, b.status].sort(), [200, 409]);
        const r = await pool.query('SELECT mecanico_id FROM ordenes_trabajo WHERE id = $1', [ot]);
        assert.ok([datos.mecanicoId, datos.mecanicoDosId].includes(r.rows[0].mecanico_id));
    });

    test('no se puede tomar una orden que ya tiene mecanico ni una inexistente', async (t) => {
        if (!requiereBase(t)) return;
        const asignada = await crearOt('asignada', datos.mecanicoDosId);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${asignada}/tomar`, 'mecanico')).status, 409);
        assert.equal((await pedir('PATCH', '/api/ordenes-trabajo/999999999/tomar', 'mecanico')).status, 404);
    });
});

describe('ciclo de vida de la OT', () => {
    const avisosDe = async (ot, tipo) => (await pool.query(
        `SELECT id FROM notificaciones_pendientes
         WHERE (payload->>'orden_trabajo_id')::int = $1 AND payload->>'tipo' = $2`,
        [ot, tipo]
    )).rows.length;

    test('cerrar dos veces no cambia la fecha de cierre ni repite el aviso al cliente', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        const cuerpo = { persona_recibe: 'Juan Perez' };
        const primera = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', cuerpo);
        const segunda = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', cuerpo);
        assert.equal(primera.status, 200);
        assert.equal(segunda.status, 200, 'el reintento responde bien');
        assert.equal(segunda.body.fecha_cierre, primera.body.fecha_cierre);
        const cliente = await pool.query('SELECT cliente_id FROM ordenes_trabajo WHERE id = $1', [ot]);
        if (cliente.rows[0].cliente_id) {
            assert.ok(await avisosDe(ot, 'ot_finalizada') <= 1, 'a lo mas un aviso de cierre');
        }
    });

    test('una OT finalizada no se reasigna ni se reabre', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        const asignar = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoDosId });
        assert.equal(asignar.status, 409);
        const reabrir = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno' });
        assert.equal(reabrir.status, 409);
        const estado = await pool.query('SELECT estado, mecanico_id FROM ordenes_trabajo WHERE id = $1', [ot]);
        assert.equal(estado.rows[0].estado, 'finalizada');
        assert.equal(estado.rows[0].mecanico_id, datos.mecanicoId);
    });

    test('reasignar una OT en curso cambia el tecnico sin hacerla retroceder', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoDosId });
        assert.equal(r.status, 200);
        assert.equal(r.body.estado, 'en_reparacion');
        assert.equal(r.body.mecanico_id, datos.mecanicoDosId);
    });

    test('el mecanico no agrega repuestos, tramos ni fotos a una OT cerrada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        assert.equal((await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Filtro', cantidad: 1 })).status, 409);
        assert.equal((await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', { inicio: new Date().toISOString() })).status, 409);
        assert.equal((await pedir('POST', `/api/ordenes-trabajo/${ot}/evidencia/confirmar`, 'mecanico', { path: `ot-${ot}/x.jpg` })).status, 409);
    });

    test('la evidencia de otra orden se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/evidencia/confirmar`, 'mecanico', { path: `ot-${ot + 1}/ajena.jpg` });
        assert.equal(r.status, 400);
    });

    test('solo se valoriza una OT finalizada, y no aparece antes en la cola del gerente', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Bomba', cantidad: 1, facturable: 'si' });
        const enCurso = await pedir('GET', '/api/facturacion/pendientes', 'gerente');
        assert.ok(!enCurso.body.reparaciones_pendientes_valorizar.some((o) => o.id === ot), 'en curso no se valoriza');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 1000 })).status, 409);

        await pool.query("UPDATE ordenes_trabajo SET estado = 'finalizada' WHERE id = $1", [ot]);
        const cerrada = await pedir('GET', '/api/facturacion/pendientes', 'gerente');
        assert.ok(cerrada.body.reparaciones_pendientes_valorizar.some((o) => o.id === ot));
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 0 })).status, 200);
    });
});

// ---------------------------------------------------------------------------------------------
// Cliente de la orden y costos por equipo
// ---------------------------------------------------------------------------------------------

/** Equipo propio de la prueba: las reglas no deben depender de los equipos que ya existan. */
async function crearEquipo(clienteId = null) {
    const r = await pool.query(
        `INSERT INTO maquinarias (codigo, tipo, cliente_id) VALUES ($1, 'Equipo de prueba', $2) RETURNING id, codigo`,
        [`ZZ-${crypto.randomUUID().slice(0, 8)}`, clienteId]
    );
    datos.equipos.push(r.rows[0].id);
    return r.rows[0];
}

async function algunCliente() {
    const r = await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 1');
    return r.rows[0] ? r.rows[0].id : null;
}

describe('cliente de la orden de trabajo', () => {
    test('una orden nueva toma el cliente que tiene el equipo, sin que se lo pidan', async (t) => {
        if (!requiereBase(t)) return;
        const clienteId = await algunCliente();
        if (!clienteId) return t.skip('la base no tiene clientes');
        const equipo = await crearEquipo(clienteId);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, motivo: 'prueba' });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.equal(r.body.cliente_id, clienteId);
    });

    test('un equipo sin cliente da una orden sin cliente: es mantencion interna', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, motivo: 'prueba' });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.equal(r.body.cliente_id, null);
    });

    test('un cliente explicito de la llamada se respeta', async (t) => {
        if (!requiereBase(t)) return;
        const clienteId = await algunCliente();
        if (!clienteId) return t.skip('la base no tiene clientes');
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, cliente_id: clienteId });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.equal(r.body.cliente_id, clienteId);
    });

    test('la orden conserva su cliente aunque el equipo se devuelva despues', async (t) => {
        if (!requiereBase(t)) return;
        const clienteId = await algunCliente();
        if (!clienteId) return t.skip('la base no tiene clientes');
        const equipo = await crearEquipo(clienteId);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, motivo: 'prueba' });
        datos.ordenes.push(r.body.id);
        // la guia de recepcion deja el equipo sin cliente
        await pool.query('UPDATE maquinarias SET cliente_id = NULL WHERE id = $1', [equipo.id]);
        const guardada = await pool.query('SELECT cliente_id FROM ordenes_trabajo WHERE id = $1', [r.body.id]);
        assert.equal(guardada.rows[0].cliente_id, clienteId);
    });

    test('un equipo que no existe se informa como tal, no como error del servidor', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: 999999999, motivo: 'prueba' });
        assert.equal(r.status, 404);
    });

    test('sin equipo se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { motivo: 'prueba' });
        assert.equal(r.status, 400);
    });
});

describe('costos por equipo', () => {
    /** Un equipo con todo lo que entra a las cuentas: repuestos, factura, arriendo y horometro. */
    async function equipoConMovimiento() {
        const clienteId = await algunCliente();
        const equipo = await crearEquipo(clienteId);
        const ot = await crearOt('finalizada', datos.mecanicoId, equipo.id);

        // gasto: 3 x $1.000, mas una linea anulada que NO debe contar
        await pool.query(
            `INSERT INTO movimientos_insumo (orden_trabajo_id, cantidad, tipo, precio_unitario, descripcion)
             VALUES ($1, 3, 'salida', 1000, 'repuesto de prueba')`,
            [ot]
        );
        await pool.query(
            `INSERT INTO movimientos_insumo (orden_trabajo_id, cantidad, tipo, precio_unitario, descripcion, anulada_at)
             VALUES ($1, 5, 'salida', 9999, 'linea anulada de prueba', now())`,
            [ot]
        );
        // ingreso: una factura de arriendo directa al equipo
        await pool.query(`INSERT INTO facturas (folio, archivo_url, monto, maquinaria_id) VALUES ('T-COSTOS', 'x', 10000, $1)`, [equipo.id]);

        // arriendo del dia 40 al 35 hacia atras (6 dias con el despacho de la manana), y un
        // despacho fallido que no debe sumar nada
        const hace = (dias, hora) => {
            const d = new Date();
            d.setDate(d.getDate() - dias);
            d.setHours(hora, 0, 0, 0);
            return d;
        };
        const guia = (tipo, fecha, fallido = false) =>
            pool.query(
                `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, fallido, cliente_id) VALUES ($1, $2, 'x', $3, $4, $5)`,
                [equipo.id, tipo, fecha, fallido, clienteId]
            );
        await guia('despacho', hace(40, 9));
        await guia('recepcion', hace(35, 9));
        await guia('despacho', hace(20, 9), true);
        await guia('recepcion', hace(15, 9), true);

        // horometro: 100 h hace 60 dias y 160 h hace 10 dias = 60 h de uso
        await pool.query(
            `INSERT INTO lecturas_horometro (maquinaria_id, valor, origen, fecha) VALUES ($1, 100, 'panel', $2), ($1, 160, 'panel', $3)`,
            [equipo.id, hace(60, 10), hace(10, 10)]
        );
        return equipo;
    }

    const buscar = async (equipo, extra = '') => {
        const r = await pedir('GET', `/api/rentabilidad?q=${equipo.codigo}${extra}`, 'administrativo');
        assert.equal(r.status, 200);
        return r.body;
    };

    test('calcula gasto, ingreso, margen y las medidas de la industria de un equipo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await equipoConMovimiento();
        const { items } = await buscar(equipo);
        assert.equal(items.length, 1);
        const e = items[0];
        assert.equal(e.gasto, 3000, 'la linea anulada no cuenta como gasto');
        assert.equal(e.ingreso, 10000);
        assert.equal(e.margen, 7000);
        assert.equal(e.resultado, 'con_ganancia');
        assert.equal(e.gasto_sobre_ingreso, 30);
        assert.equal(e.horas_uso, 60);
        assert.equal(e.gasto_por_hora, 50);
        assert.equal(e.dias_arrendado, 6, 'las guias fallidas no suman dias');
    });

    test('un equipo sin movimiento queda sin datos en vez de inventarlos', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const { items } = await buscar(equipo);
        const e = items[0];
        assert.equal(e.resultado, 'sin_movimiento');
        assert.equal(e.gasto_sobre_ingreso, null);
        assert.equal(e.gasto_por_hora, null);
        assert.equal(e.horas_uso, null);
        assert.equal(e.dias_arrendado, 0);
    });

    test('el filtro por resultado deja solo los equipos de esa clase', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await equipoConMovimiento();
        const gana = await buscar(equipo, '&resultado=con_ganancia');
        assert.equal(gana.items.length, 1);
        const pierde = await buscar(equipo, '&resultado=a_perdida');
        assert.equal(pierde.items.length, 0);
    });

    test('el resumen de arriba no cambia al buscar un equipo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await equipoConMovimiento();
        const todos = (await pedir('GET', '/api/rentabilidad?limit=1', 'administrativo')).body;
        const uno = await buscar(equipo);
        assert.deepEqual(uno.resumen, todos.resumen);
        assert.ok(todos.resumen.gasto_total >= 3000);
        assert.ok(todos.resumen.ingreso_total >= 10000);
    });

    test('ordenar por una columna deja los vacios al final, en los dos sentidos', async (t) => {
        if (!requiereBase(t)) return;
        await equipoConMovimiento();
        for (const dir of ['asc', 'desc']) {
            const r = await pedir('GET', `/api/rentabilidad?orden=hora&dir=${dir}`, 'administrativo');
            const valores = r.body.items.map((e) => e.gasto_por_hora);
            const primerVacio = valores.indexOf(null);
            if (primerVacio !== -1) assert.ok(valores.slice(primerVacio).every((v) => v === null), `${dir}: un valor aparecio despues de un vacio`);
            const conValor = valores.filter((v) => v !== null);
            const esperado = [...conValor].sort((a, b) => (dir === 'asc' ? a - b : b - a));
            assert.deepEqual(conValor, esperado);
        }
    });

    test('un orden inventado no rompe la consulta', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', `/api/rentabilidad?orden=${encodeURIComponent("x'; DROP TABLE maquinarias; --")}`, 'administrativo');
        assert.equal(r.status, 200);
    });

    test('el mecanico no ve los costos', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', '/api/rentabilidad', 'mecanico');
        assert.equal(r.status, 403);
    });
});

describe('alta de equipos', () => {
    test('repetir un codigo se informa como un choque que se puede corregir, no como un error del servidor', async (t) => {
        if (!requiereBase(t)) return;
        const codigo = `ZZ-${crypto.randomUUID().slice(0, 8)}`;
        const primero = await pedir('POST', '/api/maquinarias', 'administrativo', { codigo, tipo: 'Equipo de prueba' });
        assert.equal(primero.status, 201);
        datos.equipos.push(primero.body.id);
        const repetido = await pedir('POST', '/api/maquinarias', 'administrativo', { codigo, tipo: 'Otro' });
        assert.equal(repetido.status, 409);
        assert.match(repetido.body.error, new RegExp(codigo));
    });

    test('sin codigo o sin tipo se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await pedir('POST', '/api/maquinarias', 'administrativo', { tipo: 'X' })).status, 400);
        assert.equal((await pedir('POST', '/api/maquinarias', 'administrativo', { codigo: 'ZZ-SINTIPO' })).status, 400);
    });

    test('solo el administrativo da de alta equipos', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/maquinarias', 'mecanico', { codigo: 'ZZ-NOPUEDE', tipo: 'X' });
        assert.equal(r.status, 403);
    });
});

// ---------------------------------------------------------------------------------------------
// Historial de la orden (ordenes_eventos, migracion 020)
// ---------------------------------------------------------------------------------------------

/** Eventos de una OT en el orden en que se registraron. */
async function eventosDe(ot) {
    const r = await pool.query('SELECT * FROM ordenes_eventos WHERE orden_trabajo_id = $1 ORDER BY id', [ot]);
    return r.rows;
}

describe('historial de la orden: un evento por cada cambio', () => {
    test('crear una OT desde el panel deja el evento de creacion con quien la creo', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: datos.maquinariaId, motivo: 'prueba de historial' });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        const eventos = await eventosDe(r.body.id);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'creacion');
        assert.equal(eventos[0].origen, 'panel');
        assert.equal(eventos[0].rol, 'administrativo');
        assert.equal(eventos[0].estado_nuevo, 'pendiente');
        assert.ok(eventos[0].usuario_id);
        assert.equal(eventos[0].aplicado, true);
        assert.equal(eventos[0].hora_dudosa, false);
    });

    test('una creacion que falla no deja evento ni OT a medias', async (t) => {
        if (!requiereBase(t)) return;
        // solo se mira lo que esta prueba habria creado, reconocible por su motivo: no depende de
        // que otras pruebas o procesos escriban a la vez
        const marcador = `creacion-fallida-${crypto.randomUUID()}`;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', {
            maquinaria_id: datos.maquinariaId, origen: 'no_existe', motivo: marcador,
        });
        assert.equal(r.status, 500);
        const ots = await pool.query('SELECT id FROM ordenes_trabajo WHERE motivo = $1', [marcador]);
        assert.equal(ots.rows.length, 0);
        const eventos = await pool.query(
            `SELECT count(*)::int AS n FROM ordenes_eventos e JOIN ordenes_trabajo o ON o.id = e.orden_trabajo_id WHERE o.motivo = $1`,
            [marcador]
        );
        assert.equal(eventos.rows[0].n, 0);
    });

    test('la OT que el mecanico abre en terreno deja su evento, y el reintento no lo duplica', async (t) => {
        if (!requiereBase(t)) return;
        const uuid = crypto.randomUUID();
        const cuerpo = { maquinaria_id: datos.maquinariaId, uuid_cliente: uuid };
        const primera = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        datos.ordenes.push(primera.body.id);
        const segunda = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', cuerpo);
        assert.equal(segunda.status, 200);
        const eventos = await eventosDe(primera.body.id);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'creacion');
        assert.equal(eventos[0].origen, 'terreno');
        assert.equal(eventos[0].estado_nuevo, 'en_terreno');
        assert.equal(eventos[0].uuid_cliente, uuid);
        assert.equal(eventos[0].detalle.mecanico_id, datos.mecanicoId);
    });

    test('convertir una solicitud en OT deja el evento de creacion', async (t) => {
        if (!requiereBase(t)) return;
        const clienteId = await algunCliente();
        if (!clienteId) return t.skip('la base no tiene clientes');
        const equipo = await crearEquipo(clienteId);
        const sol = await pool.query(
            `INSERT INTO solicitudes (cliente_id, maquinaria_id, descripcion) VALUES ($1, $2, 'solicitud de prueba') RETURNING id`,
            [clienteId, equipo.id]
        );
        datos.solicitudes.push(sol.rows[0].id);
        const r = await pedir('PATCH', `/api/solicitudes/${sol.rows[0].id}/convertir`, 'administrativo');
        assert.equal(r.status, 200);
        datos.ordenes.push(r.body.orden_trabajo.id);
        const eventos = await eventosDe(r.body.orden_trabajo.id);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'creacion');
        assert.equal(eventos[0].detalle.solicitud_id, sol.rows[0].id);
        // convertirla otra vez se rechaza y no agrega nada
        assert.equal((await pedir('PATCH', `/api/solicitudes/${sol.rows[0].id}/convertir`, 'administrativo')).status, 400);
        assert.equal((await eventosDe(r.body.orden_trabajo.id)).length, 1);
    });

    test('asignar deja el evento con el tecnico anterior y el nuevo; asignar al mismo no repite', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente', null);
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId });
        assert.equal(r.status, 200);
        let eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'asignacion');
        assert.equal(eventos[0].estado_anterior, 'pendiente');
        assert.equal(eventos[0].estado_nuevo, 'asignada');
        assert.equal(eventos[0].detalle.mecanico_anterior_id, null);
        assert.equal(eventos[0].detalle.mecanico_nuevo_id, datos.mecanicoId);
        assert.equal(eventos[0].origen, 'panel');

        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId });
        assert.equal((await eventosDe(ot)).length, 1, 'el doble clic no deja otro evento');

        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoDosId });
        eventos = await eventosDe(ot);
        assert.equal(eventos.length, 2);
        assert.equal(eventos[1].detalle.mecanico_anterior_id, datos.mecanicoId);
        assert.equal(eventos[1].detalle.mecanico_nuevo_id, datos.mecanicoDosId);
    });

    test('tomar una orden deja el evento de toma, y el reintento del mismo mecanico no lo repite', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente', null);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico')).status, 200);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico')).status, 200);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanicoDos')).status, 409);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'toma');
        assert.equal(eventos[0].origen, 'terreno');
        assert.equal(eventos[0].estado_nuevo, 'asignada');
        assert.equal(eventos[0].detalle.mecanico_nuevo_id, datos.mecanicoId);
    });

    test('cada cambio de estado del diagnostico deja su evento, con el uuid de la tarea (body.uuid)', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        const uuid = crypto.randomUUID();
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', uuid });
        assert.equal(r.status, 200);
        const reintento = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', uuid });
        assert.equal(reintento.status, 200);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1, 'el reintento con el mismo uuid no duplica ni da 500');
        assert.equal(eventos[0].tipo, 'cambio_estado');
        assert.equal(eventos[0].estado_anterior, 'asignada');
        assert.equal(eventos[0].estado_nuevo, 'aceptada');
        assert.equal(eventos[0].aplicado, true);
        assert.equal(eventos[0].uuid_cliente, uuid);
        assert.equal(eventos[0].origen, 'terreno');

        const siguiente = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_camino', uuid_cliente: crypto.randomUUID() });
        assert.equal(siguiente.status, 200);
        assert.equal((await eventosDe(ot)).length, 2);
    });

    test('un cambio de estado atrasado se registra con aplicado = false y no mueve la OT', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', uuid: crypto.randomUUID() });
        assert.equal(r.status, 200);
        assert.equal(r.body.estado, 'en_terreno');
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].aplicado, false);
        assert.equal(eventos[0].estado_anterior, 'en_terreno');
        assert.equal(eventos[0].estado_nuevo, 'aceptada');
    });

    test('un cambio rechazado, o un diagnostico sin estado, no deja evento', async (t) => {
        if (!requiereBase(t)) return;
        const cerrada = await crearOt('finalizada');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${cerrada}/diagnostico`, 'mecanico', { estado: 'en_terreno' })).status, 409);
        const ajena = await crearOt('en_terreno', datos.mecanicoDosId);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ajena}/diagnostico`, 'mecanico', { estado: 'en_reparacion' })).status, 403);
        const sinEstado = await crearOt('en_terreno');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${sinEstado}/diagnostico`, 'mecanico', { diagnostico: 'solo texto' })).status, 200);
        assert.equal((await eventosDe(cerrada)).length, 0);
        assert.equal((await eventosDe(ajena)).length, 0);
        assert.equal((await eventosDe(sinEstado)).length, 0);
    });

    test('un uuid malformado no rompe el cambio: se registra sin idempotencia', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', uuid: 'no-es-un-uuid' });
        assert.equal(r.status, 200);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].uuid_cliente, null);
    });

    test('la hora del telefono en el futuro o antes de crear la OT marca el evento como dudoso', async (t) => {
        if (!requiereBase(t)) return;
        const futura = await crearOt('asignada');
        const manana = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        await pedir('PATCH', `/api/ordenes-trabajo/${futura}/diagnostico`, 'mecanico', { estado: 'aceptada', ocurrio_en: manana });
        const evFutura = (await eventosDe(futura))[0];
        assert.equal(evFutura.hora_dudosa, true);
        assert.equal(new Date(evFutura.ocurrio_en).toISOString(), manana, 'el evento guarda la hora tal como vino');

        const antigua = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '1 hour' WHERE id = $1", [antigua]);
        await pedir('PATCH', `/api/ordenes-trabajo/${antigua}/diagnostico`, 'mecanico', {
            estado: 'aceptada', ocurrio_en: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
        });
        assert.equal((await eventosDe(antigua))[0].hora_dudosa, true);

        const normal = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '2 hours' WHERE id = $1", [normal]);
        await pedir('PATCH', `/api/ordenes-trabajo/${normal}/diagnostico`, 'mecanico', {
            estado: 'aceptada', ocurrio_en: new Date(Date.now() - 3600 * 1000).toISOString(),
        });
        assert.equal((await eventosDe(normal))[0].hora_dudosa, false);
    });

    test('finalizar deja el evento de cierre; el reintento de un cierre ya aplicado no deja otro', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { sin_persona: true });
        assert.equal(r.status, 200);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { sin_persona: true })).status, 200);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'cierre');
        assert.equal(eventos[0].estado_anterior, 'en_reparacion');
        assert.equal(eventos[0].estado_nuevo, 'finalizada');
        assert.equal(eventos[0].origen, 'terreno');
        assert.equal(new Date(eventos[0].ocurrio_en).getTime(), new Date(r.body.fecha_cierre).getTime());
    });

    test('una orden pendiente no se cierra y no deja evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { sin_persona: true })).status, 409);
        assert.equal((await eventosDe(ot)).length, 0);
    });

    test('valorizar deja el evento con el monto anterior y el nuevo', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 15000 })).status, 200);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 20000 })).status, 200);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 2);
        assert.equal(eventos[0].tipo, 'valorizacion');
        assert.equal(eventos[0].rol, 'gerente');
        assert.equal(eventos[0].origen, 'panel');
        assert.equal(eventos[0].detalle.valorizacion_anterior, null);
        assert.equal(eventos[0].detalle.valorizacion_nueva, 15000);
        assert.equal(eventos[1].detalle.valorizacion_anterior, 15000);
        assert.equal(eventos[1].detalle.valorizacion_nueva, 20000);
    });

    test('una valorizacion rechazada no deja evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 100 })).status, 409);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: -5 })).status, 400);
        assert.equal((await pedir('PATCH', '/api/ordenes-trabajo/99999999/valorizacion', 'gerente', { valorizacion: 100 })).status, 404);
        assert.equal((await eventosDe(ot)).length, 0);
    });
});

describe('historial de la orden: el candado de solo insercion', () => {
    test('el trigger rechaza UPDATE, DELETE y TRUNCATE, y la clave foranea impide borrar la OT', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 1 });
        await assert.rejects(
            pool.query("UPDATE ordenes_eventos SET rol = 'x' WHERE orden_trabajo_id = $1", [ot]),
            /solo insercion/
        );
        await assert.rejects(pool.query('DELETE FROM ordenes_eventos WHERE orden_trabajo_id = $1', [ot]), /solo insercion/);
        await assert.rejects(pool.query('TRUNCATE ordenes_eventos'), /solo insercion/);
        await assert.rejects(pool.query('DELETE FROM ordenes_trabajo WHERE id = $1', [ot]), { code: '23503' });
        assert.equal((await eventosDe(ot)).length, 1);
    });

    test('con la via de purga activa se puede modificar y borrar, y vale solo dentro de la transaccion', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 1 });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL gomaq.purga = 'on'");
            const upd = await client.query("UPDATE ordenes_eventos SET rol = 'x' WHERE orden_trabajo_id = $1", [ot]);
            assert.equal(upd.rowCount, 1);
            await client.query('ROLLBACK');
            // fuera de la transaccion la purga ya no esta activa
            await assert.rejects(client.query("UPDATE ordenes_eventos SET rol = 'x' WHERE orden_trabajo_id = $1", [ot]), /solo insercion/);
        } finally {
            client.release();
        }
        await purgarOrdenes([ot]);
        assert.equal((await eventosDe(ot)).length, 0);
        assert.equal((await pool.query('SELECT 1 FROM ordenes_trabajo WHERE id = $1', [ot])).rows.length, 0);
    });

    test('un evento con el mismo uuid y tipo no se inserta dos veces; sin uuid si se repite; tipo y origen se validan', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        const uuid = crypto.randomUUID();
        const sql = `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen, uuid_cliente)
                     VALUES ($1, $2, now(), 'sistema', $3) ON CONFLICT DO NOTHING`;
        await pool.query(sql, [ot, 'cambio_estado', uuid]);
        await pool.query(sql, [ot, 'cambio_estado', uuid]);
        await pool.query(sql, [ot, 'cierre', uuid]);
        await pool.query(sql, [ot, 'cambio_estado', null]);
        await pool.query(sql, [ot, 'cambio_estado', null]);
        assert.equal((await eventosDe(ot)).length, 4);
        await assert.rejects(pool.query("INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen) VALUES ($1, 'inventado', now(), 'sistema')", [ot]), { code: '23514' });
        await assert.rejects(pool.query("INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen) VALUES ($1, 'cierre', now(), 'otro')", [ot]), { code: '23514' });
    });
});

describe('historial de la orden: carga inicial de la migracion', () => {
    test('reconstruye los eventos de una OT existente desde sus fechas', async (t) => {
        if (!requiereBase(t)) return;
        const fs = require('node:fs');
        const path = require('node:path');
        const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/020_ordenes_eventos.sql'), 'utf8');
        const carga = sql.slice(sql.indexOf('-- Carga inicial'));
        assert.ok(carga.includes('INSERT INTO ordenes_eventos'), 'no se encontro la carga inicial en la migracion');

        const ot = await crearOt('finalizada');
        await pool.query(
            `UPDATE ordenes_trabajo SET fecha_creacion = '2026-01-01 08:00+00', aceptada_at = '2026-01-01 09:00+00',
                    en_camino_at = '2026-01-01 09:30+00', llegada_at = '2026-01-01 10:00+00', fecha_cierre = '2026-01-01 12:00+00'
             WHERE id = $1`,
            [ot]
        );
        // un APK antiguo salta de asignada a en_camino: aceptada_at queda nulo
        const saltada = await crearOt('en_camino');
        await pool.query(
            "UPDATE ordenes_trabajo SET fecha_creacion = '2026-01-02 08:00+00', en_camino_at = '2026-01-02 09:30+00' WHERE id = $1",
            [saltada]
        );
        const client = await pool.connect();
        try {
            // se corre dentro de una transaccion que se deshace: la carga toca todas las OT de la base
            await client.query('BEGIN');
            await client.query(carga);
            const r = await client.query(
                'SELECT tipo, estado_anterior, estado_nuevo, origen, usuario_id, ocurrio_en FROM ordenes_eventos WHERE orden_trabajo_id = $1 ORDER BY ocurrio_en, id',
                [ot]
            );
            const s = await client.query(
                `SELECT tipo, estado_anterior, estado_nuevo FROM ordenes_eventos WHERE orden_trabajo_id = $1 AND tipo = 'cambio_estado'`,
                [saltada]
            );
            await client.query('ROLLBACK');
            assert.deepEqual(s.rows, [{ tipo: 'cambio_estado', estado_anterior: null, estado_nuevo: 'en_camino' }],
                'sin aceptada_at no se inventa el estado anterior');
            assert.equal(r.rows[2].estado_anterior, 'aceptada');
            assert.deepEqual(r.rows.map((e) => [e.tipo, e.estado_nuevo]), [
                ['creacion', null], ['cambio_estado', 'aceptada'], ['cambio_estado', 'en_camino'],
                ['cambio_estado', 'en_terreno'], ['cierre', 'finalizada'],
            ]);
            assert.ok(r.rows.every((e) => e.origen === 'migracion' && e.usuario_id === null));
            assert.equal(r.rows[4].ocurrio_en.toISOString(), '2026-01-01T12:00:00.000Z');
        } finally {
            client.release();
        }
        assert.equal((await eventosDe(ot)).length, 0, 'la prueba no deja eventos');
    });
});

describe('historial de la orden: endpoint GET /:id/historial', () => {
    test('devuelve los eventos en el orden en que llegaron al servidor, con el nombre de quien los hizo', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '3 hours' WHERE id = $1", [ot]);
        const haceUnaHora = new Date(Date.now() - 3600 * 1000).toISOString();
        const haceDosHoras = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        // llega primero lo que ocurrio despues: el historial ordena por orden de escritura (id), no por ocurrio_en
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno', ocurrio_en: haceUnaHora });
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', ocurrio_en: haceDosHoras });

        for (const rol of ['administrativo', 'gerente']) {
            const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, rol);
            assert.equal(r.status, 200);
            assert.equal(r.body.length, 2);
            assert.deepEqual(r.body.map((e) => e.estado_nuevo), ['en_terreno', 'aceptada']);
            assert.equal(r.body[1].aplicado, false, 'la aceptada llego atrasada y no movio nada');
            assert.equal(r.body[0].usuario_nombre, 'Mecanico Prueba');
            assert.ok(r.body.every((e) => e.sincronizado_tarde === true), 'ocurrieron hace horas y llegaron ahora');
        }
    });

    test('un evento registrado al momento no figura como sincronizado tarde', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 10 });
        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'administrativo');
        assert.equal(r.body.length, 1);
        assert.equal(r.body[0].sincronizado_tarde, false);
        assert.equal(r.body[0].usuario_nombre, 'Admin Prueba');
    });

    test('un id invalido responde 400 y una OT inexistente 404', async (t) => {
        if (!requiereBase(t)) return;
        for (const id of ['abc', '0', '-3', '1.5', '1e3', '99999999999999']) {
            const r = await pedir('GET', `/api/ordenes-trabajo/${id}/historial`, 'administrativo');
            assert.equal(r.status, 400, `id ${id}`);
        }
        assert.equal((await pedir('GET', '/api/ordenes-trabajo/99999999/historial', 'administrativo')).status, 404);
    });

    test('el mecanico y el cliente no ven el historial', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno');
        assert.equal((await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'mecanico')).status, 403);
        assert.equal((await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'cliente')).status, 403);
    });
});

describe('historial de la orden: OT creada en terreno sin senal y hora dudosa', () => {
    /** Abre una OT como lo hace la app al sincronizar: nace ahora, aunque el mecanico la creo antes. */
    async function abrirEnTerreno() {
        const r = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', {
            maquinaria_id: datos.maquinariaId, uuid_cliente: crypto.randomUUID(),
        });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        return r.body.id;
    }

    test('los eventos anteriores a la fecha de creacion de una OT sincronizada no son dudosos; la creacion va primero y el resto por llegada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await abrirEnTerreno();
        const haceUnaHora = new Date(Date.now() - 3600 * 1000).toISOString();
        const haceMediaHora = new Date(Date.now() - 1800 * 1000).toISOString();
        for (const [estado, ocurrio_en] of [['en_reparacion', haceMediaHora], ['en_terreno', haceUnaHora]]) {
            const p = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado, ocurrio_en, uuid: crypto.randomUUID() });
            assert.equal(p.status, 200);
        }
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 3);
        assert.ok(eventos.every((e) => e.hora_dudosa === false), 'ninguno es dudoso');

        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'administrativo');
        assert.equal(r.status, 200);
        assert.equal(r.body[0].tipo, 'creacion', 'la creacion va primero aunque sea la mas reciente');
        assert.deepEqual(r.body.slice(1).map((e) => e.estado_nuevo), ['en_reparacion', 'en_terreno'], 'el resto, por orden de escritura');
    });

    test('una OT que no nacio por sincronizacion sigue marcando dudoso lo anterior a su creacion', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '1 hour' WHERE id = $1", [ot]);
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', {
            estado: 'aceptada', ocurrio_en: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
        });
        assert.equal((await eventosDe(ot))[0].hora_dudosa, true);
    });

    test('una hora en el futuro es dudosa (con 2 minutos de margen) y no altera el orden de llegada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await abrirEnTerreno();
        const manana = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_reparacion', ocurrio_en: manana, uuid: crypto.randomUUID() });
        // sin hora del telefono: la del servidor, que es posterior a la llegada del primero
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno', uuid: crypto.randomUUID() });
        const eventos = await eventosDe(ot);
        assert.equal(eventos[1].hora_dudosa, true);
        assert.equal(eventos[2].hora_dudosa, false);

        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'gerente');
        assert.deepEqual(r.body.map((e) => e.tipo === 'creacion' ? 'creacion' : e.estado_nuevo), ['creacion', 'en_reparacion', 'en_terreno'],
            'el orden es el de llegada aunque la hora del primero este en el futuro');

        // un reloj adelantado un minuto cae dentro del margen
        const unMinuto = new Date(Date.now() + 60 * 1000).toISOString();
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_reparacion', ocurrio_en: unMinuto, uuid: crypto.randomUUID() });
        assert.equal((await eventosDe(ot))[3].hora_dudosa, false);
    });

    test('con el reloj del telefono atrasado y horas fuera de orden, la cadena de estados sale coherente y en orden de llegada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '5 hours' WHERE id = $1", [ot]);
        const hace = (min) => new Date(Date.now() - min * 60 * 1000).toISOString();
        // el telefono va una hora atrasado y sus horas ni siquiera siguen el orden de los pasos
        const pasos = [['aceptada', hace(110)], ['en_camino', hace(120)], ['en_terreno', hace(115)]];
        for (const [estado, ocurrio_en] of pasos) {
            const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado, ocurrio_en, uuid: crypto.randomUUID() });
            assert.equal(r.status, 200);
        }
        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'administrativo');
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.map((e) => [e.estado_anterior, e.estado_nuevo]), [
            ['asignada', 'aceptada'], ['aceptada', 'en_camino'], ['en_camino', 'en_terreno'],
        ], 'cada "de X a Y" parte de donde termino el anterior');
        assert.ok(r.body.every((e) => e.aplicado === true && e.hora_dudosa === false));
    });

    test('los eventos con la hora del servidor (creacion y cierre) no pasan por la hora dudosa', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: datos.maquinariaId });
        datos.ordenes.push(r.body.id);
        const ev = (await eventosDe(r.body.id))[0];
        assert.equal(ev.hora_dudosa, false);
        assert.equal(new Date(ev.ocurrio_en).getTime(), new Date(r.body.fecha_creacion).getTime());
    });
});

describe('historial de la orden: orden y sincronizacion tardia con datos insertados a mano', () => {
    test('un evento reconstruido por la migracion no figura como sincronizado tarde', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        // como la carga inicial de la migracion: hora historica y registrado_en = ahora
        await pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, registrado_en, origen)
             VALUES ($1, 'cierre', now() - interval '90 days', now(), 'migracion')`,
            [ot]
        );
        await pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, registrado_en, origen)
             VALUES ($1, 'valorizacion', now() - interval '90 days', now(), 'panel')`,
            [ot]
        );
        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'administrativo');
        assert.equal(r.status, 200);
        assert.equal(r.body.find((e) => e.origen === 'migracion').sincronizado_tarde, false);
        assert.equal(r.body.find((e) => e.origen === 'panel').sincronizado_tarde, true, 'el resto sigue la regla de los 10 minutos');
        // la limpieza de la OT (hook after) usa la via de purga
    });

    test('la creacion va primero aunque otro evento tenga un id menor', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno');
        await pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, estado_nuevo, ocurrio_en, origen)
             VALUES ($1, 'cambio_estado', 'en_terreno', now(), 'terreno')`,
            [ot]
        );
        await pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, estado_nuevo, ocurrio_en, origen)
             VALUES ($1, 'creacion', 'en_terreno', now(), 'terreno')`,
            [ot]
        );
        const eventos = await eventosDe(ot);
        assert.equal(eventos[0].tipo, 'cambio_estado', 'el cambio tiene el id menor');
        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'gerente');
        assert.deepEqual(r.body.map((e) => e.tipo), ['creacion', 'cambio_estado']);
    });
});
