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
const datos = { ordenes: [], insumos: [] };
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
    app.use('/api/insumos', require('../src/routes/insumos'));
    app.use('/api/horometro', require('../src/routes/horometro').router);
    app.use('/api/facturacion', require('../src/routes/facturacion'));
    await new Promise((resolve) => { servidor = app.listen(0, resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;

    const usuarios = await pool.query(
        `SELECT id, rol, email FROM usuarios
         WHERE email IN ('administrativo@gomaq.test', 'mecanico@gomaq.test', 'mecanico2@gomaq.test', 'admin@gomaq.test')`
    );
    const porEmail = Object.fromEntries(usuarios.rows.map((u) => [u.email, u]));
    const firmar = (u) => jwt.sign({ id: u.id, rol: u.rol, cliente_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokens.administrativo = firmar(porEmail['administrativo@gomaq.test']);
    tokens.gerente = firmar(porEmail['admin@gomaq.test']);
    tokens.mecanico = firmar(porEmail['mecanico@gomaq.test']);
    tokens.mecanicoDos = firmar(porEmail['mecanico2@gomaq.test']);
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

after(async () => {
    if (!HABILITADO) return;
    const ots = datos.ordenes;
    if (ots.length) {
        await pool.query('DELETE FROM notificaciones_pendientes WHERE (payload->>\'orden_trabajo_id\')::int = ANY($1)', [ots]);
        await pool.query('DELETE FROM lecturas_horometro WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM tramos_trabajo WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM evidencias_fotograficas WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM firmas_recepcion WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM movimientos_insumo WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM ordenes_trabajo WHERE id = ANY($1)', [ots]);
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
    await new Promise((resolve) => servidor.close(resolve));
    await pool.end();
});

/** OT de prueba asignada al mecanico, creada directo en la base. */
async function crearOt(estado = 'en_terreno', mecanicoId = datos.mecanicoId) {
    // con el cliente del equipo, para que cerrar o asignar encolen el aviso como en la realidad
    const r = await pool.query(
        `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo)
         SELECT id, cliente_id, $2, $3, 'OT de prueba automatizada' FROM maquinarias WHERE id = $1
         RETURNING id`,
        [datos.maquinariaId, mecanicoId, estado]
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
