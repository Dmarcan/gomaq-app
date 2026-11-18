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
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-escritura';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { requiereBase, servirApp, leerRespuesta, pedirConToken: pedirConTokenEn, tokenClienteDe } = require('./utils/http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { diasEntre } = require('../src/utils/diasArriendo');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
const datos = { ordenes: [], insumos: [], equipos: [], ubicaciones: [], solicitudes: [], clientes: [], storage: { subidos: [], borrados: [] } };
const tokens = {};

// GET autenticado con un token ya firmado (usa la URL base que levanta el before)
const pedirConToken = (ruta, token) => pedirConTokenEn(base, ruta, token);

async function pedir(metodo, ruta, rol, cuerpo, cabeceras = {}) {
    const r = await fetch(`${base}${ruta}`, {
        method: metodo,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[rol]}`, ...cabeceras },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    return leerRespuesta(r);
}

before(async () => {
    if (!HABILITADO) return;
    exigirBaseLocal();
    const express = require('express');
    pool = require('../src/config/db');
    // verifyToken revisa la cuenta en la base. Los usuarios reales se buscan ahi; los tokens de
    // relleno de los portales (ids 98765x, que no existen) valen lo que firman, como antes.
    require('../src/middleware/auth').usarBuscadorDeUsuarios(async (id, claims) => {
        if (id >= 987000) return { rol: claims.rol, cliente_id: claims.cliente_id ?? null, estado_cuenta: 'activo' };
        const r = await pool.query('SELECT rol, cliente_id, estado_cuenta, password_cambiada_at FROM usuarios WHERE id = $1', [id]);
        return r.rows[0] || null;
    });

    const app = express();
    app.use(express.json());
    app.use('/api/ordenes-trabajo', require('../src/routes/ordenes'));
    app.use('/api/ordenes-trabajo', require('../src/routes/evidencias'));
    app.use('/api/ordenes-trabajo', require('../src/routes/facturas'));
    app.use('/api/solicitudes', require('../src/routes/solicitudes'));
    app.use('/api/insumos', require('../src/routes/insumos'));
    app.use('/api/horometro', require('../src/routes/horometro').router);
    app.use('/api/facturacion', require('../src/routes/facturacion'));
    app.use('/api/notificaciones', require('../src/routes/notificaciones'));
    app.use('/api/dashboard', require('../src/routes/dashboard'));
    app.use('/api/usuarios', require('../src/routes/usuarios'));
    app.use('/api/auth', require('../src/routes/auth'));
    app.use('/api/rentabilidad', require('../src/routes/rentabilidad'));
    app.use('/api/clientes', require('../src/routes/clientes'));
    app.use('/api/maquinarias', require('../src/routes/maquinarias'));
    app.use('/api/maquinarias', require('../src/routes/guias'));
    // la subida de la factura no toca Supabase de verdad: se anotan los archivos que se suben y borran
    const { supabase } = require('../src/config/supabase');
    supabase.storage.from = () => ({
        upload: async (ruta) => { datos.storage.subidos.push(ruta); return { data: {}, error: null }; },
        remove: async (rutas) => { datos.storage.borrados.push(...rutas); return { data: [], error: null }; },
        createSignedUrl: async (ruta) => {
            if (ruta.includes('firma-falla')) throw new Error('no se pudo firmar');
            return { data: { signedUrl: `https://firmada.test/${ruta}?token=t` }, error: null };
        },
    });
    ({ servidor, base } = await servirApp(app));

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
    // cliente sin empresa vinculada (el usuario de la semilla si tiene cliente_id en la base, y
    // verifyToken lo toma de ahi): un token de relleno, que el buscador de prueba da por bueno
    tokens.cliente = jwt.sign({ id: 987600, rol: 'cliente', cliente_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' });
    datos.mecanicoId = porEmail['mecanico@gomaq.test'].id;
    datos.mecanicoDosId = porEmail['mecanico2@gomaq.test'].id;

    const maquinaria = await pool.query(
        'SELECT id, estado, estado_origen, alerta_mantencion_enviada, horometro_ultima_mantencion FROM maquinarias ORDER BY id LIMIT 1'
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
        await pool.query('DELETE FROM facturas WHERE orden_trabajo_id = ANY($1)', [ots]);
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
    if (datos.clientes.length) {
        await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [datos.clientes]);
    }
    await pool.query(
        `DELETE FROM notificaciones_pendientes
         WHERE created_at >= $1 AND payload->>'tipo' = 'mantencion_proxima'
           AND (payload->>'maquinaria_id')::int = $2`,
        [datos.inicio, datos.maquinariaId]
    );
    await pool.query(
        'UPDATE maquinarias SET alerta_mantencion_enviada = $1, horometro_ultima_mantencion = $2, estado = $4, estado_origen = $5 WHERE id = $3',
        [datos.maquinariaOriginal.alerta_mantencion_enviada, datos.maquinariaOriginal.horometro_ultima_mantencion, datos.maquinariaId,
         datos.maquinariaOriginal.estado, datos.maquinariaOriginal.estado_origen]
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

// Claves EXACTAS de cada OT de GET /api/ordenes-trabajo/mias (lista blanca, derivada del SELECT de
// routes/ordenes.js): toda columna nueva que se agregue ahi debe decidirse aqui a proposito. Son las
// mismas siempre (abierta o finalizada, con o sin vehiculo o cobro; lo ausente va en null).
const CLAVES_OT_PORTAL = [
    'id', 'estado', 'motivo', 'diagnostico', 'fecha_creacion', 'fecha_cierre',
    'aceptada_at', 'en_camino_at', 'llegada_at', 'asignada_at',
    'maquinaria_codigo', 'maquinaria_tipo', 'factura_id', 'factura_folio', 'factura_url', 'comprobante_url',
    'mecanico_nombre', 'vehiculo_patente', 'vehiculo_marca', 'vehiculo_modelo',
    'eta_llegada_at', 'eta_calculada_at', 'eta_aproximada', 'cobro',
].sort();
const afirmarClavesPortal = (o) => assert.deepEqual(Object.keys(o).sort(), CLAVES_OT_PORTAL, 'el portal solo debe exponer la lista blanca de claves');

const MOTIVO_VALIDO = { motivo_codigo: 'error_registro', motivo: 'Se registró mal el repuesto en el talonario' };

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
        // cerrada la OT, el panel anula solo con motivo
        assert.equal((await pedir('POST', ruta, 'administrativo')).status, 400);
        assert.equal((await pedir('POST', ruta, 'administrativo', MOTIVO_VALIDO)).status, 200);
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

// Cliente de la orden y costos por equipo

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

describe('ficha del cliente', () => {
    test('edita correo y telefono sin tocar la cuenta de portal, y valida lo que llega', async (t) => {
        if (!requiereBase(t)) return;
        const nombre = `Ficha ${crypto.randomUUID().slice(0, 6)}`;
        const id = (await pool.query("INSERT INTO clientes (nombre) VALUES ($1) RETURNING id", [nombre])).rows[0].id;
        const cuenta = (await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, cliente_id)
             VALUES ('Cuenta ficha', $1, 'x', 'cliente', $2) RETURNING id, email`,
            [`ficha-${crypto.randomUUID().slice(0, 6)}@portal.test`, id]
        )).rows[0];
        const ok = await pedir('PATCH', `/api/clientes/${id}`, 'administrativo', { email: ' Contacto@Empresa.CL ', telefono: '+56 9 1111 2222' });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.email, 'contacto@empresa.cl');
        assert.equal(ok.body.telefono, '+56 9 1111 2222');
        assert.equal(ok.body.nombre, nombre, 'lo que no viene no cambia');
        const despues = (await pool.query('SELECT email FROM usuarios WHERE id = $1', [cuenta.id])).rows[0];
        assert.equal(despues.email, cuenta.email, 'el correo de inicio de sesion no cambia');
        // vaciar el correo lo deja en null
        const vacio = await pedir('PATCH', `/api/clientes/${id}`, 'administrativo', { email: '' });
        assert.equal(vacio.status, 200);
        assert.equal(vacio.body.email, null);
        // invalidos
        for (const cuerpo of [{ email: 'no-es-correo' }, { nombre: '' }, { rut: '1-1' }, {}]) {
            assert.equal((await pedir('PATCH', `/api/clientes/${id}`, 'administrativo', cuerpo)).status, 400, JSON.stringify(cuerpo));
        }
        assert.equal((await pedir('PATCH', '/api/clientes/999999999', 'administrativo', { telefono: '1' })).status, 404);
        assert.equal((await pedir('PATCH', `/api/clientes/${id}`, 'mecanico', { telefono: '1' })).status, 403);
        assert.equal((await pedir('PATCH', `/api/clientes/${id}`, 'cliente', { telefono: '1' })).status, 403);
        // el listado indica si el cliente tiene cuenta de portal
        const lista = await pedir('GET', '/api/clientes', 'administrativo');
        assert.equal(lista.body.find((c) => c.id === id).tiene_cuenta, true);
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
        // hora de Santiago de hace `dias` dias, sin depender de la zona del proceso (el CI corre en UTC)
        const { diaSantiago, horaSantiago, sumarDias } = require('../src/utils/diasArriendo');
        const hace = (dias, hora) => {
            const dia = sumarDias(diaSantiago(new Date()), -dias);
            for (const offset of ['-03:00', '-04:00']) {
                const d = new Date(`${dia}T${String(hora).padStart(2, '0')}:00:00${offset}`);
                if (horaSantiago(d) === hora && diaSantiago(d) === dia) return d;
            }
            throw new Error(`hora no representable en Santiago: ${dia} ${hora}`);
        };
        const guia = (tipo, fecha, fallido = false) =>
            pool.query(
                `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, fallido, cliente_id) VALUES ($1, $2, 'x', $3, $4, $5)`,
                [equipo.id, tipo, fecha, fallido, clienteId]
            );
        await guia('despacho', hace(40, 9));
        await guia('recepcion', hace(35, 14));
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

    test('el traslado cobrado en una factura no cuenta como ingreso del equipo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await equipoConMovimiento();
        // factura de 100.000 con 20.000 de traslado: suma 80.000 de arriendo, mas los 10.000 de la otra factura
        await pool.query(
            `INSERT INTO facturas (folio, archivo_url, monto, monto_traslado, maquinaria_id) VALUES ('T-TRASLADO', 'x', 100000, 20000, $1)`,
            [equipo.id]
        );
        const { items } = await buscar(equipo);
        assert.equal(items[0].ingreso, 90000);
        // la base no admite un traslado mayor que el monto
        await assert.rejects(
            pool.query(`INSERT INTO facturas (folio, archivo_url, monto, monto_traslado, maquinaria_id) VALUES ('T-TRASLADO-MAL', 'x', 1000, 2000, $1)`, [equipo.id]),
            /facturas_monto_traslado_chk/
        );
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

// Historial de la orden (ordenes_eventos, migracion 020)

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
            // un cliente que no existe rompe el INSERT (clave foranea) despues de empezar la transaccion
            maquinaria_id: datos.maquinariaId, cliente_id: 99999999, motivo: marcador,
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

// Cambios de lo facturable con motivo, bloqueo por factura y eventos en el historial

/** Eventos de la OT de un tipo, en el orden en que se escribieron (id). */
async function eventosTipo(ot, tipo) {
    const r = await pool.query(
        'SELECT * FROM ordenes_eventos WHERE orden_trabajo_id = $1 AND tipo = $2 ORDER BY id', [ot, tipo]);
    return r.rows;
}

async function contarEventos(ot) {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM ordenes_eventos WHERE orden_trabajo_id = $1', [ot]);
    return r.rows[0].n;
}

/** Cierra la OT y, si se pide, la deja valorizada (como si el gerente ya la hubiera aprobado). */
async function cerrarOt(ot, valorizacion = null) {
    const gerente = await pool.query("SELECT id FROM usuarios WHERE email = 'admin@gomaq.test'");
    await pool.query(
        `UPDATE ordenes_trabajo SET estado = 'finalizada', valorizacion = $2,
                valorizacion_aprobada_por = CASE WHEN $2::numeric IS NULL THEN NULL ELSE $3::int END
         WHERE id = $1`,
        [ot, valorizacion, gerente.rows[0].id]
    );
}

/** Factura insertada directo, para probar el bloqueo sin pasar por la subida del PDF. */
async function facturarDirecto(ot, folio = 'F-1001') {
    await pool.query(
        "INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, monto) VALUES ($1, $2, 'facturas/prueba.pdf', 100000)",
        [ot, folio]
    );
}

async function agregarLinea(ot, cuerpo, rol = 'administrativo') {
    const r = await pedir('POST', `/api/insumos/orden/${ot}`, rol, { cantidad: 1, descripcion: 'Repuesto de prueba', ...cuerpo });
    assert.ok(r.status === 201 || r.status === 200, `no se pudo agregar la linea: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
}

const rutaLinea = (ot, linea) => `/api/insumos/orden/${ot}/linea/${linea}`;

/** Sube una factura por la ruta real; el almacenamiento esta reemplazado por un doble. */
async function subirFactura(ot, rol, campos) {
    const form = new FormData();
    for (const [k, v] of Object.entries(campos)) form.append(k, v);
    form.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'factura.pdf');
    const r = await fetch(`${base}/api/ordenes-trabajo/${ot}/factura`, {
        method: 'POST', headers: { Authorization: `Bearer ${tokens[rol]}` }, body: form,
    });
    return leerRespuesta(r);
}

/** OT cerrada y valorizada con dos lineas que se cobran (A y B), una que no (C) y una por decidir (D). */
async function otValorizada() {
    const ot = await crearOt();
    const a = await agregarLinea(ot, { descripcion: 'A cobrable', cantidad: 2, precio_unitario: 1000, facturable: 'si' });
    const b = await agregarLinea(ot, { descripcion: 'B cobrable', cantidad: 1, precio_unitario: 5000, facturable: 'si' });
    const c = await agregarLinea(ot, { descripcion: 'C no se cobra', cantidad: 1, precio_unitario: 800, facturable: 'no' });
    const d = await agregarLinea(ot, { descripcion: 'D por decidir', cantidad: 1, facturable: 'pendiente' });
    await cerrarOt(ot, 7000);
    return { ot, a: a.id, b: b.id, c: c.id, d: d.id };
}

async function estadoValorizacion(ot) {
    const r = await pool.query('SELECT valorizacion, valorizacion_aprobada_por, facturable FROM ordenes_trabajo WHERE id = $1', [ot]);
    return r.rows[0];
}

/**
 * Espera a que haya al menos `n` consultas bloqueadas esperando un Lock sobre la OT (SELECT ... FOR
 * UPDATE) o sobre un indice unico de eventos (INSERT INTO ordenes_eventos). Es la forma de saber que
 * una peticion ya esta esperando, sin depender de un tiempo fijo.
 */
async function esperarBloqueos(n, patron = '%FOR %UPDATE%') {
    const limite = Date.now() + 10000;
    for (;;) {
        const r = await pool.query(
            `SELECT COUNT(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`, [patron]);
        if (r.rows[0].n >= n) return;
        assert.ok(Date.now() < limite, `no llegaron a esperar ${n} bloqueo(s)`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function pendientesDeValorizar() {
    const r = await pedir('GET', '/api/facturacion/pendientes', 'gerente');
    assert.equal(r.status, 200);
    return r.body.reparaciones_pendientes_valorizar.map((o) => o.id);
}

describe('cambios de lo facturable: motivo', () => {
    test('OT cerrada: modificar sin motivo, con codigo invalido o con texto corto da 400 y no cambia nada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        await cerrarOt(ot);
        const antes = await contarEventos(ot);

        const intentos = [
            {},
            { motivo_codigo: 'garantia' },
            { motivo: 'Cliente de hace años, no se cobra' },
            { motivo_codigo: 'porque_si', motivo: 'Cliente de hace años, no se cobra' },
            { motivo_codigo: 'otro', motivo: '          ' },
            { motivo_codigo: 'otro', motivo: 'corto' },
            { motivo_codigo: 'otro', motivo: 'a b c d e f g h i' },
        ];
        for (const motivo of intentos) {
            const r = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si', ...motivo });
            assert.equal(r.status, 400, JSON.stringify(motivo));
            assert.ok(r.body.error);
        }
        const fila = await pool.query('SELECT facturable FROM movimientos_insumo WHERE id = $1', [linea.id]);
        assert.equal(fila.rows[0].facturable, 'pendiente', 'la linea no cambio');
        assert.equal(await contarEventos(ot), antes, 'un cambio rechazado no deja evento');
    });

    test('OT cerrada con motivo valido: se aplica y el evento guarda antes, despues y motivo', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { descripcion: 'Filtro', precio_unitario: 1000 });
        await cerrarOt(ot);

        const r = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', {
            facturable: 'si', motivo_codigo: 'garantia', motivo: '  Se cobra por garantía vencida  ',
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.facturable, 'si');
        assert.equal(r.body.orden_facturable, true);

        const eventos = await eventosTipo(ot, 'linea_modificada');
        assert.equal(eventos.length, 1);
        const e = eventos[0];
        assert.equal(e.origen, 'panel');
        assert.equal(e.rol, 'administrativo');
        assert.ok(e.usuario_id);
        assert.equal(e.aplicado, true);
        assert.deepEqual(e.detalle, {
            linea_id: linea.id, insumo: 'Filtro', campo: 'facturable', antes: 'pendiente', despues: 'si',
            motivo_codigo: 'garantia', motivo: 'Se cobra por garantía vencida', orden_cerrada: true,
        });
    });

    test('OT abierta: el motivo es opcional pero el cambio se registra igual', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });

        const sinMotivo = await pedir('PATCH', rutaLinea(ot, linea.id), 'gerente', { facturable: 'si' });
        assert.equal(sinMotivo.status, 200);
        const conMotivo = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', {
            facturable: 'no', motivo_codigo: 'cortesia_comercial',
        });
        assert.equal(conMotivo.status, 200);

        const eventos = await eventosTipo(ot, 'linea_modificada');
        assert.equal(eventos.length, 2);
        assert.equal(eventos[0].rol, 'gerente');
        assert.equal(eventos[0].detalle.orden_cerrada, false);
        assert.equal(eventos[0].detalle.motivo, null);
        assert.equal(eventos[0].detalle.motivo_codigo, null);
        assert.equal(eventos[1].detalle.motivo_codigo, 'cortesia_comercial');
        assert.equal(eventos[1].detalle.antes, 'si');
        assert.equal(eventos[1].detalle.despues, 'no');
    });

    test('un codigo invalido tambien se rechaza con la OT abierta', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, {});
        const r = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si', motivo_codigo: 'inventado' });
        assert.equal(r.status, 400);
    });

    test('el precio debe ser un entero en pesos mayor o igual a 0: si no, 400 sin tocar nada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const antes = await contarEventos(ot);
        for (const precio of [1500.5, '1500.5', -1, 'abc']) {
            const agregar = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { descripcion: 'X', cantidad: 1, precio_unitario: precio });
            assert.equal(agregar.status, 400, `agregar ${precio}`);
            assert.match(agregar.body.error, /entero en pesos/);
            const modificar = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { precio_unitario: precio });
            assert.equal(modificar.status, 400, `modificar ${precio}`);
        }
        assert.equal(await contarEventos(ot), antes);
        // cero y texto numerico entero si valen
        assert.equal((await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { precio_unitario: '0' })).status, 200);
        const evento = (await eventosTipo(ot, 'linea_modificada')).pop();
        assert.equal(evento.detalle.despues, 0, 'despues sale de la fila guardada, como numero');
    });

    test('varios campos en un mismo PATCH dejan un evento por campo', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const r = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', {
            facturable: 'si', precio_unitario: 1500, descripcion: 'Descripción corregida',
        });
        assert.equal(r.status, 200);
        const eventos = await eventosTipo(ot, 'linea_modificada');
        assert.deepEqual(eventos.map((e) => e.detalle.campo).sort(), ['descripcion', 'facturable', 'precio_unitario']);
        const precio = eventos.find((e) => e.detalle.campo === 'precio_unitario');
        assert.equal(precio.detalle.antes, 1000);
        assert.equal(precio.detalle.despues, 1500);
    });

    test('agregar una linea a una OT cerrada: el administrativo necesita motivo y se descuenta de la bodega', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await cerrarOt(ot);
        const insumo = await crearInsumoConStock(10);

        const sin = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { insumo_id: insumo, cantidad: 2, facturable: 'si' });
        assert.equal(sin.status, 400);
        assert.equal(await stockBodega(insumo), 10, 'un rechazo no mueve stock');
        assert.equal((await eventosTipo(ot, 'linea_agregada')).length, 0);

        const con = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', {
            insumo_id: insumo, cantidad: 2, facturable: 'si', precio_unitario: 3000, ...MOTIVO_VALIDO,
        });
        assert.equal(con.status, 201);
        assert.equal(con.body.orden_facturable, true);
        assert.equal(await stockBodega(insumo), 8);
        const eventos = await eventosTipo(ot, 'linea_agregada');
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].detalle.linea_id, con.body.id);
        assert.equal(eventos[0].detalle.orden_cerrada, true);
        assert.equal(eventos[0].detalle.motivo_codigo, 'error_registro');
        assert.deepEqual(eventos[0].detalle.despues, { cantidad: 2, precio_unitario: 3000, facturable: 'si' });
        assert.equal(eventos[0].origen, 'panel');
    });

    test('anular una linea de una OT cerrada: necesita motivo y deja el evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const insumo = await crearInsumoConStock(10);
        const linea = await agregarLinea(ot, { insumo_id: insumo, cantidad: 3, facturable: 'si' });
        await cerrarOt(ot);

        const sin = await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'gerente');
        assert.equal(sin.status, 400);
        assert.equal(await stockBodega(insumo), 7, 'el rechazo no devuelve stock');

        const con = await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'gerente', {
            motivo_codigo: 'cliente_antiguo', motivo: 'Cliente antiguo, se decidió no cobrar',
        });
        assert.equal(con.status, 200);
        assert.ok(con.body.anulada_at);
        assert.equal(await stockBodega(insumo), 10);
        const eventos = await eventosTipo(ot, 'linea_anulada');
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].rol, 'gerente');
        assert.equal(eventos[0].detalle.linea_id, linea.id);
        assert.equal(eventos[0].detalle.orden_cerrada, true);
        assert.equal(eventos[0].detalle.motivo_codigo, 'cliente_antiguo');

        // anular de nuevo responde 200 sin evento ni motivo: es el reintento de siempre
        const otra = await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'gerente');
        assert.equal(otra.status, 200);
        assert.equal((await eventosTipo(ot, 'linea_anulada')).length, 1);
    });
});

describe('cambios de lo facturable: el mecanico conserva su comportamiento', () => {
    test('agrega a una OT abierta sin motivo y queda el evento con origen terreno', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const uuid = crypto.randomUUID();
        const r = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', {
            descripcion: 'Correa', cantidad: 1, facturable: 'pendiente', uuid_cliente: uuid,
        });
        assert.equal(r.status, 201);
        const eventos = await eventosTipo(ot, 'linea_agregada');
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].origen, 'terreno');
        assert.equal(eventos[0].rol, 'mecanico');
        assert.equal(eventos[0].uuid_cliente, uuid);
        assert.equal(eventos[0].detalle.orden_cerrada, false);
        assert.equal(eventos[0].detalle.insumo, 'Correa');
    });

    test('anula una linea suya en OT abierta sin motivo', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, {}, 'mecanico');
        const r = await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'mecanico', {});
        assert.equal(r.status, 200);
        const eventos = await eventosTipo(ot, 'linea_anulada');
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].origen, 'terreno');
    });

    test('no toca una OT cerrada (409, mismos mensajes) ni una ajena (403)', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, {}, 'mecanico');
        await cerrarOt(ot);
        const agregar = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'X', cantidad: 1 });
        assert.equal(agregar.status, 409);
        assert.equal(agregar.body.error, 'La orden ya está cerrada y no se puede modificar');
        const anular = await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'mecanico');
        assert.equal(anular.status, 409);
        assert.equal(anular.body.error, 'La orden ya está cerrada: pide al administrativo que anule la línea');
        const ajena = await crearOt('en_terreno', datos.mecanicoDosId);
        assert.equal((await pedir('POST', `/api/insumos/orden/${ajena}`, 'mecanico', { descripcion: 'X', cantidad: 1 })).status, 403);
        assert.equal((await pedir('PATCH', rutaLinea(ot, linea.id), 'mecanico', { facturable: 'si' })).status, 403);
        assert.equal((await eventosTipo(ot, 'linea_agregada')).length, 1, 'los rechazos no dejan eventos');
    });
});

describe('cambios de lo facturable: OT ya facturada', () => {
    test('los tres caminos responden 409 con el folio y la nota de credito, sin tocar nada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const insumo = await crearInsumoConStock(10);
        const linea = await agregarLinea(ot, { insumo_id: insumo, cantidad: 1, facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 5000);
        await facturarDirecto(ot, 'F-777');
        const eventosAntes = await contarEventos(ot);
        const stockAntes = await stockBodega(insumo);

        const agregar = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', {
            insumo_id: insumo, cantidad: 2, facturable: 'si', ...MOTIVO_VALIDO,
        });
        const anular = await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'administrativo', MOTIVO_VALIDO);
        const modificar = await pedir('PATCH', rutaLinea(ot, linea.id), 'gerente', { facturable: 'no', ...MOTIVO_VALIDO });
        for (const r of [agregar, anular, modificar]) {
            assert.equal(r.status, 409);
            assert.match(r.body.error, /factura folio F-777/);
            assert.match(r.body.error, /nota de crédito en el SII/);
        }
        assert.equal(await contarEventos(ot), eventosAntes);
        assert.equal(await stockBodega(insumo), stockAntes);
        const fila = await pool.query('SELECT facturable, anulada_at FROM movimientos_insumo WHERE id = $1', [linea.id]);
        assert.equal(fila.rows[0].facturable, 'si');
        assert.equal(fila.rows[0].anulada_at, null);
        assert.equal((await estadoValorizacion(ot)).valorizacion, '5000.00', 'la valorizacion queda como estaba');
        const lineas = await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(lineas.rows.length, 1, 'no se agrego la linea');
    });

    test('el bloqueo vale tambien sin motivo y con el mecanico en una OT abierta', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, {}, 'mecanico');
        await facturarDirecto(ot, 'F-778');
        const sinMotivo = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si' });
        assert.equal(sinMotivo.status, 409, 'primero la factura, despues el motivo');
        assert.equal((await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'X', cantidad: 1 })).status, 409);
        assert.equal((await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'mecanico')).status, 409);
    });

    test('una OT sin factura no se bloquea por la factura de otra', async (t) => {
        if (!requiereBase(t)) return;
        const otFacturada = await crearOt();
        await facturarDirecto(otFacturada, 'F-779');
        const ot = await crearOt();
        const linea = await agregarLinea(ot, {});
        assert.equal((await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si' })).status, 200);
    });
});

describe('cambios de lo facturable: valorizacion', () => {
    test('agregar una linea facturable anula la valorizacion y la OT vuelve a los pendientes del gerente', async (t) => {
        if (!requiereBase(t)) return;
        const { ot } = await otValorizada();
        assert.ok(!(await pendientesDeValorizar()).includes(ot), 'valorizada: no esta pendiente');

        const r = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', {
            descripcion: 'Otra pieza', cantidad: 1, precio_unitario: 900, facturable: 'si', ...MOTIVO_VALIDO,
        });
        assert.equal(r.status, 201);
        const o = await estadoValorizacion(ot);
        assert.equal(o.valorizacion, null);
        assert.equal(o.valorizacion_aprobada_por, null);
        assert.equal(o.facturable, true);
        assert.ok((await pendientesDeValorizar()).includes(ot), 'vuelve a la lista del gerente');

        const eventos = await eventosTipo(ot, 'valorizacion');
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].detalle.anulada, true);
        assert.equal(eventos[0].detalle.valorizacion_anterior, 7000);
        assert.equal(eventos[0].detalle.valorizacion_nueva, null);
        assert.equal(eventos[0].detalle.evento_causa, 'linea_agregada');
        assert.equal(eventos[0].detalle.motivo_codigo, 'error_registro');
        assert.match(eventos[0].detalle.causa, /líneas facturables/);
        assert.equal(eventos[0].origen, 'panel');
        assert.equal(eventos[0].rol, 'administrativo');
        // el evento de la valorizacion va despues del de la linea
        const linea = await eventosTipo(ot, 'linea_agregada');
        assert.ok(Number(linea[linea.length - 1].id) < Number(eventos[0].id));

        // el gerente la vuelve a aprobar
        const nueva = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 8000 });
        assert.equal(nueva.status, 200);
        assert.equal((await eventosTipo(ot, 'valorizacion')).length, 2);
    });

    test('una linea que deja de ser facturable anula la valorizacion', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, b } = await otValorizada();
        const r = await pedir('PATCH', rutaLinea(ot, b), 'administrativo', { facturable: 'no', ...MOTIVO_VALIDO });
        assert.equal(r.status, 200);
        const o = await estadoValorizacion(ot);
        assert.equal(o.valorizacion, null);
        assert.equal(o.facturable, true, 'queda la linea A');
        assert.ok((await pendientesDeValorizar()).includes(ot));
        assert.equal((await eventosTipo(ot, 'valorizacion'))[0].detalle.evento_causa, 'linea_modificada');
    });

    test('una linea por decidir que pasa a facturable anula la valorizacion', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, d } = await otValorizada();
        await pedir('PATCH', rutaLinea(ot, d), 'gerente', { facturable: 'si', precio_unitario: 400, ...MOTIVO_VALIDO });
        assert.equal((await estadoValorizacion(ot)).valorizacion, null);
    });

    test('anular una linea facturable anula la valorizacion', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, a } = await otValorizada();
        const r = await pedir('POST', `${rutaLinea(ot, a)}/anular`, 'administrativo', MOTIVO_VALIDO);
        assert.equal(r.status, 200);
        const o = await estadoValorizacion(ot);
        assert.equal(o.valorizacion, null);
        assert.ok((await pendientesDeValorizar()).includes(ot));
        assert.equal((await eventosTipo(ot, 'valorizacion'))[0].detalle.evento_causa, 'linea_anulada');
    });

    test('cambiar el precio de una linea facturable anula la valorizacion', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, a } = await otValorizada();
        await pedir('PATCH', rutaLinea(ot, a), 'administrativo', { precio_unitario: 1200, ...MOTIVO_VALIDO });
        assert.equal((await estadoValorizacion(ot)).valorizacion, null);
    });

    test('lo que no toca las lineas facturables deja la valorizacion como estaba', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, a, c, d } = await otValorizada();
        const eventosAntes = (await eventosTipo(ot, 'valorizacion')).length;

        // agregar una linea no facturable y una por decidir
        assert.equal((await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', {
            descripcion: 'No se cobra', cantidad: 1, facturable: 'no', precio_unitario: 100, ...MOTIVO_VALIDO,
        })).status, 201);
        assert.equal((await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', {
            descripcion: 'Por decidir', cantidad: 1, ...MOTIVO_VALIDO,
        })).status, 201);
        // cambiar el precio o la descripcion de una no facturable, y pasar de por decidir a no
        assert.equal((await pedir('PATCH', rutaLinea(ot, c), 'administrativo', { precio_unitario: 999, ...MOTIVO_VALIDO })).status, 200);
        assert.equal((await pedir('PATCH', rutaLinea(ot, d), 'administrativo', { facturable: 'no', ...MOTIVO_VALIDO })).status, 200);
        // cambiar solo la descripcion de una facturable
        assert.equal((await pedir('PATCH', rutaLinea(ot, a), 'administrativo', { descripcion: 'A con otro nombre', ...MOTIVO_VALIDO })).status, 200);
        // anular una no facturable
        assert.equal((await pedir('POST', `${rutaLinea(ot, c)}/anular`, 'administrativo', MOTIVO_VALIDO)).status, 200);

        const o = await estadoValorizacion(ot);
        assert.equal(o.valorizacion, '7000.00');
        assert.ok(o.valorizacion_aprobada_por);
        assert.equal((await eventosTipo(ot, 'valorizacion')).length, eventosAntes, 'ningun evento de valorizacion');
        assert.ok(!(await pendientesDeValorizar()).includes(ot));
    });

    test('una OT sin valorizar no deja evento de valorizacion al cambiar lineas', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 100 });
        await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'no' });
        assert.equal((await eventosTipo(ot, 'valorizacion')).length, 0);
    });

    test('el mecanico que agrega una linea facturable a una OT abierta valorizada tambien la anula', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await pool.query('UPDATE ordenes_trabajo SET valorizacion = 1000 WHERE id = $1', [ot]);
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 100 }, 'mecanico');
        assert.equal((await estadoValorizacion(ot)).valorizacion, null);
        const ev = await eventosTipo(ot, 'valorizacion');
        assert.equal(ev[0].origen, 'terreno');
    });
});

describe('cambios de lo facturable: idempotencia', () => {
    test('la misma Idempotency-Key dos veces deja un solo evento y responde 200 sin repetir', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const llave = crypto.randomUUID();

        const primera = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si' }, { 'Idempotency-Key': llave });
        assert.equal(primera.status, 200);
        assert.equal(primera.body.ya_registrada, undefined);
        // otro cambio posterior, con otra llave
        const otra = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'no' }, { 'Idempotency-Key': crypto.randomUUID() });
        assert.equal(otra.status, 200);

        // el reintento de la primera respuesta perdida: no vuelve a poner 'si'
        const reintento = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si' }, { 'Idempotency-Key': llave });
        assert.equal(reintento.status, 200);
        assert.equal(reintento.body.ya_registrada, true);
        assert.equal(reintento.body.facturable, 'no', 'responde el estado actual, no repite el cambio');
        const eventos = await eventosTipo(ot, 'linea_modificada');
        assert.equal(eventos.length, 2);
        assert.equal(eventos[0].uuid_cliente, llave);
    });

    test('reintentos simultaneos con la misma llave dejan un solo evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const llave = crypto.randomUUID();
        const respuestas = await Promise.all([1, 2, 3, 4].map(() =>
            pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si' }, { 'Idempotency-Key': llave })));
        assert.ok(respuestas.every((r) => r.status === 200), JSON.stringify(respuestas.map((r) => r.status)));
        assert.equal((await eventosTipo(ot, 'linea_modificada')).length, 1);
    });

    test('una llave malformada da 400 y una usada en otra linea da 409', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const uno = await agregarLinea(ot, {});
        const dos = await agregarLinea(ot, {});
        const mala = await pedir('PATCH', rutaLinea(ot, uno.id), 'administrativo', { facturable: 'si' }, { 'Idempotency-Key': 'no-es-uuid' });
        assert.equal(mala.status, 400);
        const llave = crypto.randomUUID();
        assert.equal((await pedir('PATCH', rutaLinea(ot, uno.id), 'administrativo', { facturable: 'si' }, { 'Idempotency-Key': llave })).status, 200);
        const otraLinea = await pedir('PATCH', rutaLinea(ot, dos.id), 'administrativo', { facturable: 'si' }, { 'Idempotency-Key': llave });
        assert.equal(otraLinea.status, 409);
        const fila = await pool.query('SELECT facturable FROM movimientos_insumo WHERE id = $1', [dos.id]);
        assert.equal(fila.rows[0].facturable, 'pendiente');
    });

    test('con varios campos la llave queda en un solo evento y el reintento no repite ninguno', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const llave = crypto.randomUUID();
        const cuerpo = { facturable: 'si', precio_unitario: 2000 };
        assert.equal((await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', cuerpo, { 'Idempotency-Key': llave })).status, 200);
        const otra = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', cuerpo, { 'Idempotency-Key': llave });
        assert.equal(otra.status, 200);
        assert.equal(otra.body.ya_registrada, true);
        assert.equal((await eventosTipo(ot, 'linea_modificada')).length, 2);
    });

    test('el reintento de la tarea de la cola de terreno no duplica la linea ni el evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const uuid = crypto.randomUUID();
        const cuerpo = { descripcion: 'Correa', cantidad: 1, facturable: 'pendiente', uuid_cliente: uuid };
        const primera = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', cuerpo);
        const segunda = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        assert.equal(segunda.body.id, primera.body.id);
        assert.equal((await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot])).rows.length, 1);
        assert.equal((await eventosTipo(ot, 'linea_agregada')).length, 1);
    });

    test('reintentos simultaneos de la cola dejan una linea y un evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const cuerpo = { descripcion: 'Correa', cantidad: 1, uuid_cliente: crypto.randomUUID() };
        const respuestas = await Promise.all([1, 2, 3, 4].map(() => pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', cuerpo)));
        assert.ok(respuestas.every((r) => r.status === 200 || r.status === 201));
        assert.equal(respuestas.filter((r) => r.status === 201).length, 1);
        assert.equal((await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot])).rows.length, 1);
        assert.equal((await eventosTipo(ot, 'linea_agregada')).length, 1);
    });

    test('un cambio sin efecto no escribe evento ni toca la linea', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000, descripcion: 'Filtro' });
        const antes = await contarEventos(ot);
        for (const cuerpo of [{}, { facturable: 'si' }, { precio_unitario: 1000 }, { precio_unitario: '1000' }, { descripcion: 'Filtro' }, { precio_unitario: '' }]) {
            const r = await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', cuerpo);
            assert.equal(r.status, 200, JSON.stringify(cuerpo));
            assert.equal(r.body.id, linea.id);
            assert.equal(r.body.orden_facturable, true);
        }
        assert.equal(await contarEventos(ot), antes);
        // y con la OT cerrada tampoco pide motivo, porque no cambia nada
        await cerrarOt(ot);
        assert.equal((await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'si' })).status, 200);
    });
});

describe('cambios de lo facturable: bloqueo de la OT', () => {
    test('cambios simultaneos sobre lineas distintas de la misma OT no pierden ningun evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const lineas = [];
        for (let i = 0; i < 8; i++) lineas.push(await agregarLinea(ot, { precio_unitario: 100 + i }));
        const antes = await contarEventos(ot);

        const respuestas = await Promise.all(lineas.map((l, i) =>
            i % 2 === 0
                ? pedir('PATCH', rutaLinea(ot, l.id), 'administrativo', { facturable: 'si' })
                : pedir('POST', `${rutaLinea(ot, l.id)}/anular`, 'administrativo')));
        assert.ok(respuestas.every((r) => r.status === 200), JSON.stringify(respuestas.map((r) => r.status)));
        assert.equal(await contarEventos(ot), antes + 8, 'un evento por cambio');
        const orden = await pool.query('SELECT facturable FROM ordenes_trabajo WHERE id = $1', [ot]);
        assert.equal(orden.rows[0].facturable, true);
        const vigentes = await pool.query(
            "SELECT COUNT(*)::int AS n FROM movimientos_insumo WHERE orden_trabajo_id = $1 AND anulada_at IS NULL AND facturable = 'si'", [ot]);
        assert.equal(vigentes.rows[0].n, 4);
    });

    test('dos cambios simultaneos sobre la misma linea quedan encadenados por el id del evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const precios = [1100, 1200, 1300, 1400, 1500, 1600];
        const respuestas = await Promise.all(precios.map((p) =>
            pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { precio_unitario: p })));
        assert.ok(respuestas.every((r) => r.status === 200));
        const eventos = await eventosTipo(ot, 'linea_modificada');
        assert.equal(eventos.length, precios.length);
        // cada "antes" es el "despues" del evento anterior: el orden por id es el orden real
        let esperado = 1000;
        for (const e of eventos) {
            assert.equal(e.detalle.antes, esperado);
            esperado = e.detalle.despues;
        }
        const fila = await pool.query('SELECT precio_unitario FROM movimientos_insumo WHERE id = $1', [linea.id]);
        assert.equal(Number(fila.rows[0].precio_unitario), esperado, 'la linea queda con el ultimo valor del historial');
    });

    test('agregar, modificar y anular a la vez sobre la misma OT dan todos 2xx', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const uno = await agregarLinea(ot, { facturable: 'si', precio_unitario: 100 });
        const dos = await agregarLinea(ot, { facturable: 'si', precio_unitario: 100 });
        await pool.query('UPDATE ordenes_trabajo SET valorizacion = 500 WHERE id = $1', [ot]);
        const respuestas = await Promise.all([
            pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Nueva', cantidad: 1, facturable: 'si', precio_unitario: 5 }),
            pedir('PATCH', rutaLinea(ot, uno.id), 'gerente', { precio_unitario: 150 }),
            pedir('POST', `${rutaLinea(ot, dos.id)}/anular`, 'administrativo'),
        ]);
        assert.ok(respuestas.every((r) => r.status === 200 || r.status === 201), JSON.stringify(respuestas.map((r) => r.status)));
        assert.equal((await estadoValorizacion(ot)).valorizacion, null);
        assert.equal((await eventosTipo(ot, 'valorizacion')).length, 1, 'la valorizacion se anula una sola vez');
    });
});

describe('cambios de lo facturable: factura cargada', () => {
    test('subir la factura deja el evento con folio y monto, y una segunda da 409 sin evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);

        const r = await subirFactura(ot, 'administrativo', { folio: 'F-5001', monto: '119000' });
        assert.equal(r.status, 201);
        assert.equal(r.body.folio, 'F-5001');
        const eventos = await eventosTipo(ot, 'factura_cargada');
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].origen, 'panel');
        assert.equal(eventos[0].rol, 'administrativo');
        assert.ok(eventos[0].usuario_id);
        assert.deepEqual(eventos[0].detalle, { factura_id: r.body.id, folio: 'F-5001', monto: 119000 });
        assert.equal(datos.storage.subidos.some((ruta) => ruta.includes(`${ot}`)), true);

        const otra = await subirFactura(ot, 'administrativo', { folio: 'F-5002' });
        assert.equal(otra.status, 409);
        assert.equal(otra.body.error, 'Esta orden de trabajo ya tiene su factura');
        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 1);
        assert.ok(datos.storage.borrados.length > 0, 'el PDF de la segunda subida se borra');

        // y ahora la OT esta bloqueada para cambios de linea
        const linea = await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot]);
        const cambio = await pedir('PATCH', rutaLinea(ot, linea.rows[0].id), 'administrativo', { facturable: 'no', ...MOTIVO_VALIDO });
        assert.equal(cambio.status, 409);
        assert.match(cambio.body.error, /factura folio F-5001/);
    });

    test('sin monto el evento lo dice con null; folio y archivo siguen siendo obligatorios', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await cerrarOt(ot, 1000);
        const r = await subirFactura(ot, 'administrativo', { folio: 'F-5003' });
        assert.equal(r.status, 201);
        assert.equal((await eventosTipo(ot, 'factura_cargada'))[0].detalle.monto, null);
        const sinFolio = await subirFactura(await crearOt(), 'administrativo', {});
        assert.equal(sinFolio.status, 400);
        assert.equal(sinFolio.body.error, 'folio y archivo (PDF) son requeridos');
    });

    test('subir la factura a una OT abierta da 409 y el mecanico sigue agregando y anulando', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 }, 'mecanico');
        const borradosAntes = datos.storage.borrados.length;
        const r = await subirFactura(ot, 'administrativo', { folio: 'F-7001', monto: '1000' });
        assert.equal(r.status, 409);
        assert.match(r.body.error, /finalizada/);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows.length, 0);
        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 0);
        assert.equal(datos.storage.borrados.length, borradosAntes + 1, 'el PDF subido se borra');
        // la OT sigue sin factura: el mecanico puede seguir trabajando
        const otra = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Otra', cantidad: 1 });
        assert.equal(otra.status, 201);
        assert.equal((await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'mecanico', {})).status, 200);
    });

    test('subir la factura a una OT finalizada sin valorizacion es valido', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, null);
        assert.equal((await subirFactura(ot, 'administrativo', { folio: 'F-7002' })).status, 201);
        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 1);
    });

    test('el detalle de la OT dice si tiene factura y su folio', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const sin = await pedir('GET', `/api/ordenes-trabajo/${ot}`, 'administrativo');
        assert.equal(sin.status, 200);
        assert.equal(sin.body.factura_id, null);
        assert.equal(sin.body.factura_folio, null);
        assert.equal(sin.body.id, ot);
        await facturarDirecto(ot, 'F-4242');
        const con = await pedir('GET', `/api/ordenes-trabajo/${ot}`, 'gerente');
        assert.equal(con.body.factura_folio, 'F-4242');
        assert.ok(con.body.factura_id);
        // el mecanico dueño sigue viendo su orden, con los mismos campos de siempre
        const mec = await pedir('GET', `/api/ordenes-trabajo/${ot}`, 'mecanico');
        assert.equal(mec.status, 200);
        assert.ok(Array.isArray(mec.body.tramos) && Array.isArray(mec.body.servicio_ids));
    });

    test('solo el administrativo sube facturas', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        assert.equal((await subirFactura(ot, 'gerente', { folio: 'F-5004' })).status, 403);
        assert.equal((await subirFactura(ot, 'mecanico', { folio: 'F-5004' })).status, 403);
        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 0);
    });

    test('una OT que no existe da 404 y el PDF subido se borra', async (t) => {
        if (!requiereBase(t)) return;
        const maximo = await pool.query('SELECT COALESCE(MAX(id), 0) + 100000 AS id FROM ordenes_trabajo');
        const borradosAntes = datos.storage.borrados.length;
        const r = await subirFactura(maximo.rows[0].id, 'administrativo', { folio: 'F-5005' });
        assert.equal(r.status, 404);
        assert.equal(datos.storage.borrados.length, borradosAntes + 1);
    });

    test('una factura y un cambio de linea a la vez: la factura nunca queda sobre lineas distintas', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 5; vuelta++) {
            const ot = await crearOt();
            const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
            await cerrarOt(ot, 1000);
            const [cambio, factura] = await Promise.all([
                pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { precio_unitario: 2000, ...MOTIVO_VALIDO }),
                subirFactura(ot, 'administrativo', { folio: `F-60${vuelta}`, monto: '1000' }),
            ]);
            const eventoFactura = (await eventosTipo(ot, 'factura_cargada'))[0];
            const eventoCambio = (await eventosTipo(ot, 'linea_modificada'))[0];
            // la factura ya no exige valorizacion: o el cambio entra primero y la factura se sube
            // despues sobre las lineas ya cambiadas (que quedan congeladas), o la factura entra y el
            // cambio se bloquea. Nunca el cambio despues de la factura.
            if (cambio.status === 200) {
                assert.equal(factura.status, 201);
                assert.ok(eventoCambio && eventoFactura);
                assert.ok(Number(eventoCambio.id) < Number(eventoFactura.id), 'el cambio es anterior a la factura');
                const fila = await pool.query('SELECT precio_unitario FROM movimientos_insumo WHERE id = $1', [linea.id]);
                assert.equal(Number(fila.rows[0].precio_unitario), 2000);
            } else {
                assert.equal(cambio.status, 409);
                assert.equal(factura.status, 201);
                assert.equal(eventoCambio, undefined);
                const fila = await pool.query('SELECT precio_unitario FROM movimientos_insumo WHERE id = $1', [linea.id]);
                assert.equal(Number(fila.rows[0].precio_unitario), 1000, 'la linea sigue como se facturo');
                assert.ok(eventoFactura);
            }
        }
    });

    test('un cambio que esperaba el bloqueo de la OT ve la factura subida mientras tanto', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);

        // otra transaccion tiene la OT bloqueada, como la subida de una factura a medio camino
        const otra = await pool.connect();
        let cambio;
        try {
            await otra.query('BEGIN');
            await otra.query('SELECT id FROM ordenes_trabajo WHERE id = $1 FOR UPDATE', [ot]);
            cambio = pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { precio_unitario: 2000, ...MOTIVO_VALIDO });
            // se espera a que el PATCH este de verdad esperando el bloqueo (y no a un tiempo fijo)
            await esperarBloqueos(1);
            await otra.query(
                "INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, monto) VALUES ($1, 'F-ESPERA', 'facturas/prueba.pdf', 1000)", [ot]);
            await otra.query('COMMIT');
        } catch (err) {
            await otra.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            otra.release();
        }
        const r = await cambio;
        assert.equal(r.status, 409, 'la factura confirmada mientras esperaba tiene que bloquear el cambio');
        assert.match(r.body.error, /F-ESPERA/);
        const fila = await pool.query('SELECT precio_unitario FROM movimientos_insumo WHERE id = $1', [linea.id]);
        assert.equal(Number(fila.rows[0].precio_unitario), 1000);
        assert.equal((await eventosTipo(ot, 'linea_modificada')).length, 0);
    });

    test('la factura de un arriendo (sin OT) sigue sin pasar por el historial de ordenes', async (t) => {
        if (!requiereBase(t)) return;
        const antes = await pool.query('SELECT COUNT(*)::int AS n FROM ordenes_eventos WHERE tipo = $1', ['factura_cargada']);
        // la ruta de arriendo no toca ordenes_eventos: solo se comprueba que el contrato no cambio
        const r = await pedir('POST', '/api/facturacion/arriendo', 'administrativo', { folio: 'X' });
        assert.equal(r.status, 400);
        const despues = await pool.query('SELECT COUNT(*)::int AS n FROM ordenes_eventos WHERE tipo = $1', ['factura_cargada']);
        assert.equal(despues.rows[0].n, antes.rows[0].n);
    });
});

describe('cambios de lo facturable: respuestas que no cambian y limpieza', () => {
    test('los codigos y mensajes de siempre', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { precio_unitario: 1000 });
        const ruta = rutaLinea(ot, linea.id);

        const agregarSinCantidad = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { descripcion: 'X' });
        assert.deepEqual([agregarSinCantidad.status, agregarSinCantidad.body.error], [400, 'Indica una cantidad mayor a 0, con hasta 2 decimales']);
        const sinRepuesto = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { cantidad: 1 });
        assert.deepEqual([sinRepuesto.status, sinRepuesto.body.error], [400, 'Elige un repuesto del catálogo o escribe su descripción']);
        const malFact = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { cantidad: 1, descripcion: 'X', facturable: 'tal vez' });
        assert.equal(malFact.status, 400);
        const malUuid = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { cantidad: 1, descripcion: 'X', uuid_cliente: 'no' });
        assert.deepEqual([malUuid.status, malUuid.body.error], [400, 'uuid_cliente no es un UUID valido']);
        const sinInsumo = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { cantidad: 1, insumo_id: 2147483000 });
        assert.deepEqual([sinInsumo.status, sinInsumo.body.error], [404, 'Insumo no encontrado']);

        const patchMal = await pedir('PATCH', ruta, 'administrativo', { facturable: 'quizas' });
        assert.deepEqual([patchMal.status, patchMal.body.error], [400, 'facturable debe ser uno de: si, no, pendiente']);
        const patchNoExiste = await pedir('PATCH', rutaLinea(ot, 2147483000), 'administrativo', { facturable: 'si' });
        assert.deepEqual([patchNoExiste.status, patchNoExiste.body.error], [404, 'Línea no encontrada en esta orden de trabajo, o ya anulada']);
        const anularNoExiste = await pedir('POST', `${rutaLinea(ot, 2147483000)}/anular`, 'administrativo');
        assert.deepEqual([anularNoExiste.status, anularNoExiste.body.error], [404, 'Línea no encontrada en esta orden de trabajo']);
        const anularOtNoExiste = await pedir('POST', `${rutaLinea(2147483000, linea.id)}/anular`, 'administrativo');
        assert.deepEqual([anularOtNoExiste.status, anularOtNoExiste.body.error], [404, 'Orden de trabajo no encontrada']);
        const clienteNo = await pedir('PATCH', ruta, 'cliente', { facturable: 'si' });
        assert.equal(clienteNo.status, 403);

        // la respuesta del PATCH conserva la forma: la fila de la linea mas orden_facturable
        const ok = await pedir('PATCH', ruta, 'administrativo', { facturable: 'si' });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.id, linea.id);
        assert.equal(ok.body.facturable, 'si');
        assert.equal(ok.body.orden_facturable, true);
        assert.ok('precio_unitario' in ok.body && 'cantidad' in ok.body && 'anulada_at' in ok.body);

        // PATCH de una linea anulada: 404 como siempre
        await pedir('POST', `${ruta}/anular`, 'administrativo');
        const anulada = await pedir('PATCH', ruta, 'administrativo', { facturable: 'no' });
        assert.deepEqual([anulada.status, anulada.body.error], [404, 'Línea no encontrada en esta orden de trabajo, o ya anulada']);
    });

    test('la limpieza usa la via de purga: se borran la OT y todos sus eventos de linea y factura', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 100 });
        await pedir('PATCH', rutaLinea(ot, linea.id), 'administrativo', { facturable: 'no' });
        await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'administrativo');
        await cerrarOt(ot, 100);
        assert.equal((await subirFactura(ot, 'administrativo', { folio: 'F-9001' })).status, 201);
        for (const tipo of ['linea_agregada', 'linea_modificada', 'linea_anulada', 'factura_cargada']) {
            assert.equal((await eventosTipo(ot, tipo)).length, 1, tipo);
        }

        // sin la via de purga el historial no se puede borrar
        await assert.rejects(() => pool.query('DELETE FROM ordenes_eventos WHERE orden_trabajo_id = $1', [ot]), /solo insercion/);

        await pool.query('DELETE FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot]);
        await pool.query('DELETE FROM facturas WHERE orden_trabajo_id = $1', [ot]);
        await purgarOrdenes([ot]);
        datos.ordenes = datos.ordenes.filter((id) => id !== ot);
        assert.equal((await pool.query('SELECT 1 FROM ordenes_trabajo WHERE id = $1', [ot])).rows.length, 0);
        assert.equal(await contarEventos(ot), 0);
    });
});

describe('anular una factura subida por error', () => {
    const rutaAnular = (ot, factura) => `/api/ordenes-trabajo/${ot}/factura/${factura}/anular`;

    /** OT cerrada y valorizada con una linea que se cobra y su factura subida por la ruta real. */
    async function otFacturada(folio) {
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        const f = await subirFactura(ot, 'administrativo', { folio, monto: '1190' });
        assert.equal(f.status, 201);
        return { ot, linea: linea.id, factura: f.body.id };
    }

    async function listasParaFacturar() {
        const r = await pedir('GET', '/api/facturacion/pendientes', 'gerente');
        return r.body.reparaciones_listas.map((o) => o.id);
    }

    test('motivo faltante, corto o invalido da 400 y la factura sigue ahi', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturada('F-8001');
        for (const cuerpo of [{}, { motivo_codigo: 'error_registro' }, { motivo: 'Se subio la factura equivocada' },
            { motivo_codigo: 'error_registro', motivo: 'corto' }, { motivo_codigo: 'inventado', motivo: 'Se subio la factura equivocada' }]) {
            const r = await pedir('POST', rutaAnular(ot, factura), 'administrativo', cuerpo);
            assert.equal(r.status, 400, JSON.stringify(cuerpo));
        }
        const mala = await pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO, { 'Idempotency-Key': 'no-es-uuid' });
        assert.equal(mala.status, 400);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE id = $1', [factura])).rows.length, 1);
        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 1);
        assert.equal((await eventosTipo(ot, 'factura_anulada')).length, 0);
    });

    test('el mecanico y el cliente no pueden (403); una OT o factura que no existe da 404', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturada('F-8002');
        assert.equal((await pedir('POST', rutaAnular(ot, factura), 'mecanico', MOTIVO_VALIDO)).status, 403);
        assert.equal((await pedir('POST', rutaAnular(ot, factura), 'cliente', MOTIVO_VALIDO)).status, 403);
        const inexistente = await pedir('POST', rutaAnular(2147483000, factura), 'administrativo', MOTIVO_VALIDO);
        assert.deepEqual([inexistente.status, inexistente.body.error], [404, 'Orden de trabajo no encontrada']);
        const sinFactura = await pedir('POST', rutaAnular(ot, 2147483000), 'administrativo', MOTIVO_VALIDO);
        assert.deepEqual([sinFactura.status, sinFactura.body.error], [404, 'Factura no encontrada para esta orden de trabajo']);
        // la factura de otra OT tampoco se puede anular por esta
        const otra = await crearOt();
        assert.equal((await pedir('POST', rutaAnular(otra, factura), 'administrativo', MOTIVO_VALIDO)).status, 404);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE id = $1', [factura])).rows.length, 1);
    });

    test('anular borra la factura, deja el evento completo y levanta el bloqueo de la OT', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, linea, factura } = await otFacturada('F-8003');
        assert.ok(!(await listasParaFacturar()).includes(ot), 'facturada: no esta entre las listas para facturar');
        assert.equal((await pedir('PATCH', rutaLinea(ot, linea), 'administrativo', { precio_unitario: 2000, ...MOTIVO_VALIDO })).status, 409);
        const borradosAntes = datos.storage.borrados.length;

        const r = await pedir('POST', rutaAnular(ot, factura), 'gerente', {
            motivo_codigo: 'error_registro', motivo: '  Se subió la factura de otra orden  ',
        });
        assert.equal(r.status, 200);
        assert.equal(r.body.folio, 'F-8003');
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE id = $1', [factura])).rows.length, 0);
        assert.equal(datos.storage.borrados.length, borradosAntes, 'el PDF queda de respaldo en Supabase');

        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 1, 'la carga sigue en el historial');
        const eventos = await eventosTipo(ot, 'factura_anulada');
        assert.equal(eventos.length, 1);
        const e = eventos[0];
        assert.equal(e.origen, 'panel');
        assert.equal(e.rol, 'gerente');
        assert.ok(e.usuario_id);
        assert.equal(e.detalle.folio, 'F-8003');
        assert.equal(e.detalle.monto, 1190);
        assert.equal(e.detalle.factura_id, factura);
        assert.match(e.detalle.archivo_url, /^facturas\//);
        assert.equal(e.detalle.motivo_codigo, 'error_registro');
        assert.equal(e.detalle.motivo, 'Se subió la factura de otra orden');

        // las listas quedan coherentes: valorizada y sin factura, vuelve a estar lista para facturar
        assert.ok((await listasParaFacturar()).includes(ot));
        // y se puede subir una factura nueva
        assert.equal((await subirFactura(ot, 'administrativo', { folio: 'F-8004', monto: '1190' })).status, 201);
        assert.equal((await pool.query('SELECT folio FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows[0].folio, 'F-8004');
    });

    test('despues de anular se puede cambiar una linea otra vez', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, linea, factura } = await otFacturada('F-8005');
        assert.equal((await pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO)).status, 200);
        const r = await pedir('PATCH', rutaLinea(ot, linea), 'administrativo', { precio_unitario: 2000, ...MOTIVO_VALIDO });
        assert.equal(r.status, 200);
        const agregar = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { descripcion: 'Nueva', cantidad: 1, ...MOTIVO_VALIDO });
        assert.equal(agregar.status, 201);
        // cambiar el precio de una facturable anula la valorizacion, y la OT vuelve a pendientes de valorizar
        assert.equal((await estadoValorizacion(ot)).valorizacion, null);
        assert.ok((await pendientesDeValorizar()).includes(ot));
    });

    test('anular de nuevo da 404; con la misma Idempotency-Key da 200 sin repetir', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturada('F-8006');
        const llave = crypto.randomUUID();
        assert.equal((await pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO, { 'Idempotency-Key': llave })).status, 200);
        const otra = await pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO);
        assert.equal(otra.status, 404);
        const reintento = await pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO, { 'Idempotency-Key': llave });
        assert.equal(reintento.status, 200);
        assert.equal(reintento.body.ya_registrada, true);
        assert.equal((await eventosTipo(ot, 'factura_cargada')).length, 1);
        assert.equal((await eventosTipo(ot, 'factura_anulada')).length, 1);
        // la llave usada en otra factura es un error del cliente
        const dos = await otFacturada('F-8007');
        const ajena = await pedir('POST', rutaAnular(dos.ot, dos.factura), 'administrativo', MOTIVO_VALIDO, { 'Idempotency-Key': llave });
        assert.equal(ajena.status, 409);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE id = $1', [dos.factura])).rows.length, 1);
    });

    test('dos anulaciones simultaneas: una gana y la otra da 404, sin 500', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturada('F-8008');
        const rs = await Promise.all([1, 2, 3].map(() => pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO)));
        assert.deepEqual(rs.map((r) => r.status).sort(), [200, 404, 404]);
        assert.equal((await eventosTipo(ot, 'factura_anulada')).length, 1);
    });

    test('con la OT bloqueada, la anulacion y un cambio de linea esperan su turno: primero la anulacion, despues el cambio', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, linea, factura } = await otFacturada('F-8500');
        const otra = await pool.connect();
        let anulacion;
        let cambio;
        try {
            await otra.query('BEGIN');
            await otra.query('SELECT id FROM ordenes_trabajo WHERE id = $1 FOR UPDATE', [ot]);
            // la anulacion llega primero y queda esperando; despues llega el cambio
            anulacion = pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO);
            await esperarBloqueos(1);
            cambio = pedir('PATCH', rutaLinea(ot, linea), 'administrativo', { precio_unitario: 3000, ...MOTIVO_VALIDO });
            await esperarBloqueos(2);
            await otra.query('COMMIT');
        } catch (err) {
            await otra.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            otra.release();
        }
        const [a, c] = await Promise.all([anulacion, cambio]);
        assert.equal(a.status, 200);
        // el cambio esperaba detras de la anulacion: cuando le toca, la factura ya no esta
        assert.equal(c.status, 200, JSON.stringify(c.body));
        const anulada = (await eventosTipo(ot, 'factura_anulada'))[0];
        const modificado = (await eventosTipo(ot, 'linea_modificada'))[0];
        assert.ok(Number(modificado.id) > Number(anulada.id), 'el historial refleja el orden real');
    });

    test('con la OT bloqueada, un cambio que llega primero deja a la anulacion esperando y la factura se anula despues', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, linea, factura } = await otFacturada('F-8501');
        const otra = await pool.connect();
        let anulacion;
        let cambio;
        try {
            await otra.query('BEGIN');
            await otra.query('SELECT id FROM ordenes_trabajo WHERE id = $1 FOR UPDATE', [ot]);
            cambio = pedir('PATCH', rutaLinea(ot, linea), 'administrativo', { precio_unitario: 3000, ...MOTIVO_VALIDO });
            await esperarBloqueos(1);
            anulacion = pedir('POST', rutaAnular(ot, factura), 'administrativo', MOTIVO_VALIDO);
            await esperarBloqueos(2);
            await otra.query('COMMIT');
        } catch (err) {
            await otra.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            otra.release();
        }
        const [c, a] = await Promise.all([cambio, anulacion]);
        // el cambio va primero y la OT todavia esta facturada: se bloquea; la anulacion pasa
        assert.equal(c.status, 409);
        assert.match(c.body.error, /factura folio F-8501/);
        assert.equal(a.status, 200);
        assert.equal((await eventosTipo(ot, 'linea_modificada')).length, 0);
        assert.equal((await eventosTipo(ot, 'factura_anulada')).length, 1);
    });

    test('la misma Idempotency-Key en dos OT a la vez: la segunda se rechaza con 409 y su factura sigue', async (t) => {
        if (!requiereBase(t)) return;
        const uno = await otFacturada('F-8600');
        const dos = await otFacturada('F-8601');
        const llave = crypto.randomUUID();
        // otra transaccion toma la llave (evento sin confirmar): la anulacion de la OT dos no la ve en su
        // busqueda previa, y su INSERT espera el indice unico hasta que esa transaccion termine
        const otra = await pool.connect();
        let respuesta;
        try {
            await otra.query('BEGIN');
            await otra.query(
                "INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen, uuid_cliente) VALUES ($1, 'factura_anulada', now(), 'panel', $2)",
                [uno.ot, llave]);
            respuesta = pedir('POST', rutaAnular(dos.ot, dos.factura), 'administrativo', MOTIVO_VALIDO, { 'Idempotency-Key': llave });
            await esperarBloqueos(1, '%INSERT INTO ordenes_eventos%');
            await otra.query('COMMIT');
        } catch (err) {
            await otra.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            otra.release();
        }
        const r = await respuesta;
        assert.equal(r.status, 409);
        assert.match(r.body.error, /Idempotency-Key/);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE id = $1', [dos.factura])).rows.length, 1, 'no se borro nada');
        assert.equal((await eventosTipo(dos.ot, 'factura_anulada')).length, 0);
    });

    test('un id que no es entero positivo da 400, no 500', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, linea, factura } = await otFacturada('F-8700');
        for (const malo of ['abc', '0', '-1', '1.5', '99999999999']) {
            const anularOt = await pedir('POST', rutaAnular(malo, factura), 'administrativo', MOTIVO_VALIDO);
            assert.equal(anularOt.status, 400, `orden ${malo}`);
            const anularFactura = await pedir('POST', rutaAnular(ot, malo), 'administrativo', MOTIVO_VALIDO);
            assert.equal(anularFactura.status, 400, `factura ${malo}`);
            assert.equal((await subirFactura(malo, 'administrativo', { folio: 'X' })).status, 400, `subir ${malo}`);
            assert.equal((await pedir('POST', `/api/insumos/orden/${malo}`, 'administrativo', { descripcion: 'X', cantidad: 1 })).status, 400);
            assert.equal((await pedir('PATCH', rutaLinea(malo, linea), 'administrativo', { facturable: 'no' })).status, 400);
            assert.equal((await pedir('PATCH', rutaLinea(ot, malo), 'administrativo', { facturable: 'no' })).status, 400);
            assert.equal((await pedir('POST', `${rutaLinea(malo, linea)}/anular`, 'administrativo')).status, 400);
            assert.equal((await pedir('POST', `${rutaLinea(ot, malo)}/anular`, 'administrativo')).status, 400);
        }
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE id = $1', [factura])).rows.length, 1);
    });

    test('la fecha de emision queda en el evento tal como se guardo, sin correrse por la zona horaria', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await cerrarOt(ot, 1000);
        const f = await subirFactura(ot, 'administrativo', { folio: 'F-8800', monto: '1190', fecha_emision: '2026-11-02' });
        assert.equal(f.status, 201);
        assert.equal((await pedir('POST', rutaAnular(ot, f.body.id), 'administrativo', MOTIVO_VALIDO)).status, 200);
        const e = (await eventosTipo(ot, 'factura_anulada'))[0];
        assert.equal(e.detalle.fecha_emision, '2026-11-02');
        // sin fecha de emision queda en null
        const g = await subirFactura(ot, 'administrativo', { folio: 'F-8801' });
        assert.equal((await pedir('POST', rutaAnular(ot, g.body.id), 'administrativo', MOTIVO_VALIDO)).status, 200);
        assert.equal((await eventosTipo(ot, 'factura_anulada'))[1].detalle.fecha_emision, null);
    });
});

describe('migracion 021: tipo de evento factura_anulada', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const archivo = path.join(__dirname, '../../db/migrations/021_evento_factura_anulada.sql');

    test('el CHECK de ordenes_eventos admite el tipo nuevo y sigue rechazando los inventados', async (t) => {
        if (!requiereBase(t)) return;
        const def = await pool.query(
            `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
             WHERE c.conrelid = 'ordenes_eventos'::regclass AND c.contype = 'c' AND c.conname = 'ordenes_eventos_tipo_check'`);
        assert.equal(def.rows.length, 1);
        assert.match(def.rows[0].def, /factura_anulada/);
        for (const tipo of ['creacion', 'factura_cargada', 'linea_anulada']) assert.match(def.rows[0].def, new RegExp(tipo));

        const ot = await crearOt();
        await pool.query("INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen) VALUES ($1, 'factura_anulada', now(), 'panel')", [ot]);
        await assert.rejects(
            () => pool.query("INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen) VALUES ($1, 'inventado', now(), 'panel')", [ot]),
            /ordenes_eventos_tipo_check/);
    });

    test('correrla otra vez no rompe nada: mismo CHECK, triggers de solo insercion e indice unico intactos', async (t) => {
        if (!requiereBase(t)) return;
        const sql = fs.readFileSync(archivo, 'utf8');
        const estado = async () => ({
            check: (await pool.query(
                `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                 WHERE conrelid = 'ordenes_eventos'::regclass AND contype = 'c' ORDER BY conname`)).rows,
            triggers: (await pool.query(
                `SELECT tgname FROM pg_trigger WHERE tgrelid = 'ordenes_eventos'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows,
            indices: (await pool.query(
                `SELECT indexname FROM pg_indexes WHERE tablename = 'ordenes_eventos' ORDER BY indexname`)).rows,
            eventos: (await pool.query('SELECT COUNT(*)::int AS n FROM ordenes_eventos')).rows[0].n,
        });
        const antes = await estado();
        for (let i = 0; i < 2; i++) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK').catch(() => {});
                throw err;
            } finally {
                client.release();
            }
        }
        assert.deepEqual(await estado(), antes);
        assert.deepEqual(antes.check.map((c) => c.conname), ['ordenes_eventos_origen_check', 'ordenes_eventos_tipo_check']);
        assert.deepEqual(antes.triggers.map((x) => x.tgname), ['ordenes_eventos_sin_cambios', 'ordenes_eventos_sin_truncate']);
        assert.ok(antes.indices.some((x) => x.indexname === 'uq_ordenes_eventos_uuid_tipo'));
        // el candado de solo insercion sigue en pie
        const ot = await crearOt();
        await pool.query("INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen) VALUES ($1, 'toma', now(), 'panel')", [ot]);
        await assert.rejects(() => pool.query('DELETE FROM ordenes_eventos WHERE orden_trabajo_id = $1', [ot]), /solo insercion/);
    });
});

describe('bloque 2a: configuracion de cobro, inicio de cobro y arriendos en curso', () => {
    const { inicioCobroDia } = require('../src/utils/diasArriendo');
    const DEFAULTS_CONFIG = { dia_facturacion: 5, hora_corte_despacho: 13, corte_cierra_periodo: true };

    /** Deja la configuracion como esta en la migracion, sin rastro de quien la toco. */
    async function restaurarConfiguracion() {
        for (const [clave, valor] of Object.entries(DEFAULTS_CONFIG)) {
            await pool.query(
                `INSERT INTO configuracion (clave, valor) VALUES ($1, $2::jsonb)
                 ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_por = NULL`, [clave, JSON.stringify(valor)]);
        }
    }

    /** Despacho por la ruta real, sin documento, con la hora dada (ISO con offset). */
    async function despachar(equipoId, clienteId, fechaHora) {
        const formulario = new FormData();
        formulario.append('tipo', 'despacho');
        formulario.append('sin_documento', 'true');
        formulario.append('cliente_id', String(clienteId));
        if (fechaHora) formulario.append('fecha_hora', fechaHora);
        const r = await fetch(`${base}/api/maquinarias/${equipoId}/guias`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario,
        });
        return { status: r.status, body: await r.json() };
    }

    const inicioDe = async (guiaId) =>
        (await pool.query('SELECT inicio_cobro::text AS d FROM guias WHERE id = $1', [guiaId])).rows[0].d;

    test('la migracion deja la configuracion por defecto', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', '/api/facturacion/configuracion', 'administrativo');
        assert.equal(r.status, 200);
        assert.equal(r.body.dia_facturacion, 5);
        assert.equal(r.body.hora_corte_despacho, 13);
        assert.equal('incluir_dia_recepcion' in r.body, false, 'la opcion obsoleta ya no se devuelve');
    });

    test('permisos: administrativo ve y no edita, gerente edita, mecanico y cliente no entran', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'gerente')).status, 200);
        assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'administrativo', { dia_facturacion: 6 })).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'mecanico')).status, 403);
        assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'mecanico', { dia_facturacion: 6 })).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos-en-curso', 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos-en-curso', 'cliente')).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos-en-curso', 'administrativo')).status, 200);
        assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'administrativo')).body.dia_facturacion, 5);
    });

    test('un PUT invalido da 400 y no cambia nada', async (t) => {
        if (!requiereBase(t)) return;
        for (const cuerpo of [{ dia_facturacion: 29 }, { dia_facturacion: '5' }, { inventada: 1 }, {}, { hora_corte_despacho: 24 },
            { constructor: 1 }, { toString: true },
            { dia_facturacion: 7, hora_corte_despacho: 99 }]) {
            const r = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', cuerpo);
            assert.equal(r.status, 400, JSON.stringify(cuerpo));
        }
        // un cuerpo con `__proto__` propio (JSON.parse lo crea como clave normal) tambien se rechaza sin tumbar el servidor
        const proto = await fetch(`${base}/api/facturacion/configuracion`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.gerente}` },
            body: '{"__proto__":1}',
        });
        assert.equal(proto.status, 400);
        const r = await pedir('GET', '/api/facturacion/configuracion', 'gerente');
        assert.equal(r.body.dia_facturacion, 5, 'el PUT a medias no dejo nada guardado');
        assert.equal(r.body.hora_corte_despacho, 13);
    });

    test('el CHECK de la tabla rechaza valores fuera de rango aunque se salte la API', async (t) => {
        if (!requiereBase(t)) return;
        await assert.rejects(() => pool.query("UPDATE configuracion SET valor = '29' WHERE clave = 'dia_facturacion'"), /configuracion_valor_valido/);
        await assert.rejects(() => pool.query("UPDATE configuracion SET valor = '\"13\"' WHERE clave = 'hora_corte_despacho'"), /configuracion_valor_valido/);
        await assert.rejects(() => pool.query("UPDATE configuracion SET valor = '1' WHERE clave = 'incluir_dia_recepcion'"), /configuracion_valor_valido/);
    });

    test('el despacho guarda su inicio de cobro: 12:59 cuenta el dia, 13:00 el siguiente', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const antes = await despachar(equipo.id, cliente, '2026-03-10T12:59:00-03:00');
        assert.equal(antes.status, 201);
        assert.equal(await inicioDe(antes.body.id), '2026-03-10');
        const otro = await crearEquipo(null);
        const despues = await despachar(otro.id, cliente, '2026-03-10T13:00:00-03:00');
        assert.equal(await inicioDe(despues.body.id), '2026-03-11');
    });

    test('gomaq_inicio_cobro (SQL) coincide con inicioCobroDia (JS)', async (t) => {
        if (!requiereBase(t)) return;
        const instantes = [
            '2026-03-05T02:00:00Z', '2026-03-10T12:59:00-03:00', '2026-03-10T13:00:00-03:00', '2026-12-31T14:00:00-03:00',
            '2028-02-28T14:00:00-03:00', '2026-04-04T23:30:00-03:00', '2026-09-06T00:30:00-04:00', '2026-09-06T12:59:00-03:00',
            '2026-06-15T09:00:00-04:00', '2026-01-01T00:00:00Z',
        ];
        for (const hora of [0, 9, 13, 23]) {
            for (const instante of instantes) {
                const r = await pool.query('SELECT gomaq_inicio_cobro($1::timestamptz, $2)::text AS d', [instante, hora]);
                assert.equal(r.rows[0].d, inicioCobroDia(instante, hora), `${instante} con corte ${hora}`);
            }
        }
    });

    test('un INSERT directo (version anterior del servidor) tambien queda con inicio de cobro', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const g = await pool.query(
            `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha) VALUES ($1, 'despacho', 'x', '2026-03-10T14:00:00-03:00') RETURNING id`,
            [equipo.id]);
        assert.equal(await inicioDe(g.rows[0].id), '2026-03-11');
        const r = await pool.query(
            `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha) VALUES ($1, 'recepcion', 'x', now()) RETURNING inicio_cobro`, [equipo.id]);
        assert.equal(r.rows[0].inicio_cobro, null, 'una recepcion no tiene inicio de cobro');
    });

    test('cambiar la hora de corte afecta a los despachos nuevos y no reescribe los viejos', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const viejo = await despachar((await crearEquipo(null)).id, cliente, '2026-03-10T10:00:00-03:00');
        assert.equal(await inicioDe(viejo.body.id), '2026-03-10');
        try {
            const put = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { hora_corte_despacho: 9 });
            assert.equal(put.status, 200);
            assert.equal(put.body.hora_corte_despacho, 9);
            const nuevo = await despachar((await crearEquipo(null)).id, cliente, '2026-03-10T10:00:00-03:00');
            assert.equal(await inicioDe(nuevo.body.id), '2026-03-11', 'el despacho nuevo usa el corte nuevo');
            assert.equal(await inicioDe(viejo.body.id), '2026-03-10', 'el viejo conserva el suyo');
            const leida = await pedir('GET', '/api/facturacion/configuracion', 'administrativo');
            assert.equal(leida.body.hora_corte_despacho, 9);
            assert.ok(leida.body.actualizado_por, 'dice quien la cambio');
            assert.ok(leida.body.actualizado_at);
        } finally {
            await restaurarConfiguracion();
        }
        assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'gerente')).body.hora_corte_despacho, 13);
    });

    test('arriendos en curso: aparece con el cliente de la guia, cuenta desde su inicio y desaparece al recepcionar', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await despachar(equipo.id, cliente, '2026-01-02T09:00:00-03:00');
        const buscar = async () => (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'administrativo')).body
            .arriendos.find((a) => a.maquinaria_id === equipo.id);
        const fila = await buscar();
        assert.ok(fila, 'el equipo despachado aparece');
        assert.equal(fila.cliente_id, cliente);
        assert.equal(fila.guia_despacho_id, d.body.id);
        assert.equal(fila.inicio_cobro, '2026-01-02');
        assert.equal(fila.desde, '2026-01-02');
        assert.ok(fila.dias > 30);
        assert.ok(fila.periodos_sin_facturar >= 1 && fila.aviso === true);
        assert.match(fila.proximo_corte, /^\d{4}-\d{2}-05$/);
        // la recepcion cierra el arriendo
        const formulario = new FormData();
        formulario.append('tipo', 'recepcion');
        formulario.append('sin_documento', 'true');
        const rec = await fetch(`${base}/api/maquinarias/${equipo.id}/guias`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario });
        assert.equal(rec.status, 201);
        assert.equal(await buscar(), undefined, 'ya no esta en curso');
    });

    test('arriendos en curso: sin guia, con despacho fallido y con dos despachos seguidos', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const buscar = async (id) => (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'gerente')).body
            .arriendos.filter((a) => a.maquinaria_id === id);
        // cliente cargado directo en el equipo, sin ninguna guia: no aparece
        const directo = await crearEquipo(cliente);
        assert.equal((await buscar(directo.id)).length, 0);
        // despacho fallido: no cuenta
        const fallido = await crearEquipo(null);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, fallido, cliente_id) VALUES ($1, 'despacho', 'x', now(), true, $2)`, [fallido.id, cliente]);
        assert.equal((await buscar(fallido.id)).length, 0);
        // dos despachos sin recepcion entre ellos (no deberia pasar): el primero se cierra solo y el
        // segundo, a otro cliente, es el unico arriendo en curso del equipo
        const doble = await crearEquipo(null);
        const otroCliente = (await pool.query('SELECT id FROM clientes WHERE id <> $1 ORDER BY id LIMIT 1', [cliente])).rows[0];
        const g1 = await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-02-01T09:00:00-03:00', $2) RETURNING id`, [doble.id, cliente]);
        const g2 = await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-02-10T09:00:00-03:00', $2) RETURNING id`, [doble.id, otroCliente ? otroCliente.id : cliente]);
        const filas = await buscar(doble.id);
        assert.equal(filas.length, 1);
        assert.equal(filas[0].guia_despacho_id, g2.rows[0].id);
        assert.equal(filas[0].inicio_cobro, '2026-02-10');
        const pendiente = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos
            .find((a) => a.guia_despacho_id === g1.rows[0].id);
        assert.ok(pendiente, 'el primero queda pendiente de facturar');
        assert.equal(pendiente.falta_recepcion, true);
        assert.equal(pendiente.guia_recepcion_id, null);
    });

    test('arriendos en curso: recepcion y despacho a la misma hora se ordenan por id', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const hora = '2026-02-01T09:00:00-03:00';
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', $2, $3)`, [equipo.id, hora, cliente]);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'recepcion', 'x', $2, $3)`, [equipo.id, hora, cliente]);
        const cerrado = (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'gerente')).body.arriendos;
        assert.equal(cerrado.filter((a) => a.maquinaria_id === equipo.id).length, 0, 'recepcion posterior por id: cerrado');
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', $2, $3)`, [equipo.id, hora, cliente]);
        const abierto = (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'gerente')).body.arriendos;
        assert.equal(abierto.filter((a) => a.maquinaria_id === equipo.id).length, 1, 'despacho posterior por id: abierto de nuevo');
    });

    test('la hora de corte vigente al registrar la recepcion decide si se cobra ese dia; cambiarla despues no altera lo registrado', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const dias = async (equipoId) => (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body
            .arriendos.find((a) => a.maquinaria_id === equipoId).dias;
        const registrar = async () => {
            const equipo = await crearEquipo(null);
            await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-03-01T08:00:00-03:00', $2)`, [equipo.id, cliente]);
            await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'recepcion', 'x', '2026-03-05T10:00:00-03:00', $2)`, [equipo.id, cliente]);
            return equipo.id;
        };
        // corte 13: la recepcion de las 10 no cobra el dia 5
        const antes = await registrar();
        assert.equal(await dias(antes), 4);
        try {
            assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { hora_corte_despacho: 9 })).status, 200);
            assert.equal(await dias(antes), 4, 'lo ya registrado no cambia con la configuracion');
            const despues = await registrar();
            assert.equal(await dias(despues), 5, 'registrada con corte 9, la recepcion de las 10 si cobra ese dia');
        } finally {
            await restaurarConfiguracion();
        }
        assert.equal(await dias(antes), 4);
    });

    test('el PUT sigue aceptando incluir_dia_recepcion (obsoleta) pero no cambia nada', async (t) => {
        if (!requiereBase(t)) return;
        try {
            const r = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { incluir_dia_recepcion: false });
            assert.equal(r.status, 200);
            assert.equal('incluir_dia_recepcion' in r.body, false);
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-03-01T08:00:00-03:00', $2)`, [equipo.id, cliente]);
            await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'recepcion', 'x', '2026-03-05T14:00:00-03:00', $2)`, [equipo.id, cliente]);
            const fila = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body
                .arriendos.find((a) => a.maquinaria_id === equipo.id);
            assert.equal(fila.dias, 5, 'recepcion desde el corte: el dia se cobra, sin importar la opcion obsoleta');
        } finally {
            await pool.query("UPDATE configuracion SET valor = 'true', actualizado_por = NULL WHERE clave = 'incluir_dia_recepcion'");
            await restaurarConfiguracion();
        }
    });

    test('el endpoint viejo de dias de arriendo se retiro', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', `/api/maquinarias/${datos.maquinariaId}/dias-arriendo`, 'administrativo');
        assert.equal(r.status, 404);
    });
});

describe('bloque 2b (parte 1): la factura guarda despacho, periodo y cliente', () => {
    const SQL_023 = () => require('fs').readFileSync(
        require('path').join(__dirname, '../../db/migrations/023_facturas_periodo.sql'), 'utf8')
        + '\n' + require('fs').readFileSync(require('path').join(__dirname, '../../db/migrations/028_fin_arriendo_hora_corte.sql'), 'utf8');

    const guia = async (equipoId, tipo, fecha, clienteId) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, $2::tipo_guia, 'x', $3, $4) RETURNING id`,
        [equipoId, tipo, fecha, clienteId])).rows[0].id;

    /** Inserta una factura de arriendo como lo hacia el servidor anterior: solo con la recepcion. */
    const facturaAntigua = async (equipoId, recepcionId, folio) => (await pool.query(
        `INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url, monto) VALUES ($1, $2, $3, 'x', 1000) RETURNING *`,
        [equipoId, recepcionId, folio])).rows[0];

    const fila = async (id) => (await pool.query(
        `SELECT guia_despacho_id, to_char(periodo_desde, 'YYYY-MM-DD') AS desde, to_char(periodo_hasta, 'YYYY-MM-DD') AS hasta, cliente_id
         FROM facturas WHERE id = $1`, [id])).rows[0];

    test('una factura de arriendo insertada como el servidor anterior recibe despacho, periodo y cliente', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
        const f = await facturaAntigua(equipo.id, r, 'T-2301');
        const datosFila = await fila(f.id);
        assert.equal(datosFila.guia_despacho_id, d);
        assert.equal(datosFila.desde, '2026-03-01');
        assert.equal(datosFila.hasta, '2026-03-05');
        assert.equal(datosFila.cliente_id, cliente);
    });

    test('arriendo de 0 dias: recibe el despacho pero no periodo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T15:00:00-03:00', cliente); // cobra desde el 2
        const r = await guia(equipo.id, 'recepcion', '2026-03-01T17:00:00-03:00', cliente);
        const datosFila = await fila((await facturaAntigua(equipo.id, r, 'T-2302')).id);
        assert.equal(datosFila.guia_despacho_id, d);
        assert.equal(datosFila.desde, null);
        assert.equal(datosFila.hasta, null);
    });

    test('el periodo de una factura antigua termina segun la hora de la recepcion (corte 13)', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        for (const [hora, hasta] of [['00:00', '2026-03-04'], ['09:59', '2026-03-04'], ['12:59', '2026-03-04'],
            ['13:00', '2026-03-05'], ['23:59', '2026-03-05']]) {
            const equipo = await crearEquipo(null);
            await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
            const r = await guia(equipo.id, 'recepcion', `2026-03-05T${hora}:00-03:00`, cliente);
            assert.equal((await fila((await facturaAntigua(equipo.id, r, `T-23${hora.replace(':', '')}`)).id)).hasta, hasta, hora);
        }
    });

    test('la recepcion registrada con otro corte lo guarda y el trigger de facturas lo respeta', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        let r;
        try {
            await pool.query("UPDATE configuracion SET valor = '9' WHERE clave = 'hora_corte_despacho'");
            r = await guia(equipo.id, 'recepcion', '2026-03-05T10:00:00-03:00', cliente);
        } finally {
            await pool.query("UPDATE configuracion SET valor = '13', actualizado_por = NULL WHERE clave = 'hora_corte_despacho'");
        }
        const guardado = (await pool.query("SELECT to_char(fin_cobro, 'YYYY-MM-DD') AS d FROM guias WHERE id = $1", [r])).rows[0].d;
        assert.equal(guardado, '2026-03-05', 'fin_cobro se fijo con el corte vigente al registrar (9)');
        assert.equal((await fila((await facturaAntigua(equipo.id, r, 'T-2303')).id)).hasta, '2026-03-05');
    });

    test('recepcion el mismo dia del despacho antes del corte: el arriendo tiene 0 dias y no recibe periodo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        await guia(equipo.id, 'despacho', '2026-03-01T08:00:00-03:00', cliente);
        const r = await guia(equipo.id, 'recepcion', '2026-03-01T11:00:00-03:00', cliente);
        const datosFila = await fila((await facturaAntigua(equipo.id, r, 'T-2305')).id);
        assert.equal(datosFila.desde, null);
        assert.equal(datosFila.hasta, null);
    });

    test('dos recepciones del mismo despacho: la segunda factura se inserta sin despacho y sin error', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r1 = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
        const r2 = await guia(equipo.id, 'recepcion', '2026-03-06T14:00:00-03:00', cliente);
        const f1 = await fila((await facturaAntigua(equipo.id, r1, 'T-2304')).id);
        const f2 = await fila((await facturaAntigua(equipo.id, r2, 'T-2305')).id);
        assert.equal(f1.guia_despacho_id, d);
        assert.equal(f2.guia_despacho_id, null, 'el despacho ya tiene factura');
        assert.equal(f2.cliente_id, cliente, 'el cliente si se completa');
    });

    test('recepcion sin despacho anterior: factura sin despacho y con el cliente de la recepcion', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const r = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
        const datosFila = await fila((await facturaAntigua(equipo.id, r, 'T-2306')).id);
        assert.equal(datosFila.guia_despacho_id, null);
        assert.equal(datosFila.cliente_id, cliente);
    });

    test('una factura de reparacion toma el cliente de la OT', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await facturarDirecto(ot, 'T-2307');
        const r = await pool.query(
            `SELECT f.cliente_id, ot.cliente_id AS cliente_ot FROM facturas f JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
             WHERE f.orden_trabajo_id = $1`, [ot]);
        assert.equal(r.rows[0].cliente_id, r.rows[0].cliente_ot);
    });

    test('el indice unico impide dos facturas del mismo periodo de un despacho', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const insertar = (folio) => pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, folio, archivo_url)
             VALUES ($1, $2, '2026-03-01', '2026-03-05', $3, 'x')`, [equipo.id, d, folio]);
        await insertar('T-2308');
        await assert.rejects(() => insertar('T-2309'), /facturas_despacho_periodo_unico/);
        // otro periodo del mismo despacho si
        await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, folio, archivo_url)
             VALUES ($1, $2, '2026-03-06', '2026-04-05', 'T-2310', 'x')`, [equipo.id, d]);
    });

    test('correr la migracion 023 otra vez rellena lo que falte y no rompe nada', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
        const f = await facturaAntigua(equipo.id, r, 'T-2311');
        // se simula una factura anterior a la migracion
        await pool.query('UPDATE facturas SET guia_despacho_id = NULL, periodo_desde = NULL, periodo_hasta = NULL, cliente_id = NULL WHERE id = $1', [f.id]);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SQL_023());
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
        const datosFila = await fila(f.id);
        assert.equal(datosFila.guia_despacho_id, d);
        assert.equal(datosFila.desde, '2026-03-01');
        assert.equal(datosFila.hasta, '2026-03-05');
        assert.equal(datosFila.cliente_id, cliente);
        const trig = await pool.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'facturas_completar'");
        assert.equal(trig.rows[0].n, 1);
    });

    test('valorizar una OT ya facturada da 409 y no cambia el monto', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        await facturarDirecto(ot, 'T-2312');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 5000 });
        assert.equal(r.status, 409);
        assert.match(r.body.error, /facturada/);
        const v = await pool.query('SELECT valorizacion FROM ordenes_trabajo WHERE id = $1', [ot]);
        assert.equal(Number(v.rows[0].valorizacion), 1000);
    });

    test('autorizar el envio usa el cliente de la propia factura', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await pool.query("SELECT id, email FROM clientes WHERE email IS NOT NULL ORDER BY id LIMIT 1");
        if (cliente.rows.length === 0) return t.skip('no hay un cliente con correo en la semilla');
        const equipo = await crearEquipo(null);
        const f = (await pool.query(
            `INSERT INTO facturas (maquinaria_id, folio, archivo_url, cliente_id) VALUES ($1, 'T-2313', 'x', $2) RETURNING id`,
            [equipo.id, cliente.rows[0].id])).rows[0];
        const marca = new Date();
        const r = await pedir('POST', `/api/facturacion/${f.id}/autorizar-envio`, 'administrativo', {});
        assert.equal(r.status, 200);
        const n = await pool.query(
            `SELECT id, destinatario FROM notificaciones_pendientes WHERE created_at >= $1 AND payload->>'folio' = 'T-2313'`, [marca]);
        try {
            assert.equal(n.rows.length, 1);
            assert.equal(n.rows[0].destinatario, cliente.rows[0].email);
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = ANY($1)', [n.rows.map((x) => x.id)]);
        }
    });
});

describe('bloque 2b (parte 1): correcciones de la revision experta', () => {
    const SQL_023 = () => require('fs').readFileSync(
        require('path').join(__dirname, '../../db/migrations/023_facturas_periodo.sql'), 'utf8')
        + '\n' + require('fs').readFileSync(require('path').join(__dirname, '../../db/migrations/028_fin_arriendo_hora_corte.sql'), 'utf8');
    const guia = async (equipoId, tipo, fecha, clienteId) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, $2::tipo_guia, 'x', $3, $4) RETURNING id`,
        [equipoId, tipo, fecha, clienteId])).rows[0].id;

    test('una OT facturada sin valorizar no queda en los pendientes de valorizar', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, null);
        assert.ok((await pendientesDeValorizar()).includes(ot), 'antes de facturar, pendiente');
        assert.equal((await subirFactura(ot, 'administrativo', { folio: 'T-2401' })).status, 201);
        assert.ok(!(await pendientesDeValorizar()).includes(ot), 'facturada: ya no esta pendiente');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 1000 });
        assert.equal(r.status, 409);
    });

    test('el relleno da el despacho a la recepcion mas antigua, aunque otra se haya facturado antes', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r1 = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
        const r2 = await guia(equipo.id, 'recepcion', '2026-03-08T14:00:00-03:00', cliente);
        // la posterior se factura primero (id menor)
        const f2 = (await pool.query(`INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, 'T-2402', 'x') RETURNING id`, [equipo.id, r2])).rows[0].id;
        const f1 = (await pool.query(`INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, 'T-2403', 'x') RETURNING id`, [equipo.id, r1])).rows[0].id;
        await pool.query('UPDATE facturas SET guia_despacho_id = NULL, periodo_desde = NULL, periodo_hasta = NULL WHERE id = ANY($1)', [[f1, f2]]);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SQL_023());
            await client.query('COMMIT');
        } finally {
            client.release();
        }
        const r = await pool.query(
            `SELECT id, guia_despacho_id, to_char(periodo_hasta, 'YYYY-MM-DD') AS hasta FROM facturas WHERE id = ANY($1)`, [[f1, f2]]);
        const por = Object.fromEntries(r.rows.map((x) => [x.id, x]));
        assert.equal(por[f1].guia_despacho_id, d, 'la recepcion mas antigua se queda con el despacho');
        assert.equal(por[f1].hasta, '2026-03-05');
        assert.equal(por[f2].guia_despacho_id, null);
    });

    test('el relleno usa la regla historica aunque la configuracion cambie despues', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
        const f = (await pool.query(`INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, 'T-2404', 'x') RETURNING id`, [equipo.id, r])).rows[0].id;
        await pool.query('UPDATE facturas SET guia_despacho_id = NULL, periodo_desde = NULL, periodo_hasta = NULL WHERE id = $1', [f]);
        try {
            await pool.query("UPDATE configuracion SET valor = '23' WHERE clave = 'hora_corte_despacho'");
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(SQL_023());
                await client.query('COMMIT');
            } finally {
                client.release();
            }
        } finally {
            await pool.query("UPDATE configuracion SET valor = '13', actualizado_por = NULL WHERE clave = 'hora_corte_despacho'");
        }
        const fila = (await pool.query(`SELECT to_char(periodo_hasta, 'YYYY-MM-DD') AS hasta FROM facturas WHERE id = $1`, [f])).rows[0];
        assert.equal(fila.hasta, '2026-03-05');
    });

    test('la factura de una guia que no es recepcion no recibe despacho ni periodo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const f = (await pool.query(`INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, 'T-2405', 'x') RETURNING guia_despacho_id, periodo_desde`, [equipo.id, d])).rows[0];
        assert.equal(f.guia_despacho_id, null);
        assert.equal(f.periodo_desde, null);
    });

    test('dos facturas simultaneas del mismo despacho no dan un error de unicidad', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        for (let vuelta = 0; vuelta < 5; vuelta++) {
            const equipo = await crearEquipo(null);
            await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
            const r1 = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
            const r2 = await guia(equipo.id, 'recepcion', '2026-03-06T14:00:00-03:00', cliente);
            const insertar = (r, folio) => pool.query(
                `INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, $3, 'x') RETURNING id`, [equipo.id, r, folio]);
            const resultados = await Promise.allSettled([insertar(r1, `T-25${vuelta}1`), insertar(r2, `T-25${vuelta}2`)]);
            assert.deepEqual(resultados.map((x) => x.status), ['fulfilled', 'fulfilled'], JSON.stringify(resultados.map((x) => x.reason && x.reason.message)));
        }
    });
});

describe('bloque 2b (parte 2): facturas de arriendo por periodo', () => {
    const DEFECTO = { dia_facturacion: 5, hora_corte_despacho: 13, corte_cierra_periodo: true };

    async function restaurar() {
        for (const [clave, valor] of Object.entries(DEFECTO)) {
            await pool.query(
                `INSERT INTO configuracion (clave, valor) VALUES ($1, $2::jsonb)
                 ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_por = NULL`, [clave, JSON.stringify(valor)]);
        }
    }

    const guiaSql = async (equipoId, tipo, fecha, clienteId) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, $2::tipo_guia, 'x', $3, $4) RETURNING id`,
        [equipoId, tipo, fecha, clienteId])).rows[0].id;

    /** Un arriendo ya terminado: despacho y recepcion con las fechas dadas. */
    async function arriendo(despacho, recepcion, clienteId) {
        const cliente = clienteId || await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guiaSql(equipo.id, 'despacho', despacho, cliente);
        const r = recepcion ? await guiaSql(equipo.id, 'recepcion', recepcion, cliente) : null;
        return { equipo, d, r, cliente };
    }

    const propuesta = async (d, rol = 'administrativo') => pedir('GET', `/api/facturacion/arriendos/${d}/propuesta`, rol);

    async function facturar(campos, rol = 'administrativo') {
        const formulario = new FormData();
        for (const [k, v] of Object.entries(campos)) if (v !== undefined && v !== null) formulario.append(k, String(v));
        formulario.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'f.pdf');
        const r = await fetch(`${base}/api/facturacion/arriendo`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens[rol]}` }, body: formulario });
        return leerRespuesta(r);
    }

    test('propuesta: del inicio de cobro al primer corte, con las opciones hasta el fin', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T14:00:00-03:00');
        const r = await propuesta(d);
        assert.equal(r.status, 200);
        assert.equal(r.body.desde, '2026-08-01');
        assert.equal(r.body.hasta_sugerido, '2026-08-05');
        assert.deepEqual(r.body.opciones_hasta, ['2026-08-05', '2026-09-05', '2026-10-05', '2026-10-20']);
        assert.equal(r.body.dias, 5);
        assert.equal(r.body.es_final, false);
        assert.equal(r.body.en_curso, false);
        assert.equal((await propuesta(d, 'gerente')).status, 200);
        assert.equal((await propuesta(d, 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos/99999999/propuesta', 'administrativo')).status, 404);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos/abc/propuesta', 'administrativo')).status, 400);
    });

    test('facturar por periodos encadenados hasta el final, sin huecos', async (t) => {
        if (!requiereBase(t)) return;
        const { d, r: recep, cliente } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T14:00:00-03:00');
        const ids = [];
        for (const [desde, hasta] of [['2026-08-01', '2026-08-05'], ['2026-08-06', '2026-09-05'], ['2026-09-06', '2026-10-05'], ['2026-10-06', '2026-10-20']]) {
            const p = await propuesta(d);
            assert.equal(p.body.desde, desde);
            const f = await facturar({ guia_despacho_id: d, periodo_desde: desde, periodo_hasta: hasta, folio: `P-${desde}`, monto: 1000 });
            assert.equal(f.status, 201, JSON.stringify(f.body));
            assert.equal(f.body.cliente_id, cliente);
            ids.push(f.body.id);
            if (hasta === '2026-10-20') {
                assert.equal(f.body.guia_recepcion_id, recep, 'la factura final se ata a la recepcion');
            } else {
                assert.equal(f.body.guia_recepcion_id, null);
            }
        }
        const fin = await propuesta(d);
        assert.equal(fin.body.nada_que_facturar, true);
        assert.equal(fin.body.facturado_completo, true);
        const otra = await facturar({ guia_despacho_id: d, periodo_desde: '2026-10-21', periodo_hasta: '2026-10-21', folio: 'P-extra' });
        assert.equal(otra.status, 409);
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos;
        assert.equal(pend.find((a) => a.guia_despacho_id === d), undefined, 'facturado completo no esta pendiente');
    });

    test('un periodo parcial deja el resto pendiente en /pendientes', async (t) => {
        if (!requiereBase(t)) return;
        const { d, r: recep } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T14:00:00-03:00');
        const f = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-05', folio: 'PP-1' });
        assert.equal(f.status, 201);
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos.find((a) => a.guia_despacho_id === d);
        assert.ok(pend);
        assert.equal(pend.desde, '2026-08-06');
        assert.equal(pend.hasta_sugerido, '2026-09-05');
        assert.equal(pend.guia_recepcion_id, recep);
        assert.equal(pend.dias, 76);
    });

    test('periodo con hueco, solape o fin invalido se rechaza y no sube el PDF', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T14:00:00-03:00');
        const subidos = datos.storage.subidos.length;
        const hueco = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-03', periodo_hasta: '2026-08-05', folio: 'H-1' });
        assert.equal(hueco.status, 409);
        assert.equal(hueco.body.codigo, 'periodo_desactualizado');
        assert.equal(hueco.body.propuesta.desde, '2026-08-01', 'devuelve la propuesta actual');
        const invalido = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-07', folio: 'H-2' });
        assert.equal(invalido.status, 400);
        const pasado = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-10-21', folio: 'H-3' });
        assert.equal(pasado.status, 400);
        const mal = await facturar({ guia_despacho_id: d, periodo_desde: 'ayer', periodo_hasta: '2026-08-05', folio: 'H-4' });
        assert.equal(mal.status, 400);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE guia_despacho_id = $1', [d])).rows.length, 0);
        assert.ok(datos.storage.borrados.length >= datos.storage.subidos.length - subidos, 'los PDF subidos se borran');
        // solape: tras facturar el primero, repetir el mismo periodo es desactualizado
        assert.equal((await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-05', folio: 'H-5' })).status, 201);
        const repetido = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-05', folio: 'H-6' });
        assert.equal(repetido.status, 409);
    });

    test('dos facturas simultaneas del mismo periodo: una entra y la otra se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T14:00:00-03:00');
        const campos = { guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-05' };
        const [a, b] = await Promise.all([facturar({ ...campos, folio: 'C-1' }), facturar({ ...campos, folio: 'C-2' })]);
        assert.deepEqual([a.status, b.status].sort(), [201, 409]);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE guia_despacho_id = $1', [d])).rows.length, 1);
    });

    test('compatibilidad: solo con guia_recepcion_id factura todo hasta el fin (panel antiguo)', async (t) => {
        if (!requiereBase(t)) return;
        const { d, r } = await arriendo('2026-03-01T09:00:00-03:00', '2026-03-04T14:00:00-03:00');
        const f = await facturar({ guia_recepcion_id: r, folio: 'L-1', monto: 500 });
        assert.equal(f.status, 201, JSON.stringify(f.body));
        assert.equal(f.body.guia_despacho_id, d);
        assert.equal(f.body.guia_recepcion_id, r);
        assert.equal(String(f.body.periodo_desde).slice(0, 10) >= '2026-02-28', true);
        const otra = await facturar({ guia_recepcion_id: r, folio: 'L-2' });
        assert.equal(otra.status, 409);
        assert.match(otra.body.error, /ya tiene su factura/);
        assert.equal((await facturar({ guia_recepcion_id: 99999999, folio: 'L-3' })).status, 404);
        assert.equal((await facturar({ folio: 'L-4' })).status, 400);
    });

    test('un arriendo en curso solo se factura hasta un corte ya vencido', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-01-02T09:00:00-03:00', null);
        const p = await propuesta(d);
        assert.equal(p.body.en_curso, true);
        assert.equal(p.body.desde, '2026-01-02');
        assert.equal(p.body.hasta_sugerido, '2026-01-05');
        assert.equal(p.body.es_final, false);
        assert.equal((await facturar({ guia_despacho_id: d, periodo_desde: '2026-01-02', periodo_hasta: '2026-01-05', folio: 'E-1' })).status, 201);
        const siguiente = await propuesta(d);
        assert.equal(siguiente.body.desde, '2026-01-06');
        // en curso no se puede cerrar con el panel antiguo (no hay recepcion)
        const enCurso = (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'administrativo')).body.arriendos.find((a) => a.guia_despacho_id === d);
        assert.equal(enCurso.facturado_hasta, '2026-01-05');
        assert.equal(enCurso.desde, '2026-01-06');
    });

    test('despacho de otro cliente sin recepcion en medio: el primero se cierra y cada uno factura al suyo', async (t) => {
        if (!requiereBase(t)) return;
        const c1 = await algunCliente();
        const otro = (await pool.query('SELECT id FROM clientes WHERE id <> $1 ORDER BY id LIMIT 1', [c1])).rows[0];
        const equipo = await crearEquipo(null);
        const d1 = await guiaSql(equipo.id, 'despacho', '2026-02-01T09:00:00-03:00', c1);
        const d2 = await guiaSql(equipo.id, 'despacho', '2026-02-10T11:00:00-03:00', otro ? otro.id : c1);
        const p1 = await propuesta(d1);
        assert.equal(p1.body.falta_recepcion, true);
        assert.equal(p1.body.en_curso, false);
        assert.equal(p1.body.fin, '2026-02-09', 'el segundo despacho de las 11 (antes del corte) cobra ese dia al cliente nuevo');
        assert.equal(p1.body.cliente_id, c1);
        const p2 = await propuesta(d2);
        assert.equal(p2.body.en_curso, true);
        assert.equal(p2.body.desde, '2026-02-10');
        assert.equal(p2.body.cliente_id, otro ? otro.id : c1);
    });

    test('despacho a las 12:59 y 13:00 en el mismo dia que vuelve otro equipo: cada uno cuenta su dia', async (t) => {
        if (!requiereBase(t)) return;
        const a = await arriendo('2026-03-10T12:59:00-03:00', '2026-03-12T10:00:00-03:00');
        const b = await arriendo('2026-03-10T13:00:00-03:00', '2026-03-12T10:00:00-03:00');
        assert.equal((await propuesta(a.d)).body.desde, '2026-03-10');
        assert.equal((await propuesta(b.d)).body.desde, '2026-03-11');
    });

    test('devolucion el mismo dia, ya pasado el corte: 0 dias, no queda pendiente', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-03-10T15:00:00-03:00', '2026-03-10T17:00:00-03:00');
        const p = await propuesta(d);
        assert.equal(p.body.nada_que_facturar, true);
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos;
        assert.equal(pend.find((x) => x.guia_despacho_id === d), undefined);
    });

    test('monto de la factura de arriendo: solo enteros de pesos, 400 antes de subir el PDF', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-03-01T09:00:00-03:00', '2026-03-05T14:00:00-03:00');
        const subidosAntes = datos.storage.subidos.length;
        for (const monto of ['249.900', '249,9', '-1000', '1e3', '12.5', 'abc', '1 000']) {
            const r = await facturar({ guia_despacho_id: d, periodo_desde: '2026-03-01', periodo_hasta: '2026-03-05', folio: 'M-1', monto });
            assert.equal(r.status, 400, `monto ${monto}`);
        }
        assert.equal(datos.storage.subidos.length, subidosAntes, 'no se subio ningun PDF');
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE guia_despacho_id = $1', [d])).rows.length, 0);
        const ok = await facturar({ guia_despacho_id: d, periodo_desde: '2026-03-01', periodo_hasta: '2026-03-05', folio: 'M-2', monto: '249900' });
        assert.equal(ok.status, 201);
        assert.equal(Number(ok.body.monto), 249900);
    });

    test('la recepcion antes del corte no cobra ese dia; con otra hora de corte vigente al registrarla si', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-10-10T09:00:00-03:00', '2026-10-20T10:00:00-03:00');
        const p0 = await propuesta(d);
        assert.equal(p0.body.fin, '2026-10-19');
        assert.deepEqual(p0.body.opciones_hasta, ['2026-10-19']);
        try {
            assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { hora_corte_despacho: 9 })).status, 200);
            assert.equal((await propuesta(d)).body.fin, '2026-10-19', 'lo ya registrado no cambia');
            const { d: d2 } = await arriendo('2026-10-10T09:00:00-03:00', '2026-10-20T10:00:00-03:00');
            assert.equal((await propuesta(d2)).body.fin, '2026-10-20', 'registrada con corte 9 cobra ese dia');
        } finally {
            await restaurar();
        }
        assert.equal((await propuesta(d)).body.fin, '2026-10-19');
    });

    test('si el corte no cierra el periodo, el periodo termina el dia anterior al corte', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T14:00:00-03:00');
        try {
            const put = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { corte_cierra_periodo: false });
            assert.equal(put.status, 200);
            assert.equal(put.body.corte_cierra_periodo, false);
            const p = await propuesta(d);
            assert.deepEqual(p.body.opciones_hasta, ['2026-08-04', '2026-09-04', '2026-10-04', '2026-10-20']);
            assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'administrativo')).body.corte_cierra_periodo, false);
            assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { corte_cierra_periodo: 'no' })).status, 400);
        } finally {
            await restaurar();
        }
        assert.equal((await propuesta(d)).body.opciones_hasta[0], '2026-08-05');
    });

    test('recepcion retroactiva anterior a lo ya facturado: se avisa y no admite otra factura', async (t) => {
        if (!requiereBase(t)) return;
        const { equipo, d, cliente } = await arriendo('2026-08-01T09:00:00-03:00', null);
        // en curso se puede facturar de una vez hasta cualquier corte vencido
        assert.equal((await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-09-05', folio: 'R-1' })).status, 201);
        // la recepcion se registra despues, con fecha anterior a lo facturado
        await guiaSql(equipo.id, 'recepcion', '2026-08-20T14:00:00-03:00', cliente);
        const p = await propuesta(d);
        assert.equal(p.body.facturado_de_mas, true);
        assert.equal(p.body.nada_que_facturar, true);
        // sigue visible en pendientes, con la marca, para que se emita la nota de credito
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos;
        const item = pend.find((x) => x.guia_despacho_id === d);
        assert.ok(item, 'el arriendo facturado de mas sigue visible');
        assert.equal(item.facturado_de_mas, true);
        assert.equal(item.facturado_hasta, '2026-09-05');
        assert.equal(item.dias, 0);
        // y no admite otra factura
        assert.equal((await facturar({ guia_despacho_id: d, periodo_desde: '2026-09-06', periodo_hasta: '2026-09-10', folio: 'R-2' })).status, 409);
    });

    test('/pendientes con recepciones repetidas ya no duplica el arriendo', async (t) => {
        if (!requiereBase(t)) return;
        const { equipo, d, cliente } = await arriendo('2026-03-01T09:00:00-03:00', '2026-03-05T14:00:00-03:00');
        await guiaSql(equipo.id, 'recepcion', '2026-03-06T14:00:00-03:00', cliente); // recepcion repetida (huerfana)
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos.filter((a) => a.guia_despacho_id === d);
        assert.equal(pend.length, 1);
    });

    test('valorizar y facturar una OT no se mezclan con los arriendos (campos nuevos en /pendientes)', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-03-01T09:00:00-03:00', '2026-03-05T14:00:00-03:00');
        const fila = (await pedir('GET', '/api/facturacion/pendientes', 'gerente')).body.arriendos.find((a) => a.guia_despacho_id === d);
        for (const campo of ['guia_recepcion_id', 'maquinaria_codigo', 'cliente_nombre', 'fecha_despacho', 'fecha_recepcion', 'dias', 'desde', 'hasta_sugerido', 'es_final']) {
            assert.ok(campo in fila, `falta ${campo}`);
        }
        assert.equal(fila.dias, 5);
    });
});

describe('bloque 3: estado del equipo derivado de las ordenes, cierre con estado y origen comercial', () => {
    const estadoDe = async (equipoId) => (await pool.query('SELECT estado, estado_origen FROM maquinarias WHERE id = $1', [equipoId])).rows[0];
    const diagnostico = (ot, cuerpo, rol = 'mecanico') => pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, rol, cuerpo);
    const finalizar = (ot, cuerpo = {}, rol = 'mecanico') => pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, rol, { sin_persona: true, ...cuerpo });
    const fijarEstado = (equipoId, estado, origen) =>
        pool.query('UPDATE maquinarias SET estado = $2, estado_origen = $3 WHERE id = $1', [equipoId, estado, origen]);
    /** OT asignada al mecanico sobre un equipo propio de la prueba. */
    const otDeEquipo = async (equipoId, estado = 'asignada') => crearOt(estado, datos.mecanicoId, equipoId);

    test('llegar a terreno por diagnostico deja el equipo en mantencion por la orden', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: null });
        assert.equal((await diagnostico(ot, { estado: 'aceptada' })).status, 200);
        assert.equal((await estadoDe(equipo.id)).estado, 'operativa', 'aceptar no toca el equipo');
        assert.equal((await diagnostico(ot, { estado: 'en_terreno' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'en_mantencion', estado_origen: 'ot' });
    });

    test('pasar de terreno a reparacion no repite la entrada: un operativa puesto a mano se respeta', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        assert.equal((await diagnostico(ot, { estado: 'en_terreno' })).status, 200);
        await fijarEstado(equipo.id, 'operativa', 'panel');
        assert.equal((await diagnostico(ot, { estado: 'en_reparacion' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'panel' });
        assert.equal((await diagnostico(ot, { estado: 'en_terreno' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'panel' });
    });

    test('un en_mantencion o fuera_de_servicio puestos a mano no se tocan al llegar a terreno', async (t) => {
        if (!requiereBase(t)) return;
        for (const estado of ['en_mantencion', 'fuera_de_servicio']) {
            const equipo = await crearEquipo(null);
            await fijarEstado(equipo.id, estado, 'panel');
            const ot = await otDeEquipo(equipo.id);
            assert.equal((await diagnostico(ot, { estado: 'en_terreno' })).status, 200);
            assert.deepEqual(await estadoDe(equipo.id), { estado, estado_origen: 'panel' });
        }
    });

    test('una OT creada en terreno (/en-terreno) deja el equipo en mantencion', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', { maquinaria_id: equipo.id, uuid_cliente: crypto.randomUUID() });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'en_mantencion', estado_origen: 'ot' });
    });

    test('cierre sin estado_equipo (APK antiguo): vuelve a operativa si la mantencion la puso la orden', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        assert.equal((await finalizar(ot)).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'ot' });
    });

    test('cierre sin estado_equipo nunca pisa un fuera_de_servicio ni un en_mantencion del panel', async (t) => {
        if (!requiereBase(t)) return;
        for (const estado of ['fuera_de_servicio', 'en_mantencion']) {
            const equipo = await crearEquipo(null);
            const ot = await otDeEquipo(equipo.id);
            await diagnostico(ot, { estado: 'en_terreno' });
            await fijarEstado(equipo.id, estado, 'panel');
            assert.equal((await finalizar(ot)).status, 200);
            assert.deepEqual(await estadoDe(equipo.id), { estado, estado_origen: 'panel' });
        }
    });

    test('cierre con estado_equipo = operativa deja el equipo operativo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        assert.equal((await finalizar(ot, { estado_equipo: 'operativa' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'mecanico' });
    });

    test('cierre con estado_equipo = operativa no levanta un en_mantencion puesto a mano', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        await fijarEstado(equipo.id, 'en_mantencion', 'panel');
        assert.equal((await finalizar(ot, { estado_equipo: 'operativa' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'en_mantencion', estado_origen: 'panel' });
    });

    test('cierre con fuera_de_servicio se aplica siempre, aunque el panel haya puesto otro estado o haya otra OT abierta', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        const otra = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        await diagnostico(otra, { estado: 'en_terreno' });
        await fijarEstado(equipo.id, 'operativa', 'panel');
        assert.equal((await finalizar(ot, { estado_equipo: 'fuera_de_servicio' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'fuera_de_servicio', estado_origen: 'mecanico' });
    });

    test('dos OT del mismo equipo: la primera en cerrarse lo deja en mantencion y la segunda operativo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const a = await otDeEquipo(equipo.id);
        const b = await otDeEquipo(equipo.id);
        await diagnostico(a, { estado: 'en_terreno' });
        await diagnostico(b, { estado: 'en_reparacion' });
        assert.equal((await estadoDe(equipo.id)).estado, 'en_mantencion');
        assert.equal((await finalizar(a, { estado_equipo: 'operativa' })).status, 200);
        assert.equal((await estadoDe(equipo.id)).estado, 'en_mantencion', 'queda otra OT abierta');
        assert.equal((await finalizar(b, { estado_equipo: 'operativa' })).status, 200);
        assert.equal((await estadoDe(equipo.id)).estado, 'operativa');
    });

    test('dos cierres simultaneos del mismo equipo no lo dejan pegado en mantencion', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 5; vuelta++) {
            const equipo = await crearEquipo(null);
            const a = await otDeEquipo(equipo.id);
            const b = await otDeEquipo(equipo.id);
            await diagnostico(a, { estado: 'en_terreno' });
            await diagnostico(b, { estado: 'en_terreno' });
            const [ra, rb] = await Promise.all([
                finalizar(a, { estado_equipo: 'operativa' }),
                finalizar(b, { estado_equipo: 'operativa' }),
            ]);
            assert.deepEqual([ra.status, rb.status], [200, 200]);
            assert.equal((await estadoDe(equipo.id)).estado, 'operativa', `vuelta ${vuelta}`);
        }
    });

    test('el cierre deja el estado del equipo en el historial y el reintento no lo repite ni cambia nada', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        const uuid = crypto.randomUUID();
        const primera = await finalizar(ot, { estado_equipo: 'fuera_de_servicio', uuid });
        assert.equal(primera.status, 200);
        // el panel recibe el equipo de vuelta y lo deja operativo a mano; el reintento no lo pisa
        await fijarEstado(equipo.id, 'operativa', 'panel');
        const segunda = await finalizar(ot, { estado_equipo: 'fuera_de_servicio', uuid });
        assert.equal(segunda.status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'panel' });
        const cierres = await eventosTipo(ot, 'cierre');
        assert.equal(cierres.length, 1);
        assert.deepEqual(
            [cierres[0].detalle.estado_equipo_pedido, cierres[0].detalle.estado_equipo_anterior, cierres[0].detalle.estado_equipo_nuevo],
            ['fuera_de_servicio', 'en_mantencion', 'fuera_de_servicio']);
    });

    test('estado_equipo invalido da 400 y la OT sigue abierta', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        for (const invalido of ['en_mantencion', 'OPERATIVA', 'roto', 1, true]) {
            const r = await finalizar(ot, { estado_equipo: invalido });
            assert.equal(r.status, 400, JSON.stringify(invalido));
        }
        assert.equal((await pool.query('SELECT estado FROM ordenes_trabajo WHERE id = $1', [ot])).rows[0].estado, 'en_terreno');
        assert.equal((await estadoDe(equipo.id)).estado, 'en_mantencion');
    });

    test('ocurrio_en del cierre: se respeta, no puede ser futuro ni anterior a la creacion', async (t) => {
        if (!requiereBase(t)) return;
        const cerrarCon = async (ocurrio) => {
            const equipo = await crearEquipo(null);
            const ot = await otDeEquipo(equipo.id);
            await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '1 day' WHERE id = $1", [ot]);
            await diagnostico(ot, { estado: 'en_terreno' });
            const r = await finalizar(ot, { ocurrio_en: ocurrio });
            assert.equal(r.status, 200);
            const fila = (await pool.query('SELECT fecha_cierre, fecha_creacion FROM ordenes_trabajo WHERE id = $1', [ot])).rows[0];
            return { fila, evento: (await eventosTipo(ot, 'cierre'))[0] };
        };
        const hace = new Date(Date.now() - 60 * 1000);
        const valido = await cerrarCon(hace.toISOString());
        assert.ok(Math.abs(new Date(valido.fila.fecha_cierre) - hace) < 1000, 'usa la hora del telefono');
        assert.ok(valido.evento.ocurrio_en);
        const futuro = await cerrarCon(new Date(Date.now() + 3600 * 1000).toISOString());
        assert.ok(new Date(futuro.fila.fecha_cierre) <= Date.now() + 2000, 'nunca en el futuro (la hora pedida era 1 h adelante)');
        const antiguo = await cerrarCon('2001-01-01T00:00:00Z');
        assert.ok(new Date(antiguo.fila.fecha_cierre) >= new Date(antiguo.fila.fecha_creacion), 'no antes de la creacion');
        const basura = await cerrarCon('no-es-fecha');
        assert.ok(Math.abs(new Date(basura.fila.fecha_cierre) - new Date()) < 5000, 'invalida: hora del servidor');
    });

    test('PATCH /maquinarias/:id/estado deja quien lo fijo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        assert.equal((await pedir('PATCH', `/api/maquinarias/${equipo.id}/estado`, 'administrativo', { estado: 'fuera_de_servicio' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'fuera_de_servicio', estado_origen: 'panel' });
        assert.equal((await pedir('PATCH', `/api/maquinarias/${equipo.id}/estado`, 'mecanico', { estado: 'operativa' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'mecanico' });
    });

    test('origen de la OT: externo si el cliente tiene ejecutivo, directo si no, en las tres rutas', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        if (!cliente) return t.skip('la base no tiene clientes');
        // siempre un ejecutivo propio: no depende de la semilla y se borra al final
        const ejecutivo = (await pool.query(
            'INSERT INTO ejecutivos (nombre) VALUES ($1) RETURNING id', [`Ejecutivo prueba ${crypto.randomUUID()}`])).rows[0];
        const original = (await pool.query('SELECT ejecutivo_id FROM clientes WHERE id = $1', [cliente])).rows[0].ejecutivo_id;
        const origenDe = async (ot) => (await pool.query('SELECT origen FROM ordenes_trabajo WHERE id = $1', [ot])).rows[0].origen;
        try {
            for (const [ejecutivoId, esperado] of [[ejecutivo.id, 'externo'], [null, 'directo']]) {
                await pool.query('UPDATE clientes SET ejecutivo_id = $2 WHERE id = $1', [cliente, ejecutivoId]);
                // panel: POST /, aunque el body diga otra cosa
                const eq1 = await crearEquipo(cliente);
                const panel = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: eq1.id, origen: ejecutivoId ? 'directo' : 'externo' });
                assert.equal(panel.status, 201);
                datos.ordenes.push(panel.body.id);
                assert.equal(await origenDe(panel.body.id), esperado, 'panel');
                // terreno: /en-terreno
                const eq2 = await crearEquipo(cliente);
                const terreno = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', { maquinaria_id: eq2.id, uuid_cliente: crypto.randomUUID() });
                assert.equal(terreno.status, 201);
                datos.ordenes.push(terreno.body.id);
                assert.equal(await origenDe(terreno.body.id), esperado, 'terreno');
            }
        } finally {
            await pool.query('UPDATE clientes SET ejecutivo_id = $2 WHERE id = $1', [cliente, original]);
            await pool.query('DELETE FROM ejecutivos WHERE id = $1', [ejecutivo.id]);
        }
    });

    test('un equipo sin cliente da una OT de origen directo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.equal(r.body.origen, 'directo');
    });

    test('la migracion 024 rellena el estado de los equipos con una orden abierta y se puede repetir', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        await otDeEquipo(equipo.id, 'en_terreno');
        // un equipo con orden abierta que sigue operativo (como estaba antes de la migracion)
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: null });
        const sql = require('fs').readFileSync(require('path').join(__dirname, '../../db/migrations/024_estado_equipo_origen.sql'), 'utf8');
        for (let i = 0; i < 2; i++) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('COMMIT');
            } finally {
                client.release();
            }
        }
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'en_mantencion', estado_origen: 'ot' });
    });
});

describe('bloque 4a: descuadres de inventario, conteo y traspaso', () => {
    const { randomUUID } = require('node:crypto');

    const stockEn = async (ubicacionId, insumoId) => {
        const r = await pool.query('SELECT cantidad FROM stock_ubicacion WHERE ubicacion_id = $1 AND insumo_id = $2', [ubicacionId, insumoId]);
        return r.rows[0] ? Number(r.rows[0].cantidad) : 0;
    };
    const stockActual = async (insumoId) => Number((await pool.query('SELECT stock_actual FROM insumos WHERE id = $1', [insumoId])).rows[0].stock_actual);
    const sumaUbicaciones = async (insumoId) =>
        Number((await pool.query('SELECT COALESCE(SUM(cantidad), 0) AS s FROM stock_ubicacion WHERE insumo_id = $1', [insumoId])).rows[0].s);
    const bodegaId = async () => (await pool.query("SELECT id FROM ubicaciones_stock WHERE tipo = 'bodega' ORDER BY id LIMIT 1")).rows[0].id;
    /** Deja una existencia negativa por la via real: un consumo de un repuesto que el furgon no tenia. */
    const dejarNegativo = async (ubicacionId, insumoId, cantidad) => {
        await pool.query(
            `INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad) VALUES ($1, $2, $3)
             ON CONFLICT (ubicacion_id, insumo_id) DO UPDATE SET cantidad = EXCLUDED.cantidad`, [ubicacionId, insumoId, -cantidad]);
        await pool.query(
            `INSERT INTO movimientos_insumo (insumo_id, cantidad, tipo, ubicacion_origen_id, descripcion)
             VALUES ($1, $2, 'salida', $3, 'consumo sin stock de prueba')`, [insumoId, cantidad, ubicacionId]);
        await pool.query('UPDATE insumos SET stock_actual = (SELECT COALESCE(SUM(cantidad), 0) FROM stock_ubicacion WHERE insumo_id = $1) WHERE id = $1', [insumoId]);
    };
    const descuadres = async (rol = 'administrativo') => (await pedir('GET', '/api/insumos/descuadres', rol)).body;
    const filaDe = (lista, ubicacionId, insumoId) => lista.find((f) => f.ubicacion_id === ubicacionId && f.insumo_id === insumoId);
    const ajustar = (cuerpo, rol = 'administrativo') => pedir('POST', '/api/insumos/ajuste', rol, cuerpo);

    test('los negativos se calculan por ubicacion y traen su origen', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgonA = await crearFurgonDePrueba();
        const furgonB = await crearFurgonDePrueba();
        await dejarNegativo(furgonA, insumo, 3);
        const lista = await descuadres();
        const fila = filaDe(lista, furgonA, insumo);
        assert.ok(fila, 'el furgon A en -3 aparece');
        assert.equal(fila.cantidad, -3);
        assert.equal(fila.ubicacion_tipo, 'furgon');
        assert.ok(fila.negativo_desde, 'dice desde cuando');
        assert.ok(fila.ultimo_movimiento_at);
        assert.equal(fila.sin_origen, false);
        assert.ok(Number.isInteger(fila.dias) && fila.dias >= 0);
        assert.equal(filaDe(lista, furgonB, insumo), undefined, 'el furgon B no aparece');
        assert.equal(filaDe(lista, await bodegaId(), insumo), undefined, 'la bodega no aparece');
        assert.equal((await descuadres('gerente')).length, lista.length, 'el gerente tambien lo ve');
        assert.equal((await pedir('GET', '/api/insumos/descuadres', 'mecanico')).status, 403);
    });

    test('el mismo insumo negativo en dos furgones da dos filas', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const a = await crearFurgonDePrueba();
        const b = await crearFurgonDePrueba();
        await dejarNegativo(a, insumo, 2);
        await dejarNegativo(b, insumo, 5);
        const lista = (await descuadres()).filter((f) => f.insumo_id === insumo);
        assert.equal(lista.length, 2);
        assert.equal(lista[0].ubicacion_id, b, 'ordenadas por la mas negativa primero');
    });

    test('un negativo sin movimientos que lo expliquen queda como sin origen', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await pool.query('INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad) VALUES ($1, $2, -4)', [furgon, insumo]);
        const fila = filaDe(await descuadres(), furgon, insumo);
        assert.equal(fila.sin_origen, true);
        assert.equal(fila.negativo_desde, null);
        assert.equal(fila.dias, null);
    });

    test('traspasar desde bodega deja el furgon en 0, lo saca de la lista y mantiene el total', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const r = await pedir('POST', '/api/insumos/transferencia', 'administrativo', {
            insumo_id: insumo, cantidad: 3, ubicacion_destino_id: furgon, motivo_codigo: 'traspaso_no_registrado', uuid_cliente: randomUUID(),
        });
        assert.equal(r.status, 201);
        assert.equal(await stockEn(furgon, insumo), 0);
        assert.equal(filaDe(await descuadres(), furgon, insumo), undefined);
        assert.equal(await stockActual(insumo), await sumaUbicaciones(insumo));
        const mov = await pool.query(
            `SELECT motivo_codigo FROM movimientos_insumo WHERE insumo_id = $1 AND ubicacion_destino_id = $2 AND tipo = 'salida'`, [insumo, furgon]);
        assert.equal(mov.rows[0].motivo_codigo, 'traspaso_no_registrado');
    });

    test('traspaso: si la bodega no alcanza responde 400 sin cambios', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(2);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 5);
        const r = await pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 5, ubicacion_destino_id: furgon });
        assert.equal(r.status, 400);
        assert.equal(await stockEn(furgon, insumo), -5);
        assert.equal(await stockBodega(insumo), 2);
    });

    test('traspaso: el destino debe existir, estar activo y ser un furgon; el motivo debe ser de la lista', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(5);
        const bodega = await bodegaId();
        const inactivo = await crearFurgonDePrueba();
        await pool.query('UPDATE ubicaciones_stock SET activa = false WHERE id = $1', [inactivo]);
        const activo = await crearFurgonDePrueba();
        for (const destino of [99999999, inactivo, bodega]) {
            const r = await pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: destino });
            assert.equal(r.status, 400, `destino ${destino}`);
        }
        const motivoMalo = await pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: activo, motivo_codigo: 'inventado' });
        assert.equal(motivoMalo.status, 400);
        assert.equal(await stockBodega(insumo), 5, 'nada cambio');
        const bien = await pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: activo });
        assert.equal(bien.status, 201);
    });

    test('conteo: contar 1 sobre -3 genera un ajuste de +4 con su motivo y saca el caso de la lista', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const r = await ajustar({
            ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: -3,
            motivo_codigo: 'diferencia_conteo', nota: 'conteo de prueba', uuid_cliente: randomUUID(),
        });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.delta, 4);
        assert.equal(await stockEn(furgon, insumo), 1);
        assert.equal(await stockActual(insumo), await sumaUbicaciones(insumo));
        assert.equal(filaDe(await descuadres(), furgon, insumo), undefined);
        const mov = (await pool.query(`SELECT * FROM movimientos_insumo WHERE id = $1`, [r.body.movimiento_id])).rows[0];
        assert.equal(mov.tipo, 'ajuste');
        assert.equal(Number(mov.cantidad), 4);
        assert.equal(mov.ubicacion_destino_id, furgon);
        assert.equal(mov.ubicacion_origen_id, null);
        assert.equal(mov.motivo_codigo, 'diferencia_conteo');
        assert.equal(mov.descripcion, 'conteo de prueba');
    });

    test('conteo menor que el sistema resta, y contar lo mismo no genera movimiento', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const bodega = await bodegaId();
        const antes = await stockEn(bodega, insumo);
        const igual = await ajustar({ ubicacion_id: bodega, insumo_id: insumo, cantidad_contada: antes, cantidad_esperada: antes, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() });
        assert.equal(igual.status, 200);
        assert.equal(igual.body.sin_cambios, true);
        const cero = (await pool.query('SELECT cantidad, tipo, motivo_codigo FROM movimientos_insumo WHERE id = $1', [igual.body.movimiento_id])).rows[0];
        assert.equal(Number(cero.cantidad), 0, 'queda constancia del conteo, con cantidad 0');
        assert.equal(cero.tipo, 'ajuste');
        assert.equal(await stockEn(bodega, insumo), antes, 'y no mueve stock');
        const menos = await ajustar({ ubicacion_id: bodega, insumo_id: insumo, cantidad_contada: antes - 2, cantidad_esperada: antes, motivo_codigo: 'perdida_robo', uuid_cliente: randomUUID() });
        assert.equal(menos.status, 201);
        assert.equal(menos.body.delta, -2);
        assert.equal(await stockEn(bodega, insumo), antes - 2);
        const mov = (await pool.query('SELECT ubicacion_origen_id, ubicacion_destino_id FROM movimientos_insumo WHERE id = $1', [menos.body.movimiento_id])).rows[0];
        assert.equal(mov.ubicacion_origen_id, bodega);
        assert.equal(mov.ubicacion_destino_id, null);
    });

    test('conteo con la cantidad esperada desactualizada da 409 y no cambia nada', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const r = await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: -2, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() });
        assert.equal(r.status, 409);
        assert.equal(await stockEn(furgon, insumo), -3);
        assert.equal((await pool.query("SELECT 1 FROM movimientos_insumo WHERE insumo_id = $1 AND tipo = 'ajuste'", [insumo])).rows.length, 0);
    });

    test('conteo: validaciones, roles y ubicaciones', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        const inactivo = await crearFurgonDePrueba();
        await pool.query('UPDATE ubicaciones_stock SET activa = false WHERE id = $1', [inactivo]);
        const valido = { ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 2, cantidad_esperada: 0, motivo_codigo: 'compra_no_ingresada' };
        const casos = [
            [{ ...valido }, 400, 'sin uuid_cliente'],
            [{ ...valido, uuid_cliente: 'no-es-uuid' }, 400, 'uuid invalido'],
            [{ ...valido, uuid_cliente: randomUUID(), motivo_codigo: 'inventado' }, 400, 'motivo fuera de la lista'],
            [{ ...valido, uuid_cliente: randomUUID(), motivo_codigo: undefined }, 400, 'sin motivo'],
            [{ ...valido, uuid_cliente: randomUUID(), cantidad_contada: -1 }, 400, 'contada negativa'],
            [{ ...valido, uuid_cliente: randomUUID(), cantidad_contada: 'abc' }, 400, 'contada no numerica'],
            [{ ...valido, uuid_cliente: randomUUID(), cantidad_esperada: undefined }, 400, 'sin esperada'],
            [{ ...valido, uuid_cliente: randomUUID(), ubicacion_id: inactivo }, 400, 'ubicacion inactiva'],
            [{ ...valido, uuid_cliente: randomUUID(), ubicacion_id: 99999999 }, 400, 'ubicacion inexistente'],
            [{ ...valido, uuid_cliente: randomUUID(), insumo_id: 99999999 }, 404, 'insumo inexistente'],
            [{ ...valido, uuid_cliente: randomUUID(), nota: 'x'.repeat(501) }, 400, 'nota larga'],
        ];
        for (const [cuerpo, estado, nombre] of casos) {
            assert.equal((await ajustar(cuerpo)).status, estado, nombre);
        }
        assert.equal(await stockEn(furgon, insumo), 0, 'ningun rechazo cambio el stock');
        assert.equal((await ajustar({ ...valido, uuid_cliente: randomUUID() }, 'mecanico')).status, 403);
        assert.equal((await ajustar({ ...valido, uuid_cliente: randomUUID() }, 'gerente')).status, 403, 'el gerente solo lee');
        assert.equal((await ajustar({ ...valido, uuid_cliente: randomUUID() }, 'cliente')).status, 403);
        assert.equal((await ajustar({ ...valido, uuid_cliente: randomUUID() })).status, 201);
    });

    test('conteo idempotente: el mismo uuid dos veces deja un solo movimiento y no da 409', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const cuerpo = { ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: -3, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() };
        const primera = await ajustar(cuerpo);
        assert.equal(primera.status, 201);
        // el reintento llega con la misma cantidad esperada, que ya no coincide con el stock: debe responder 200
        const segunda = await ajustar(cuerpo);
        assert.equal(segunda.status, 200);
        assert.equal(segunda.body.ya_registrada, true);
        assert.equal(segunda.body.movimiento_id, primera.body.movimiento_id);
        assert.equal(await stockEn(furgon, insumo), 1);
        assert.equal((await pool.query("SELECT 1 FROM movimientos_insumo WHERE insumo_id = $1 AND tipo = 'ajuste'", [insumo])).rows.length, 1);
    });

    test('conteo idempotente con dos llamadas simultaneas: un solo movimiento', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 3; vuelta++) {
            const insumo = await crearInsumoConStock(10);
            const furgon = await crearFurgonDePrueba();
            await dejarNegativo(furgon, insumo, 3);
            const cuerpo = { ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: -3, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() };
            const [a, b] = await Promise.all([ajustar(cuerpo), ajustar(cuerpo)]);
            const estados = [a.status, b.status].sort();
            assert.ok(estados[0] === 200 || estados[0] === 201, JSON.stringify([a.body, b.body]));
            assert.ok(estados.every((e) => e === 200 || e === 201), JSON.stringify([a.status, b.status, a.body, b.body]));
            assert.equal((await pool.query("SELECT 1 FROM movimientos_insumo WHERE insumo_id = $1 AND tipo = 'ajuste'", [insumo])).rows.length, 1);
            assert.equal(await stockEn(furgon, insumo), 1);
        }
    });

    test('un uuid ya usado por otro movimiento no se acepta como conteo propio', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        const uuid = randomUUID();
        // el mecanico necesita un furgon activo (vehiculo activo + ubicacion activa); si la semilla no lo trae, se crea
        let vehiculoCreado = null;
        let ubicacionCreada = null;
        let vehiculoOriginal = null;
        let ubicacionOriginal = null;
        try {
            let vehiculo = (await pool.query('SELECT id, activo FROM vehiculos WHERE usuario_id = $1', [datos.mecanicoId])).rows[0];
            if (!vehiculo) {
                vehiculo = (await pool.query(
                    `INSERT INTO vehiculos (patente, marca, modelo, usuario_id) VALUES ($1, 'Ford', 'Transit', $2) RETURNING id, activo`,
                    [`T${crypto.randomUUID().slice(0, 6).toUpperCase()}`, datos.mecanicoId])).rows[0];
                vehiculoCreado = vehiculo.id;
            } else if (!vehiculo.activo) {
                vehiculoOriginal = vehiculo.id;
                await pool.query('UPDATE vehiculos SET activo = true WHERE id = $1', [vehiculo.id]);
            }
            const ubicacion = (await pool.query('SELECT id, activa FROM ubicaciones_stock WHERE vehiculo_id = $1', [vehiculo.id])).rows[0];
            if (!ubicacion) {
                ubicacionCreada = (await pool.query(
                    `INSERT INTO ubicaciones_stock (nombre, tipo, vehiculo_id) VALUES ($1, 'furgon', $2) RETURNING id`,
                    [`Furgon mecanico de prueba ${crypto.randomUUID()}`, vehiculo.id])).rows[0].id;
            } else if (!ubicacion.activa) {
                ubicacionOriginal = ubicacion.id;
                await pool.query('UPDATE ubicaciones_stock SET activa = true WHERE id = $1', [ubicacion.id]);
            }
            // la transferencia del mecanico toma el uuid (el stock sale de la bodega, que tiene 10)
            const tr = await pedir('POST', '/api/insumos/transferencia', 'mecanico', { insumo_id: insumo, cantidad: 1, uuid_cliente: uuid });
            assert.equal(tr.status, 201, JSON.stringify(tr.body));
            const r = await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: 0, motivo_codigo: 'diferencia_conteo', uuid_cliente: uuid });
            assert.equal(r.status, 409);
            assert.equal(await stockEn(furgon, insumo), 0);
        } finally {
            // los movimientos y el stock del insumo apuntan a la ubicacion: salen antes de borrarla
            if (ubicacionCreada) {
                await pool.query('DELETE FROM movimientos_insumo WHERE insumo_id = $1', [insumo]);
                await pool.query('DELETE FROM stock_ubicacion WHERE ubicacion_id = $1', [ubicacionCreada]);
                await pool.query('DELETE FROM ubicaciones_stock WHERE id = $1', [ubicacionCreada]);
            }
            if (ubicacionOriginal) await pool.query('UPDATE ubicaciones_stock SET activa = false WHERE id = $1', [ubicacionOriginal]);
            if (vehiculoCreado) await pool.query('DELETE FROM vehiculos WHERE id = $1', [vehiculoCreado]);
            if (vehiculoOriginal) await pool.query('UPDATE vehiculos SET activo = false WHERE id = $1', [vehiculoOriginal]);
        }
    });

    test('concurrencia: movimientos en paralelo sobre dos ubicaciones del mismo insumo dejan stock_actual igual a la suma', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 3; vuelta++) {
            const insumo = await crearInsumoConStock(100);
            const a = await crearFurgonDePrueba();
            const b = await crearFurgonDePrueba();
            const trabajos = [];
            for (let i = 0; i < 4; i++) {
                trabajos.push(pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: i % 2 ? a : b }));
                trabajos.push(ajustar({ ubicacion_id: i % 2 ? a : b, insumo_id: insumo, cantidad_contada: 0, cantidad_esperada: 0, motivo_codigo: 'error_registro', uuid_cliente: randomUUID() }));
            }
            const resultados = await Promise.all(trabajos);
            for (const r of resultados) assert.ok([200, 201, 409].includes(r.status), `estado inesperado ${r.status} ${JSON.stringify(r.body)}`);
            assert.equal(await stockActual(insumo), await sumaUbicaciones(insumo), 'stock_actual es la suma de las ubicaciones');
        }
    });

    test('un conteo en paralelo con un consumo del mismo furgon termina coherente', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const ot = await crearOt();
        const cuerpoConteo = { ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: -3, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() };
        const [conteo] = await Promise.all([
            ajustar(cuerpoConteo),
            pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { insumo_id: insumo, cantidad: 1, descripcion: 'consumo de prueba' }),
        ]);
        assert.ok([201, 409].includes(conteo.status), String(conteo.status));
        assert.equal(await stockActual(insumo), await sumaUbicaciones(insumo));
    });

    test('ver movimientos: filtros por ubicacion e insumo, y el ajuste trae su motivo', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const otro = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 2);
        await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 0, cantidad_esperada: -2, motivo_codigo: 'danio_merma', uuid_cliente: randomUUID() });
        const filas = (await pedir('GET', `/api/insumos/movimientos?ubicacion_id=${furgon}&insumo_id=${insumo}`, 'administrativo')).body;
        const lista = Array.isArray(filas) ? filas : filas.items || filas.datos || filas.data;
        assert.ok(Array.isArray(lista), JSON.stringify(filas).slice(0, 200));
        assert.equal(lista.length, 2, 'el consumo sin stock y el ajuste');
        assert.ok(lista.every((m) => m.insumo_id === insumo));
        assert.ok(lista.some((m) => m.tipo === 'ajuste' && m.motivo_codigo === 'danio_merma'));
        const soloOtro = (await pedir('GET', `/api/insumos/movimientos?insumo_id=${otro}&ubicacion_id=${furgon}`, 'gerente')).body;
        assert.equal((Array.isArray(soloOtro) ? soloOtro : soloOtro.items || soloOtro.datos || soloOtro.data).length, 0);
        assert.equal((await pedir('GET', '/api/insumos/movimientos?insumo_id=abc', 'administrativo')).status, 400);
        assert.equal((await pedir('GET', '/api/insumos/movimientos', 'mecanico')).status, 403);
    });

    test('la lista de motivos sale del servidor, solo para administrativo y gerente', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', '/api/insumos/motivos-ajuste', 'gerente');
        assert.equal(r.status, 200);
        assert.equal(r.body.length, 5, 'solo los motivos validos para un conteo');
        assert.ok(!r.body.some((m) => m.codigo === 'traspaso_no_registrado'));
        assert.ok(r.body.every((m) => m.codigo && m.nombre));
        assert.equal((await pedir('GET', '/api/insumos/motivos-ajuste', 'mecanico')).status, 403);
    });

    test('el conteo no acepta traspaso_no_registrado: no crea stock de la nada', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const r = await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 0, cantidad_esperada: -3, motivo_codigo: 'traspaso_no_registrado', uuid_cliente: randomUUID() });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /traspaso/);
        assert.equal(await stockEn(furgon, insumo), -3);
        assert.equal(await stockBodega(insumo), 10, 'la bodega no se toco');
    });

    test('el conteo rechaza cantidades con formato raro o que desbordan la columna', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        const base = { ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: 0, motivo_codigo: 'diferencia_conteo' };
        for (const [campo, valor] of [['cantidad_contada', true], ['cantidad_contada', [5]], ['cantidad_contada', '0x10'], ['cantidad_contada', 1e12],
            ['cantidad_contada', '10000000000'], ['cantidad_esperada', true], ['cantidad_esperada', [0]], ['cantidad_esperada', '1e3']]) {
            const r = await ajustar({ ...base, [campo]: valor, uuid_cliente: randomUUID() });
            assert.equal(r.status, 400, `${campo}=${JSON.stringify(valor)}`);
        }
        assert.equal(await stockEn(furgon, insumo), 0);
        assert.equal((await ajustar({ ...base, cantidad_contada: '2.50', uuid_cliente: randomUUID() })).status, 201, 'un decimal como texto si');
    });

    test('el reintento de un conteo con delta 0 es idempotente y deja un solo registro', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const bodega = await bodegaId();
        const actual = await stockEn(bodega, insumo);
        const cuerpo = { ubicacion_id: bodega, insumo_id: insumo, cantidad_contada: actual, cantidad_esperada: actual, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() };
        const a = await ajustar(cuerpo);
        const b = await ajustar(cuerpo);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.equal(b.body.ya_registrada, true);
        assert.equal((await pool.query("SELECT 1 FROM movimientos_insumo WHERE insumo_id = $1 AND tipo = 'ajuste'", [insumo])).rows.length, 1);
    });

    test('un uuid ya usado en otro insumo o en otra ubicacion no se acepta como el mismo conteo', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const otro = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        const otroFurgon = await crearFurgonDePrueba();
        const uuid = randomUUID();
        const primero = await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: 0, motivo_codigo: 'compra_no_ingresada', uuid_cliente: uuid });
        assert.equal(primero.status, 201);
        const otroInsumo = await ajustar({ ubicacion_id: furgon, insumo_id: otro, cantidad_contada: 1, cantidad_esperada: 0, motivo_codigo: 'compra_no_ingresada', uuid_cliente: uuid });
        assert.equal(otroInsumo.status, 409);
        const otraUbicacion = await ajustar({ ubicacion_id: otroFurgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: 0, motivo_codigo: 'compra_no_ingresada', uuid_cliente: uuid });
        assert.equal(otraUbicacion.status, 409);
        assert.equal(await stockEn(otroFurgon, insumo), 0);
        assert.equal(await stockEn(furgon, otro), 0);
        assert.equal((await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: 0, motivo_codigo: 'compra_no_ingresada', uuid_cliente: uuid })).status, 200, 'el mismo conteo si');
    });

    test('transferencia: dos reintentos simultaneos con el mismo uuid dan 200 ya_registrada, no 400', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 3; vuelta++) {
            // la bodega alcanza justo para UNA carga: si el segundo reintento validara contra la bodega ya descontada daria 400
            const insumo = await crearInsumoConStock(3);
            const furgon = await crearFurgonDePrueba();
            const cuerpo = { insumo_id: insumo, cantidad: 3, ubicacion_destino_id: furgon, uuid_cliente: randomUUID() };
            const [a, b] = await Promise.all([
                pedir('POST', '/api/insumos/transferencia', 'administrativo', cuerpo),
                pedir('POST', '/api/insumos/transferencia', 'administrativo', cuerpo),
            ]);
            assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.body, b.body]));
            assert.equal(await stockEn(furgon, insumo), 3);
            assert.equal(await stockBodega(insumo), 0);
            assert.equal((await pool.query("SELECT 1 FROM movimientos_insumo WHERE insumo_id = $1 AND tipo = 'salida' AND ubicacion_destino_id = $2", [insumo, furgon])).rows.length, 1);
        }
    });

    test('transferencia: ubicacion_destino_id con formato raro da 400', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(5);
        for (const destino of ['abc', '1; DROP TABLE x', -1, 0.5, true, [1], {}, '0']) {
            const r = await pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: destino });
            assert.equal(r.status, 400, JSON.stringify(destino));
        }
        assert.equal(await stockBodega(insumo), 5);
    });

    test('los movimientos de un conteo y de una transferencia llevan la hora real, en orden', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 2, ubicacion_destino_id: furgon });
        await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 5, cantidad_esperada: 2, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() });
        const r = await pool.query('SELECT tipo, created_at FROM movimientos_insumo WHERE insumo_id = $1 AND ubicacion_destino_id = $2 ORDER BY id', [insumo, furgon]);
        assert.equal(r.rows.length, 2);
        assert.ok(r.rows[0].created_at < r.rows[1].created_at, 'el conteo es posterior a la transferencia');
    });

    test('/descuadres responde coherente aunque se muevan existencias al mismo tiempo', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(50);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const trabajos = [];
        for (let i = 0; i < 4; i++) {
            trabajos.push(pedir('GET', '/api/insumos/descuadres', 'administrativo'));
            trabajos.push(pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: furgon }));
        }
        const resultados = await Promise.all(trabajos);
        for (const r of resultados.filter((x) => Array.isArray(x.body))) {
            assert.equal(r.status, 200);
            const fila = filaDe(r.body, furgon, insumo);
            if (fila) assert.ok(fila.negativo_desde || fila.sin_origen, 'cada caso trae su fecha o su aviso');
        }
    });
});

describe('bloque 4 (parte B): documentos del equipo por rol y cliente', () => {
    const esc = {};
    const clave = (d) => `${d.tipo}:${d.id}`;
    const tokenCliente = tokenClienteDe(987654);


    const guia = async (tipo, fecha, clienteId, extra = {}) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id, created_at)
         VALUES ($1, $2::tipo_guia, $3, $4, $5, COALESCE($6, now())) RETURNING id`,
        [esc.equipo.id, tipo, extra.sinDocumento ? null : `guias/${crypto.randomUUID()}.pdf`, fecha, clienteId, extra.creada || null])).rows[0].id;

    before(async () => {
        if (!HABILITADO) return;
        const nuevoCliente = async (nombre) => (await pool.query(
            "INSERT INTO clientes (nombre, email) VALUES ($1, 'doc@gomaq.test') RETURNING id", [`${nombre} ${crypto.randomUUID().slice(0, 6)}`])).rows[0].id;
        esc.acsa = await nuevoCliente('ACSA');
        esc.prize = await nuevoCliente('Prize');
        esc.servinut = await nuevoCliente('Servinut');
        esc.otro = await nuevoCliente('Sin documentos');
        esc.equipo = await crearEquipo(null);

        // arriendo 1: ACSA (despacho, OT, recepcion, factura del periodo)
        esc.g1 = await guia('despacho', '2026-01-02T09:00:00-03:00', esc.acsa);
        esc.ot1 = (await pool.query(
            "INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo, valorizacion) VALUES ($1, $2, 'finalizada', 'Revision ACSA', 777000) RETURNING id",
            [esc.equipo.id, esc.acsa])).rows[0].id;
        datos.ordenes.push(esc.ot1);
        esc.r1 = await guia('recepcion', '2026-01-20T10:00:00-03:00', esc.acsa);
        esc.f1 = (await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, cliente_id, folio, archivo_url, monto)
             VALUES ($1, $2, '2026-01-02', '2026-01-20', $3, 'D-1', 'facturas/acsa1.pdf', 100000) RETURNING id`,
            [esc.equipo.id, esc.g1, esc.acsa])).rows[0].id;
        // arriendo 2: Prize; la factura se inserta como el servidor anterior, solo con la recepcion (trigger de la 023)
        esc.g2 = await guia('despacho', '2026-02-02T09:00:00-03:00', esc.prize);
        esc.r2 = await guia('recepcion', '2026-02-10T10:00:00-03:00', esc.prize);
        esc.f2 = (await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url, monto) VALUES ($1, $2, 'D-2', 'facturas/prize.pdf', 90000) RETURNING id`,
            [esc.equipo.id, esc.r2])).rows[0].id;
        // una OT de taller entre Prize y Servinut, sin cliente
        esc.ot0 = (await pool.query(
            "INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo) VALUES ($1, NULL, 'finalizada', 'Taller sin cliente') RETURNING id",
            [esc.equipo.id])).rows[0].id;
        datos.ordenes.push(esc.ot0);
        // arriendo 3: Servinut, con una guia sin documento
        esc.g3 = await guia('despacho', '2026-03-02T09:00:00-03:00', esc.servinut, { sinDocumento: true });
        esc.r3 = await guia('recepcion', '2026-03-12T10:00:00-03:00', esc.servinut);
        // arriendo 4: ACSA otra vez, vigente hoy
        esc.g4 = await guia('despacho', '2026-04-02T09:00:00-03:00', esc.acsa);
        // documentos antiguos sin cliente (guia y factura) y una guia de ACSA anterior a la migracion 010
        esc.gNull = await guia('despacho', '2025-12-01T09:00:00-03:00', null);
        esc.fNull = (await pool.query(
            `INSERT INTO facturas (maquinaria_id, folio, archivo_url) VALUES ($1, 'D-NULL', 'facturas/sin-cliente.pdf') RETURNING id`,
            [esc.equipo.id])).rows[0].id;
        esc.gVieja = await guia('despacho', '2025-06-01T09:00:00-03:00', esc.acsa, { creada: '2000-01-01T00:00:00Z' });
    });

    after(async () => {
        if (!HABILITADO || !esc.equipo) return;
        // los clientes de prueba se borran aca: antes hay que soltar lo que los referencia
        await pool.query('DELETE FROM facturas WHERE maquinaria_id = $1', [esc.equipo.id]);
        await pool.query('DELETE FROM guias WHERE maquinaria_id = $1', [esc.equipo.id]);
        await purgarOrdenes([esc.ot0, esc.ot1]);
        await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [[esc.acsa, esc.prize, esc.servinut, esc.otro]]);
    });

    const conjunto = (r) => new Set(r.body.documentos.map(clave));
    const esperado = (...pares) => new Set(pares);

    test('cada cliente ve exactamente los documentos de sus arriendos, no los del equipo completo', async (t) => {
        if (!requiereBase(t)) return;
        const acsa = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.acsa));
        assert.equal(acsa.status, 200);
        assert.deepEqual(conjunto(acsa), esperado(
            `guia_despacho:${esc.g1}`, `guia_recepcion:${esc.r1}`, `orden_trabajo:${esc.ot1}`, `factura:${esc.f1}`, `guia_despacho:${esc.g4}`));
        const prize = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.prize));
        assert.deepEqual(conjunto(prize), esperado(`guia_despacho:${esc.g2}`, `guia_recepcion:${esc.r2}`, `factura:${esc.f2}`));
        const servinut = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.servinut));
        assert.deepEqual(conjunto(servinut), esperado(`guia_despacho:${esc.g3}`, `guia_recepcion:${esc.r3}`));
    });

    test('el trigger de la 023 dejo el cliente en la factura insertada solo con la recepcion', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pool.query('SELECT cliente_id FROM facturas WHERE id = $1', [esc.f2]);
        assert.equal(r.rows[0].cliente_id, esc.prize);
    });

    test('administrativo y gerente ven todo, tambien lo que no tiene cliente, y pueden filtrar por cliente', async (t) => {
        if (!requiereBase(t)) return;
        for (const rol of ['administrativo', 'gerente']) {
            const r = await pedir('GET', `/api/maquinarias/${esc.equipo.id}/documentos`, rol);
            assert.equal(r.status, 200);
            const claves = conjunto(r);
            for (const k of [`guia_despacho:${esc.gNull}`, `factura:${esc.fNull}`, `orden_trabajo:${esc.ot0}`, `guia_despacho:${esc.gVieja}`,
                `factura:${esc.f1}`, `factura:${esc.f2}`, `guia_recepcion:${esc.r3}`, `guia_despacho:${esc.g4}`]) {
                assert.ok(claves.has(k), `${rol} debe ver ${k}`);
            }
            const sinCliente = r.body.documentos.find((d) => clave(d) === `factura:${esc.fNull}`);
            assert.equal(sinCliente.cliente_id, null);
            assert.equal(sinCliente.cliente_nombre, null);
        }
        const filtrado = await pedir('GET', `/api/maquinarias/${esc.equipo.id}/documentos?cliente_id=${esc.prize}`, 'administrativo');
        assert.deepEqual(conjunto(filtrado), esperado(`guia_despacho:${esc.g2}`, `guia_recepcion:${esc.r2}`, `factura:${esc.f2}`));
    });

    test('un cliente no puede ampliar lo que ve con ?cliente_id', async (t) => {
        if (!requiereBase(t)) return;
        const base1 = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.prize));
        const otro = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos?cliente_id=${esc.acsa}`, tokenCliente(esc.prize));
        assert.deepEqual(conjunto(otro), conjunto(base1));
        const nulo = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos?cliente_id=`, tokenCliente(esc.prize));
        assert.deepEqual(conjunto(nulo), conjunto(base1));
    });

    test('la guia anterior a la migracion 010 no se muestra al cliente aunque lleve su cliente_id', async (t) => {
        if (!requiereBase(t)) return;
        const acsa = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.acsa));
        assert.ok(!conjunto(acsa).has(`guia_despacho:${esc.gVieja}`));
        const admin = await pedir('GET', `/api/maquinarias/${esc.equipo.id}/documentos`, 'administrativo');
        assert.ok(conjunto(admin).has(`guia_despacho:${esc.gVieja}`));
    });

    test('permisos y errores: mecanico 403, cliente sin empresa 400, cliente sin documentos 404, equipo inexistente 404, id invalido 400', async (t) => {
        if (!requiereBase(t)) return;
        const ruta = `/api/maquinarias/${esc.equipo.id}/documentos`;
        assert.equal((await pedir('GET', ruta, 'mecanico')).status, 403);
        assert.equal((await pedirConToken(ruta, tokens.cliente)).status, 400, 'cliente sin cliente_id');
        assert.equal((await pedirConToken(ruta, tokenCliente(esc.otro))).status, 404, 'cliente sin documentos de este equipo');
        assert.equal((await pedir('GET', '/api/maquinarias/99999999/documentos', 'administrativo')).status, 404);
        assert.equal((await pedir('GET', '/api/maquinarias/abc/documentos', 'administrativo')).status, 400);
        const sinSesion = await fetch(`${base}${ruta}`);
        assert.equal(sinSesion.status, 401);
    });

    test('la respuesta nunca trae archivo_url ni rutas privadas; usa URLs firmadas y la guia sin documento lleva url nula', async (t) => {
        if (!requiereBase(t)) return;
        for (const [rol, token] of [['cliente', tokenCliente(esc.servinut)], ['admin', tokens.administrativo]]) {
            const r = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, token);
            assert.equal(r.status, 200, rol);
            for (const d of r.body.documentos) {
                assert.equal('archivo_url' in d, false, `${rol}: sin archivo_url`);
                if (d.url) assert.match(d.url, /^https:\/\/firmada\.test\//);
            }
        }
        const sinDoc = (await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.servinut)))
            .body.documentos.find((d) => clave(d) === `guia_despacho:${esc.g3}`);
        assert.equal(sinDoc.sin_documento, true);
        assert.equal(sinDoc.url, null);
    });

    test('el cliente no ve la valorizacion de su orden; el administrativo si', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.acsa));
        const ot = cliente.body.documentos.find((d) => d.tipo === 'orden_trabajo');
        assert.equal(ot.id, esc.ot1);
        assert.equal('valorizacion' in ot, false);
        assert.equal(ot.estado, 'finalizada');
        const admin = await pedir('GET', `/api/maquinarias/${esc.equipo.id}/documentos`, 'administrativo');
        assert.equal(admin.body.documentos.find((d) => d.tipo === 'orden_trabajo' && d.id === esc.ot1).valorizacion, 777000);
    });

    test('ordenados de lo mas nuevo a lo mas antiguo y con el nombre del cliente', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', `/api/maquinarias/${esc.equipo.id}/documentos`, 'administrativo');
        const fechas = r.body.documentos.map((d) => new Date(d.fecha).getTime());
        assert.deepEqual(fechas, [...fechas].sort((a, b) => b - a));
        const acsa = r.body.documentos.find((d) => clave(d) === `guia_despacho:${esc.g4}`);
        assert.match(acsa.cliente_nombre, /^ACSA /);
    });
});

describe('bloque 4 (parte B): documentos del equipo, casos de borde de la revision', () => {
    const esc = {};
    const clave = (d) => `${d.tipo}:${d.id}`;
    const tokenCliente = tokenClienteDe(987655);
    const guia = async (equipoId, tipo, fecha, clienteId, extra = {}) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id, created_at)
         VALUES ($1, $2::tipo_guia, $3, $4, $5, COALESCE($6, now())) RETURNING id`,
        [equipoId, tipo, extra.archivo || `guias/${crypto.randomUUID()}.pdf`, fecha, clienteId, extra.creada || null])).rows[0].id;

    before(async () => {
        if (!HABILITADO) return;
        const nuevoCliente = async (nombre) => (await pool.query(
            "INSERT INTO clientes (nombre) VALUES ($1) RETURNING id", [`${nombre} ${crypto.randomUUID().slice(0, 6)}`])).rows[0].id;
        esc.a = await nuevoCliente('Cliente A');
        esc.b = await nuevoCliente('Cliente B');
        esc.equipo = await crearEquipo(null);
        esc.soloB = await crearEquipo(null);
        // equipo con documentos de A y B
        esc.gA = await guia(esc.equipo.id, 'despacho', '2026-02-01T09:00:00-03:00', esc.a);
        esc.gFalla = await guia(esc.equipo.id, 'recepcion', '2026-02-10T10:00:00-03:00', esc.a, { archivo: 'guias/firma-falla.pdf' });
        // despacho y recepcion anteriores a la migracion 010 (cliente copiado por el relleno)
        esc.dVieja = await guia(esc.equipo.id, 'despacho', '2025-05-01T09:00:00-03:00', esc.a, { creada: '2000-01-01T00:00:00Z' });
        esc.rVieja = await guia(esc.equipo.id, 'recepcion', '2025-05-20T10:00:00-03:00', esc.a, { creada: '2000-01-01T00:00:00Z' });
        // OT de B y factura de A que (por error de datos) apunta a esa OT: A no debe recibir el id de la OT de B
        esc.otB = (await pool.query(
            "INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo) VALUES ($1, $2, 'finalizada', 'OT de B') RETURNING id", [esc.equipo.id, esc.b])).rows[0].id;
        datos.ordenes.push(esc.otB);
        esc.otA = (await pool.query(
            "INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo) VALUES ($1, $2, 'finalizada', 'OT de A') RETURNING id", [esc.equipo.id, esc.a])).rows[0].id;
        datos.ordenes.push(esc.otA);
        // factura de reparacion SIN maquinaria_id: solo llega al equipo por su OT
        esc.fRep = (await pool.query(
            "INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, monto, cliente_id) VALUES ($1, 'R-1', 'facturas/rep.pdf', 55555, $2) RETURNING id",
            [esc.otA, esc.a])).rows[0].id;
        // facturas de arriendo colgadas de guias anteriores a la 010
        // (el despacho primero: el trigger de la 023 no debe dar el mismo despacho a la factura de la recepcion)
        esc.fDesVieja = (await pool.query(
            "INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, folio, archivo_url, cliente_id, monto) VALUES ($1, $2, '2025-05-01', '2025-05-20', 'V-DES', 'facturas/v2.pdf', $3, 1000) RETURNING id",
            [esc.equipo.id, esc.dVieja, esc.a])).rows[0].id;
        esc.fRecVieja = (await pool.query(
            "INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url, cliente_id, monto) VALUES ($1, $2, 'V-REC', 'facturas/v1.pdf', $3, 1000) RETURNING id",
            [esc.equipo.id, esc.rVieja, esc.a])).rows[0].id;
        // factura de A que apunta a la OT de B
        esc.fCruzada = (await pool.query(
            "INSERT INTO facturas (maquinaria_id, orden_trabajo_id, folio, archivo_url, cliente_id, monto) VALUES ($1, $2, 'X-1', 'facturas/x.pdf', $3, 2000) RETURNING id",
            [esc.equipo.id, esc.otB, esc.a])).rows[0].id;
        // equipo donde solo B tiene documentos
        esc.gSoloB = await guia(esc.soloB.id, 'despacho', '2026-03-01T09:00:00-03:00', esc.b);
    });

    after(async () => {
        if (!HABILITADO || !esc.equipo) return;
        await pool.query('DELETE FROM facturas WHERE maquinaria_id = ANY($1) OR orden_trabajo_id = ANY($2)', [[esc.equipo.id, esc.soloB.id], [esc.otA, esc.otB]]);
        await pool.query('DELETE FROM guias WHERE maquinaria_id = ANY($1)', [[esc.equipo.id, esc.soloB.id]]);
        await purgarOrdenes([esc.otA, esc.otB]);
        await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [[esc.a, esc.b]]);
    });

    const ruta = (id = esc.equipo.id, q = '') => `/api/maquinarias/${id}/documentos${q}`;
    const conjunto = (r) => new Set(r.body.documentos.map(clave));

    test('la factura de reparacion sin maquinaria_id llega al equipo por su OT y la ve su cliente', async (t) => {
        if (!requiereBase(t)) return;
        const a = await pedirConToken(ruta(), tokenCliente(esc.a));
        assert.ok(conjunto(a).has(`factura:${esc.fRep}`));
        const b = await pedirConToken(ruta(), tokenCliente(esc.b));
        assert.ok(!conjunto(b).has(`factura:${esc.fRep}`));
    });

    test('las facturas colgadas de una recepcion o de un despacho anteriores a la 010 no se muestran al cliente', async (t) => {
        if (!requiereBase(t)) return;
        const a = await pedirConToken(ruta(), tokenCliente(esc.a));
        for (const k of [`factura:${esc.fRecVieja}`, `factura:${esc.fDesVieja}`, `guia_despacho:${esc.dVieja}`, `guia_recepcion:${esc.rVieja}`]) {
            assert.ok(!conjunto(a).has(k), `el cliente no debe ver ${k}`);
        }
        const admin = await pedir('GET', ruta(), 'administrativo');
        for (const k of [`factura:${esc.fRecVieja}`, `factura:${esc.fDesVieja}`, `guia_despacho:${esc.dVieja}`]) {
            assert.ok(conjunto(admin).has(k), `administrativo ve ${k}`);
        }
    });

    test('sin registro de la migracion 010 el cliente no ve ninguna guia ni factura de guia (falla cerrado)', async (t) => {
        if (!requiereBase(t)) return;
        const original = (await pool.query("SELECT nombre FROM schema_migraciones WHERE nombre LIKE '010%'")).rows[0].nombre;
        try {
            await pool.query("UPDATE schema_migraciones SET nombre = 'x-' || nombre WHERE nombre = $1", [original]);
            const a = await pedirConToken(ruta(), tokenCliente(esc.a));
            assert.equal(a.status, 200);
            assert.ok([...conjunto(a)].every((k) => !k.startsWith('guia_')), 'ninguna guia');
            assert.ok(conjunto(a).has(`orden_trabajo:${esc.otA}`), 'las ordenes siguen visibles');
        } finally {
            await pool.query("UPDATE schema_migraciones SET nombre = $1 WHERE nombre = 'x-' || $1", [original]);
        }
        assert.ok((await pool.query('SELECT 1 FROM schema_migraciones WHERE nombre = $1', [original])).rows.length === 1, 'registro restaurado');
    });

    test('ids fuera de rango o mal formados dan 400 y no 500', async (t) => {
        if (!requiereBase(t)) return;
        for (const id of ['2147483648', '0', '-1', '1e3', '1.5', '99999999999999999999', 'abc']) {
            assert.equal((await pedir('GET', ruta(id), 'administrativo')).status, 400, `id ${id}`);
            assert.equal((await pedirConToken(ruta(id), tokenCliente(esc.a))).status, 400, `id ${id} (cliente)`);
        }
        // un cliente con cliente_id absurdo en el token tambien es 400
        assert.equal((await pedirConToken(ruta(), tokenCliente(2147483648))).status, 400);
    });

    test('?cliente_id invalido o repetido da 400 al administrativo; el cliente lo ignora', async (t) => {
        if (!requiereBase(t)) return;
        for (const q of ['?cliente_id=abc', '?cliente_id=0', '?cliente_id=2147483648', '?cliente_id=1&cliente_id=2', '?cliente_id[]=1']) {
            assert.equal((await pedir('GET', ruta(esc.equipo.id, q), 'administrativo')).status, 400, q);
        }
        assert.equal((await pedir('GET', ruta(esc.equipo.id, '?cliente_id='), 'administrativo')).status, 200, 'vacio = sin filtro');
        const limpio = await pedirConToken(ruta(), tokenCliente(esc.a));
        const raro = await pedirConToken(ruta(esc.equipo.id, '?cliente_id=abc&cliente_id=2'), tokenCliente(esc.a));
        assert.equal(raro.status, 200);
        assert.deepEqual(conjunto(raro), conjunto(limpio));
    });

    test('la respuesta no trae montos ni rutas de archivo', async (t) => {
        if (!requiereBase(t)) return;
        for (const token of [tokenCliente(esc.a), tokens.administrativo]) {
            const r = await pedirConToken(ruta(), token);
            // la ruta privada solo puede aparecer dentro de la URL firmada, nunca como dato propio
            const texto = JSON.stringify(r.body.documentos.map(({ url: _url, ...resto }) => resto));
            assert.ok(!/"monto"/.test(texto), 'sin monto');
            assert.ok(!/archivo_url|facturas\/|guias\//.test(texto), 'sin rutas privadas');
        }
    });

    test('un cliente que pide un equipo donde solo otro tiene documentos recibe el mismo 404 que con un id inexistente', async (t) => {
        if (!requiereBase(t)) return;
        const ajeno = await pedirConToken(ruta(esc.soloB.id), tokenCliente(esc.a));
        const inexistente = await pedirConToken(ruta(99999999), tokenCliente(esc.a));
        assert.equal(ajeno.status, 404);
        assert.equal(inexistente.status, 404);
        assert.deepEqual(ajeno.body, inexistente.body);
        // y B si ve lo suyo del mismo equipo
        const b = await pedirConToken(ruta(esc.soloB.id), tokenCliente(esc.b));
        assert.equal(b.status, 200);
    });

    test('al cliente no se le da el id de una OT que no es de su empresa', async (t) => {
        if (!requiereBase(t)) return;
        const a = await pedirConToken(ruta(), tokenCliente(esc.a));
        const cruzada = a.body.documentos.find((d) => clave(d) === `factura:${esc.fCruzada}`);
        assert.ok(cruzada, 'la factura es de A');
        assert.equal(cruzada.orden_trabajo_id, null);
        const propia = a.body.documentos.find((d) => clave(d) === `factura:${esc.fRep}`);
        assert.equal(propia.orden_trabajo_id, esc.otA);
        const admin = await pedir('GET', ruta(), 'administrativo');
        assert.equal(admin.body.documentos.find((d) => clave(d) === `factura:${esc.fCruzada}`).orden_trabajo_id, esc.otB);
    });

    test('un archivo que no se puede firmar deja ese documento sin enlace y el resto de la lista sigue', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', ruta(), 'administrativo');
        assert.equal(r.status, 200);
        const roto = r.body.documentos.find((d) => clave(d) === `guia_recepcion:${esc.gFalla}`);
        assert.equal(roto.url, null);
        const sano = r.body.documentos.find((d) => clave(d) === `guia_despacho:${esc.gA}`);
        assert.match(sano.url, /^https:\/\/firmada\.test\//);
    });
});

describe('bloque 5 (parte A): guias idempotentes con uuid_cliente', () => {
    /** Envia una guia por la ruta real. Con `pdf` sube un archivo; si no, va sin documento. */
    async function enviarGuia(equipoId, campos, pdf = false) {
        const formulario = new FormData();
        for (const [clave, valor] of Object.entries(campos)) {
            if (valor !== undefined && valor !== null) formulario.append(clave, String(valor));
        }
        if (pdf) formulario.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'g.pdf');
        else formulario.append('sin_documento', 'true');
        const r = await fetch(`${base}/api/maquinarias/${equipoId}/guias`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario,
        });
        let cuerpo = null;
        try { cuerpo = await r.json(); } catch (_) { /* sin cuerpo */ }
        return { status: r.status, body: cuerpo };
    }

    const cuantasGuias = async (uuid) =>
        (await pool.query('SELECT count(*)::int AS n FROM guias WHERE uuid_cliente = $1', [uuid])).rows[0].n;

    test('el mismo uuid dos veces: una sola guia y el equipo no se vuelve a tocar', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const uuid = crypto.randomUUID();
        const primera = await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid });
        assert.equal(primera.status, 201);
        assert.equal(primera.body.uuid_cliente, uuid);
        // alguien mas libera el equipo; el reintento no debe volver a asignarlo
        await pool.query('UPDATE maquinarias SET cliente_id = NULL WHERE id = $1', [equipo.id]);
        const segunda = await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid });
        assert.equal(segunda.status, 200);
        assert.equal(segunda.body.ya_registrada, true);
        assert.equal(segunda.body.id, primera.body.id);
        assert.equal(await cuantasGuias(uuid), 1);
        const maq = await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [equipo.id]);
        assert.equal(maq.rows[0].cliente_id, null, 'el reintento no reaplico el cambio de cliente');
    });

    test('el reintento con PDF no vuelve a subir el archivo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const uuid = crypto.randomUUID();
        const antes = datos.storage.subidos.length;
        assert.equal((await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid }, true)).status, 201);
        assert.equal(datos.storage.subidos.length, antes + 1);
        const reintento = await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid }, true);
        assert.equal(reintento.status, 200);
        assert.equal(reintento.body.falta_documento, false);
        assert.equal(datos.storage.subidos.length, antes + 1, 'el reintento no sube otro PDF');
    });

    test('el mismo uuid con otro equipo o con otro tipo da 409', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const otro = await crearEquipo(null);
        const uuid = crypto.randomUUID();
        assert.equal((await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid })).status, 201);
        assert.equal((await enviarGuia(otro.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid })).status, 409);
        assert.equal((await enviarGuia(equipo.id, { tipo: 'recepcion', uuid_cliente: uuid })).status, 409);
        assert.equal(await cuantasGuias(uuid), 1);
        const maq = await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [otro.id]);
        assert.equal(maq.rows[0].cliente_id, null, 'el 409 no toco el otro equipo');
    });

    test('dos envios simultaneos con el mismo uuid dejan una sola guia', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        for (let vuelta = 0; vuelta < 5; vuelta++) {
            const equipo = await crearEquipo(null);
            const uuid = crypto.randomUUID();
            const envio = () => enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid });
            const [a, b] = await Promise.all([envio(), envio()]);
            assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.body, b.body]));
            assert.equal(a.body.id, b.body.id);
            assert.equal(await cuantasGuias(uuid), 1);
        }
    });

    test('sin uuid el comportamiento es el de siempre: cada envio crea su guia', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const a = await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente });
        const b = await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente });
        assert.equal(a.status, 201);
        assert.equal(b.status, 201);
        assert.notEqual(a.body.id, b.body.id);
        assert.equal(a.body.uuid_cliente, null);
    });

    test('un uuid mal formado da 400 y no crea nada', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        for (const malo of ['no-es-uuid', '123', '0x10', "' OR 1=1 --"]) {
            const r = await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: malo });
            assert.equal(r.status, 400, malo);
        }
        const n = await pool.query('SELECT count(*)::int AS n FROM guias WHERE maquinaria_id = $1', [equipo.id]);
        assert.equal(n.rows[0].n, 0);
    });
});

describe('bloque 5 (parte A): correcciones de la revision experta', () => {
    async function enviar(equipoId, campos, pdf = false) {
        const formulario = new FormData();
        for (const [clave, valor] of Object.entries(campos)) {
            if (valor !== undefined && valor !== null) formulario.append(clave, String(valor));
        }
        if (pdf) formulario.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'g.pdf');
        else formulario.append('sin_documento', 'true');
        const r = await fetch(`${base}/api/maquinarias/${equipoId}/guias`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario,
        });
        let cuerpo = null;
        try { cuerpo = await r.json(); } catch (_) { /* sin cuerpo */ }
        return { status: r.status, body: cuerpo };
    }

    test('un uuid en mayusculas reenviado en minusculas es el mismo envio', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const uuid = crypto.randomUUID();
        const a = await enviar(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid.toUpperCase() });
        assert.equal(a.status, 201);
        const b = await enviar(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid.toLowerCase() });
        assert.equal(b.status, 200);
        assert.equal(b.body.id, a.body.id);
    });

    test('el reintento identico con fecha explicita es 200; si cambia cliente, fallida o fecha es 409', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = (await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 2')).rows.map((c) => c.id);
        const equipo = await crearEquipo(null);
        const uuid = crypto.randomUUID();
        const base1 = { tipo: 'despacho', cliente_id: clientes[0], uuid_cliente: uuid, fecha_hora: '2026-03-10T09:00:00-03:00' };
        const primera = await enviar(equipo.id, base1);
        assert.equal(primera.status, 201);
        assert.equal((await enviar(equipo.id, base1)).status, 200, 'identico');
        // la misma hora escrita con otro formato sigue siendo la misma fecha
        assert.equal((await enviar(equipo.id, { ...base1, fecha_hora: '2026-03-10T12:00:00Z' })).status, 200);
        assert.equal((await enviar(equipo.id, { ...base1, fecha_hora: '2026-03-11T09:00:00-03:00' })).status, 409, 'otra fecha');
        assert.equal((await enviar(equipo.id, { ...base1, fallido: 'true' })).status, 409, 'otra condicion de fallida');
        if (clientes.length > 1) {
            assert.equal((await enviar(equipo.id, { ...base1, cliente_id: clientes[1] })).status, 409, 'otro cliente');
        }
        const n = await pool.query('SELECT count(*)::int AS n FROM guias WHERE uuid_cliente = $1', [uuid]);
        assert.equal(n.rows[0].n, 1);
    });

    test('sin fecha_hora el reintento no compara la fecha (el INSERT usa now())', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const uuid = crypto.randomUUID();
        const campos = { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid };
        assert.equal((await enviar(equipo.id, campos)).status, 201);
        assert.equal((await enviar(equipo.id, campos)).status, 200);
    });

    test('la carrera con PDF no deja archivos huerfanos: todo PDF de mas se borra', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        for (let vuelta = 0; vuelta < 4; vuelta++) {
            const equipo = await crearEquipo(null);
            const uuid = crypto.randomUUID();
            const subidosAntes = datos.storage.subidos.length;
            const borradosAntes = datos.storage.borrados.length;
            const envio = () => enviar(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid }, true);
            const [a, b] = await Promise.all([envio(), envio()]);
            assert.deepEqual([a.status, b.status].sort(), [200, 201]);
            const subidos = datos.storage.subidos.length - subidosAntes;
            const borrados = datos.storage.borrados.length - borradosAntes;
            assert.equal(subidos - borrados, 1, `queda un solo PDF (subidos ${subidos}, borrados ${borrados})`);
            const guia = await pool.query('SELECT archivo_url FROM guias WHERE uuid_cliente = $1', [uuid]);
            assert.ok(!datos.storage.borrados.includes(guia.rows[0].archivo_url), 'el PDF de la guia guardada no se borro');
        }
    });

    test('si falla el SELECT del uuid responde 500 y el servidor sigue vivo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const original = pool.query;
        let fallos = 0;
        pool.query = function (texto, ...resto) {
            if (typeof texto === 'string' && texto.includes('FROM guias WHERE uuid_cliente') && fallos === 0) {
                fallos += 1;
                return Promise.reject(new Error('fallo simulado de la base'));
            }
            return original.call(this, texto, ...resto);
        };
        try {
            const r = await enviar(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: crypto.randomUUID() });
            assert.equal(r.status, 500);
        } finally {
            pool.query = original;
        }
        assert.equal(fallos, 1);
        assert.equal((await enviar(equipo.id, { tipo: 'despacho', cliente_id: cliente })).status, 201, 'el servidor sigue atendiendo');
    });
});

describe('bloque 5 (PR B): correo de la factura editable y cancelacion segura', () => {
    const { sigueVigente } = require('../src/workers/notificaciones');
    const rutaAnularFactura = (ot, factura) => `/api/ordenes-trabajo/${ot}/factura/${factura}/anular`;

    /** OT finalizada con factura cuyo cliente tiene correo. Devuelve { ot, factura, email }. */
    async function otFacturadaConCorreo(folio) {
        const cliente = await pool.query("SELECT id, email FROM clientes WHERE email IS NOT NULL ORDER BY id LIMIT 1");
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        await facturarDirecto(ot, folio);
        const f = (await pool.query(
            'UPDATE facturas SET cliente_id = $2 WHERE orden_trabajo_id = $1 RETURNING id', [ot, cliente.rows[0].id])).rows[0];
        return { ot, factura: f.id, email: cliente.rows[0].email };
    }

    const correosDe = async (facturaId) => (await pool.query(
        `SELECT id, estado, payload, ultimo_error FROM notificaciones_pendientes
         WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1 ORDER BY id`, [String(facturaId)])).rows;

    const limpiar = async (facturaId) => pool.query(
        `DELETE FROM notificaciones_pendientes WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1`, [String(facturaId)]);

    test('la vista previa trae el texto por defecto y el periodo', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await otFacturadaConCorreo('T-5001');
        const r = await pedir('GET', `/api/facturacion/${factura}/vista-previa`, 'administrativo');
        assert.equal(r.status, 200);
        assert.match(r.body.asunto, /Factura folio T-5001/);
        assert.match(r.body.cuerpo, /orden de trabajo/);
        assert.equal(r.body.envio_pendiente, false);
        assert.equal((await pedir('GET', `/api/facturacion/${factura}/vista-previa`, 'gerente')).status, 200);
        assert.equal((await pedir('GET', `/api/facturacion/${factura}/vista-previa`, 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/99999999/vista-previa', 'administrativo')).status, 404);
        assert.equal((await pedir('GET', '/api/facturacion/abc/vista-previa', 'administrativo')).status, 400);
    });

    test('autorizar el envio guarda texto editado, factura_id y los campos antiguos en el payload', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura, email } = await otFacturadaConCorreo('T-5002');
        try {
            const r = await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo',
                { asunto: '  Asunto propio ', cuerpo: 'Hola,\nadjuntamos su factura.' });
            assert.equal(r.status, 200);
            const filas = await correosDe(factura);
            assert.equal(filas.length, 1);
            assert.equal(filas[0].estado, 'pendiente');
            const p = filas[0].payload;
            assert.equal(p.asunto, 'Asunto propio');
            assert.equal(p.cuerpo, 'Hola,\nadjuntamos su factura.');
            assert.equal(p.factura_id, factura);
            assert.equal(p.orden_trabajo_id, ot);
            assert.equal(p.folio, 'T-5002');
            assert.equal(p.tipo, 'factura_emitida');
            const dest = await pool.query('SELECT destinatario FROM notificaciones_pendientes WHERE id = $1', [filas[0].id]);
            assert.equal(dest.rows[0].destinatario, email);
        } finally {
            await limpiar(factura);
        }
    });

    test('sin texto usa el de por defecto y un asunto con salto de linea da 400', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await otFacturadaConCorreo('T-5003');
        try {
            const mala = await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', { asunto: 'Uno\nBcc: x@y.cl' });
            assert.equal(mala.status, 400);
            assert.equal((await correosDe(factura)).length, 0);
            assert.equal((await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {})).status, 200);
            const p = (await correosDe(factura))[0].payload;
            assert.match(p.asunto, /Factura folio T-5003/);
            assert.ok(p.cuerpo.length > 10);
        } finally {
            await limpiar(factura);
        }
    });

    test('un segundo autorizar con el primero pendiente da 409; con dos clics a la vez sale uno solo', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await otFacturadaConCorreo('T-5004');
        try {
            const resultados = await Promise.all([
                pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {}),
                pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {}),
            ]);
            assert.deepEqual(resultados.map((r) => r.status).sort(), [200, 409]);
            assert.equal((await correosDe(factura)).length, 1);
            assert.equal((await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {})).status, 409);
            const vista = await pedir('GET', `/api/facturacion/${factura}/vista-previa`, 'administrativo');
            assert.equal(vista.body.envio_pendiente, true);
        } finally {
            await limpiar(factura);
        }
    });

    test('corregir folio o monto con un envio pendiente da 409', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await otFacturadaConCorreo('T-5005');
        try {
            assert.equal((await pedir('PATCH', `/api/facturacion/${factura}`, 'administrativo', { folio: 'T-5005B' })).status, 200);
            assert.equal((await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {})).status, 200);
            assert.equal((await pedir('PATCH', `/api/facturacion/${factura}`, 'administrativo', { folio: 'T-5005C' })).status, 409);
            const f = await pool.query('SELECT folio FROM facturas WHERE id = $1', [factura]);
            assert.equal(f.rows[0].folio, 'T-5005B');
        } finally {
            await limpiar(factura);
        }
    });

    test('la ruta antigua por orden usa el mismo texto y las mismas reglas', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturadaConCorreo('T-5006');
        try {
            const otra = await crearOt();
            assert.equal((await pedir('POST', `/api/ordenes-trabajo/${otra}/factura/${factura}/autorizar-envio`, 'administrativo', {})).status, 404);
            const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/factura/${factura}/autorizar-envio`, 'administrativo', { asunto: 'Desde la ruta antigua' });
            assert.equal(r.status, 200);
            assert.equal((await correosDe(factura))[0].payload.asunto, 'Desde la ruta antigua');
            assert.equal((await pedir('POST', `/api/ordenes-trabajo/${ot}/factura/${factura}/autorizar-envio`, 'administrativo', {})).status, 409);
        } finally {
            await limpiar(factura);
        }
    });

    test('anular la factura cancela el correo pendiente o en error y autorizar despues da 404', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturadaConCorreo('T-5007');
        try {
            assert.equal((await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {})).status, 200);
            const filas = await correosDe(factura);
            // un correo que ya agoto sus reintentos tambien se cancela
            await pool.query(
                `INSERT INTO notificaciones_pendientes (canal, destinatario, estado, payload) VALUES ('email', 'x@y.cl', 'error', $1)`,
                [JSON.stringify({ tipo: 'factura_emitida', factura_id: factura, folio: 'T-5007' })]);
            const anular = await pedir('POST', rutaAnularFactura(ot, factura), 'administrativo', MOTIVO_VALIDO);
            assert.equal(anular.status, 200);
            const despues = await correosDe(factura);
            assert.equal(despues.length, 2);
            assert.ok(despues.every((c) => c.estado === 'cancelado'), JSON.stringify(despues.map((c) => c.estado)));
            assert.equal(despues[0].id, filas[0].id);
            assert.match(despues[0].ultimo_error, /anulada/);
            assert.equal((await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {})).status, 404);
        } finally {
            await limpiar(factura);
        }
    });

    test('anular cancela tambien los correos antiguos que no llevaban factura_id (por orden y folio)', async (t) => {
        if (!requiereBase(t)) return;
        const { ot, factura } = await otFacturadaConCorreo('T-5008');
        const viejo = await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'x@y.cl', $1) RETURNING id`,
            [JSON.stringify({ tipo: 'factura_emitida', orden_trabajo_id: ot, folio: 'T-5008' })]);
        const ajeno = await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'x@y.cl', $1) RETURNING id`,
            [JSON.stringify({ tipo: 'factura_emitida', orden_trabajo_id: ot, folio: 'OTRO-FOLIO' })]);
        try {
            assert.equal((await pedir('POST', rutaAnularFactura(ot, factura), 'administrativo', MOTIVO_VALIDO)).status, 200);
            const estados = await pool.query('SELECT id, estado FROM notificaciones_pendientes WHERE id = ANY($1)', [[viejo.rows[0].id, ajeno.rows[0].id]]);
            const por = Object.fromEntries(estados.rows.map((x) => [x.id, x.estado]));
            assert.equal(por[viejo.rows[0].id], 'cancelado');
            assert.equal(por[ajeno.rows[0].id], 'pendiente', 'otro folio no se toca');
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = ANY($1)', [[viejo.rows[0].id, ajeno.rows[0].id]]);
        }
    });

    test('anular y autorizar a la vez nunca dejan un correo pendiente de una factura que ya no existe', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 6; vuelta++) {
            const { ot, factura } = await otFacturadaConCorreo(`T-51${vuelta}`);
            try {
                const [autorizar, anular] = await Promise.all([
                    pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {}),
                    pedir('POST', rutaAnularFactura(ot, factura), 'administrativo', MOTIVO_VALIDO),
                ]);
                assert.equal(anular.status, 200, JSON.stringify(anular.body));
                assert.ok([200, 404].includes(autorizar.status), `autorizar dio ${autorizar.status}`);
                const existe = (await pool.query('SELECT 1 FROM facturas WHERE id = $1', [factura])).rows.length;
                assert.equal(existe, 0);
                const pendientes = (await correosDe(factura)).filter((c) => c.estado === 'pendiente');
                assert.equal(pendientes.length, 0, 'ningun correo pendiente de una factura anulada');
            } finally {
                await limpiar(factura);
            }
        }
    });

    test('el worker no envia ni reintenta el correo de una factura anulada', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await otFacturadaConCorreo('T-5009');
        try {
            assert.equal((await pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', {})).status, 200);
            const [correo] = await correosDe(factura);
            // la factura desaparece por una via que no cancela el correo (como la de la version anterior)
            await pool.query('DELETE FROM facturas WHERE id = $1', [factura]);
            const vigente = await sigueVigente({ id: correo.id });
            assert.equal(vigente, false);
            const despues = (await correosDe(factura))[0];
            assert.equal(despues.estado, 'cancelado');
            // ya cancelado: otra revision tampoco lo envia y reintentar no lo revive
            assert.equal(await sigueVigente({ id: correo.id }), false);
            assert.equal((await pedir('POST', `/api/notificaciones/${correo.id}/reintentar`, 'administrativo', {})).status, 404);
        } finally {
            await limpiar(factura);
        }
    });

    test('una notificacion cancelada despues de ser tomada no se envia ni se pisa', async (t) => {
        if (!requiereBase(t)) return;
        const n = await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'x@y.cl', $1) RETURNING id`,
            [JSON.stringify({ tipo: 'otro' })]);
        try {
            assert.equal(await sigueVigente({ id: n.rows[0].id }), true);
            await pool.query("UPDATE notificaciones_pendientes SET estado = 'cancelado' WHERE id = $1", [n.rows[0].id]);
            assert.equal(await sigueVigente({ id: n.rows[0].id }), false);
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = $1', [n.rows[0].id]);
        }
    });
});

describe('bloque 5 (PR B): revision adversarial del correo de la factura', () => {
    const { procesarUna, usarEnvio } = require('../src/workers/notificaciones');

    async function facturaConCorreo(folio) {
        const cliente = await pool.query("SELECT id, email FROM clientes WHERE email IS NOT NULL ORDER BY id LIMIT 1");
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        await facturarDirecto(ot, folio);
        const f = (await pool.query(
            'UPDATE facturas SET cliente_id = $2 WHERE orden_trabajo_id = $1 RETURNING id', [ot, cliente.rows[0].id])).rows[0];
        return { ot, factura: f.id };
    }
    const correos = async (facturaId) => (await pool.query(
        `SELECT id, estado, intentos, payload, ultimo_error, enviado_at FROM notificaciones_pendientes
         WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1 ORDER BY id`, [String(facturaId)])).rows;
    const limpiar = (facturaId) => pool.query(
        `DELETE FROM notificaciones_pendientes WHERE payload->>'tipo' = 'factura_emitida' AND payload->>'factura_id' = $1`, [String(facturaId)]);
    const ponerEnError = (id) => pool.query(
        "UPDATE notificaciones_pendientes SET estado = 'error', intentos = 5, ultimo_error = 'proveedor no configurado' WHERE id = $1", [id]);
    const autorizar = (factura, cuerpo = {}) => pedir('POST', `/api/facturacion/${factura}/autorizar-envio`, 'administrativo', cuerpo);

    test('el asunto rechaza caracteres de control y separadores de linea de Unicode; el cuerpo, los de control salvo salto y tabulacion', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await facturaConCorreo('T-5101');
        try {
            for (const asunto of ['Uno Dos', 'Uno\u0085Dos', 'Uno\u000BDos', 'Uno\u0000Dos', 'Uno Dos', 'Uno\u007FDos', 'Uno\tDos']) {
                const r = await autorizar(factura, { asunto });
                assert.equal(r.status, 400, `asunto ${JSON.stringify(asunto)} dio ${r.status}`);
            }
            for (const cuerpo of ['Hola\u0000mundo', 'Hola\u000Bmundo', 'Hola\u001Bmundo', 'Hola\u007Fmundo']) {
                const r = await autorizar(factura, { cuerpo });
                assert.equal(r.status, 400, `cuerpo ${JSON.stringify(cuerpo)} dio ${r.status}`);
            }
            assert.equal((await correos(factura)).length, 0, 'ningun intento fallido deja un correo');
            const bien = await autorizar(factura, { asunto: 'Asunto normal', cuerpo: 'Linea 1\r\nLinea 2\n\tcon tabulacion' });
            assert.equal(bien.status, 200);
            assert.equal((await correos(factura))[0].payload.cuerpo, 'Linea 1\nLinea 2\n\tcon tabulacion');
        } finally {
            await limpiar(factura);
        }
    });

    test('el folio invalido se rechaza al subir la factura y al corregirla', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        for (const folio of ['F-1\nBcc: x@y.cl', 'F<1>', 'a'.repeat(51), '   ', 'F;1']) {
            const r = await subirFactura(ot, 'administrativo', { folio });
            assert.equal(r.status, 400, `folio ${JSON.stringify(folio)} dio ${r.status}`);
        }
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows.length, 0);
        const ok = await subirFactura(ot, 'administrativo', { folio: ' F-5102/A ' });
        assert.equal(ok.status, 201);
        assert.equal(ok.body.folio, 'F-5102/A', 'el folio se guarda sin espacios sobrantes');
        const id = ok.body.id;
        for (const folio of ['X\nY', 'F<1>', 'a'.repeat(51)]) {
            assert.equal((await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { folio })).status, 400, JSON.stringify(folio));
        }
        assert.equal((await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { folio: 'F-5102/B' })).status, 200);
    });

    test('el traslado de una factura se corrige sin pasarse del monto', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        const ok = await subirFactura(ot, 'administrativo', { folio: 'T-TRAS-1', monto: '100000' });
        assert.equal(ok.status, 201);
        const id = ok.body.id;
        const traslado = async () => Number((await pool.query('SELECT monto_traslado FROM facturas WHERE id = $1', [id])).rows[0].monto_traslado);
        assert.equal(await traslado(), 0, 'sin indicarlo, el traslado vale 0');
        assert.equal((await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { monto_traslado: '20000' })).status, 200);
        assert.equal(await traslado(), 20000);
        for (const malo of ['100001', '-5', '1.5', 'abc']) {
            assert.equal((await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { monto_traslado: malo })).status, 400, malo);
        }
        // bajar el monto por debajo del traslado ya guardado tambien se rechaza
        assert.equal((await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { monto: '10000' })).status, 400);
        assert.equal(await traslado(), 20000, 'un rechazo no cambia nada');
        // otro cambio (folio) no toca el traslado
        assert.equal((await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { folio: 'T-TRAS-2' })).status, 200);
        assert.equal(await traslado(), 20000);
    });

    test('corregir la factura cancela el correo anterior que quedo en error', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await facturaConCorreo('T-5103');
        try {
            assert.equal((await autorizar(factura)).status, 200);
            const [primero] = await correos(factura);
            await ponerEnError(primero.id);
            const r = await pedir('PATCH', `/api/facturacion/${factura}`, 'administrativo', { folio: 'T-5103B' });
            assert.equal(r.status, 200);
            const despues = (await correos(factura))[0];
            assert.equal(despues.estado, 'cancelado');
            assert.equal(despues.ultimo_error, 'Factura corregida');
            // reintentar el correo cancelado no lo revive
            assert.equal((await pedir('POST', `/api/notificaciones/${primero.id}/reintentar`, 'administrativo', {})).status, 404);
        } finally {
            await limpiar(factura);
        }
    });

    test('un correo nuevo reemplaza al anterior que estaba en error', async (t) => {
        if (!requiereBase(t)) return;
        const { factura } = await facturaConCorreo('T-5104');
        try {
            assert.equal((await autorizar(factura)).status, 200);
            const [primero] = await correos(factura);
            await ponerEnError(primero.id);
            assert.equal((await autorizar(factura, { asunto: 'Segundo intento' })).status, 200);
            const filas = await correos(factura);
            assert.equal(filas.length, 2);
            assert.equal(filas[0].estado, 'cancelado');
            assert.equal(filas[0].ultimo_error, 'Reemplazado');
            assert.equal(filas[1].estado, 'pendiente');
            assert.equal(filas[1].payload.asunto, 'Segundo intento');
        } finally {
            await limpiar(factura);
        }
    });

    test('reintentar un correo en error se rechaza si hay otro pendiente, si la factura cambio o si ya no existe', async (t) => {
        if (!requiereBase(t)) return;
        const reintentar = (id) => pedir('POST', `/api/notificaciones/${id}/reintentar`, 'administrativo', {});
        // 1. caso normal: vuelve a la cola
        const a = await facturaConCorreo('T-5105');
        // 2. ya hay otro pendiente de la misma factura
        const b = await facturaConCorreo('T-5106');
        // 3. la factura cambio de folio (por una via que no cancela, como la version anterior)
        const c = await facturaConCorreo('T-5107');
        // 4. la factura ya no existe
        const d = await facturaConCorreo('T-5108');
        try {
            assert.equal((await autorizar(a.factura)).status, 200);
            const [ca] = await correos(a.factura);
            await ponerEnError(ca.id);
            assert.equal((await reintentar(ca.id)).status, 200);
            assert.equal((await correos(a.factura))[0].estado, 'pendiente');

            assert.equal((await autorizar(b.factura)).status, 200);
            const [cb] = await correos(b.factura);
            await ponerEnError(cb.id);
            // otro pendiente de la misma factura, insertado a mano
            await pool.query(
                `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'x@y.cl', $1)`,
                [JSON.stringify({ tipo: 'factura_emitida', factura_id: b.factura, folio: 'T-5106', monto: 100000 })]);
            const rb = await reintentar(cb.id);
            assert.equal(rb.status, 409);
            assert.match(rb.body.error, /otro envío pendiente/);

            assert.equal((await autorizar(c.factura)).status, 200);
            const [cc] = await correos(c.factura);
            await ponerEnError(cc.id);
            await pool.query("UPDATE facturas SET folio = 'T-5107-CORREGIDO' WHERE id = $1", [c.factura]);
            const rc = await reintentar(cc.id);
            assert.equal(rc.status, 409);
            assert.match(rc.body.error, /cambió/);

            assert.equal((await autorizar(d.factura)).status, 200);
            const [cd] = await correos(d.factura);
            await ponerEnError(cd.id);
            await pool.query('DELETE FROM facturas WHERE id = $1', [d.factura]);
            const rd = await reintentar(cd.id);
            assert.equal(rd.status, 409);
            assert.match(rd.body.error, /ya no existe/);
        } finally {
            for (const x of [a, b, c, d]) await limpiar(x.factura);
        }
    });

    test('corregir y autorizar a la vez: el correo nunca lleva un folio distinto del de la factura', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 6; vuelta++) {
            const { factura } = await facturaConCorreo(`T-52${vuelta}`);
            try {
                const [parche, envio] = await Promise.all([
                    pedir('PATCH', `/api/facturacion/${factura}`, 'administrativo', { folio: `T-52${vuelta}-B` }),
                    autorizar(factura),
                ]);
                assert.ok([200, 409].includes(parche.status), `PATCH dio ${parche.status}`);
                assert.equal(envio.status, 200);
                const fila = (await pool.query('SELECT folio FROM facturas WHERE id = $1', [factura])).rows[0];
                const pendientes = (await correos(factura)).filter((c) => c.estado === 'pendiente');
                assert.equal(pendientes.length, 1);
                if (parche.status === 200) {
                    assert.equal(fila.folio, `T-52${vuelta}-B`);
                    // el correo salio despues de la correccion: lleva el folio nuevo
                    assert.equal(pendientes[0].payload.folio, fila.folio);
                } else {
                    // el envio gano: el folio de la factura no cambio y el correo lo lleva
                    assert.equal(pendientes[0].payload.folio, fila.folio);
                }
            } finally {
                await limpiar(factura);
            }
        }
    });

    test('si la anulacion llega despues de salir el correo, la fila cancelada deja constancia del envio', async (t) => {
        if (!requiereBase(t)) return;
        const n = (await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'x@y.cl', $1) RETURNING *`,
            [JSON.stringify({ tipo: 'otro' })])).rows[0];
        try {
            // el proveedor "responde bien", pero mientras tanto otra transaccion cancela la fila
            usarEnvio(async () => {
                await pool.query("UPDATE notificaciones_pendientes SET estado = 'cancelado', ultimo_error = 'Factura anulada' WHERE id = $1", [n.id]);
            });
            await procesarUna(n);
            const fila = (await pool.query('SELECT estado, ultimo_error, enviado_at FROM notificaciones_pendientes WHERE id = $1', [n.id])).rows[0];
            assert.equal(fila.estado, 'cancelado', 'no se pisa a enviado');
            assert.equal(fila.ultimo_error, 'Enviado antes de que la anulación lo alcanzara');
            assert.ok(fila.enviado_at, 'queda la hora del envio');
        } finally {
            usarEnvio(null);
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = $1', [n.id]);
        }
    });

    test('el worker marca enviado una notificacion vigente cuando el proveedor responde bien', async (t) => {
        if (!requiereBase(t)) return;
        const n = (await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'x@y.cl', $1) RETURNING *`,
            [JSON.stringify({ tipo: 'otro' })])).rows[0];
        try {
            usarEnvio(async () => {});
            await procesarUna(n);
            const fila = (await pool.query('SELECT estado, enviado_at FROM notificaciones_pendientes WHERE id = $1', [n.id])).rows[0];
            assert.equal(fila.estado, 'enviado');
            assert.ok(fila.enviado_at);
        } finally {
            usarEnvio(null);
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = $1', [n.id]);
        }
    });
});

describe('bloque 5 (parte C): avisos al mecanico y al gerente', () => {
    const TIPOS = ['ot_asignada', 'ot_reasignada', 'ot_por_valorizar', 'factura_anulada', 'ajuste_inventario'];
    const MARCA = { telefono: '+56911110000', telefonoDos: '+56922220000' };
    let inicio;
    let respaldo;

    /** Avisos nuevos de un tipo desde `inicio`, opcionalmente de una OT. */
    async function avisos(tipo, ordenId = null) {
        const r = await pool.query(
            `SELECT canal, destinatario, payload FROM notificaciones_pendientes
             WHERE created_at >= $1 AND payload->>'tipo' = $2
               AND ($3::int IS NULL OR (payload->>'orden_trabajo_id')::int = $3)
             ORDER BY id`, [inicio, tipo, ordenId]);
        return r.rows;
    }

    // el correo no se toca (el login de las pruebas lo usa): solo el WhatsApp de cada mecanico
    async function contactos(telefonoMecanico, telefonoMecanicoDos) {
        await pool.query('UPDATE usuarios SET telefono_whatsapp = $1 WHERE id = $2', [telefonoMecanico, datos.mecanicoId]);
        await pool.query('UPDATE usuarios SET telefono_whatsapp = $1 WHERE id = $2', [telefonoMecanicoDos, datos.mecanicoDosId]);
    }

    before(async () => {
        if (!HABILITADO) return;
        inicio = new Date(Date.now() - 2000);
        const r = await pool.query(
            "SELECT id, email, telefono_whatsapp FROM usuarios WHERE id = ANY($1) OR email = 'admin@gomaq.test'",
            [[datos.mecanicoId, datos.mecanicoDosId]]);
        respaldo = r.rows;
    });

    after(async () => {
        if (!HABILITADO || !respaldo) return;
        for (const u of respaldo) {
            await pool.query('UPDATE usuarios SET telefono_whatsapp = $1 WHERE id = $2', [u.telefono_whatsapp, u.id]);
        }
        await pool.query(
            `DELETE FROM notificaciones_pendientes WHERE created_at >= $1 AND payload->>'tipo' = ANY($2)`, [inicio, TIPOS]);
    });

    test('asignar avisa al mecanico nuevo por WhatsApp; el doble clic y el mismo tecnico no avisan otra vez', async (t) => {
        if (!requiereBase(t)) return;
        await contactos(MARCA.telefono, MARCA.telefonoDos);
        const ot = await crearOt('asignada', null);
        const asignar = () => pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId });
        assert.equal((await asignar()).status, 200);
        let lista = await avisos('ot_asignada', ot);
        assert.equal(lista.length, 1);
        assert.equal(lista[0].canal, 'whatsapp');
        assert.equal(lista[0].destinatario, MARCA.telefono);
        assert.ok(lista[0].payload.maquinaria_codigo);
        assert.equal((await avisos('ot_reasignada', ot)).length, 0, 'sin tecnico anterior no hay aviso de reasignacion');
        assert.equal((await asignar()).status, 200, 'doble clic');
        lista = await avisos('ot_asignada', ot);
        assert.equal(lista.length, 1, 'el mismo tecnico no recibe un segundo aviso');
    });

    test('reasignar avisa al nuevo y al anterior ("ya no vayas")', async (t) => {
        if (!requiereBase(t)) return;
        await contactos(MARCA.telefono, MARCA.telefonoDos);
        const ot = await crearOt('asignada', datos.mecanicoId);
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoDosId });
        assert.equal(r.status, 200);
        const nuevo = await avisos('ot_asignada', ot);
        assert.equal(nuevo.length, 1);
        assert.equal(nuevo[0].destinatario, MARCA.telefonoDos);
        const anterior = await avisos('ot_reasignada', ot);
        assert.equal(anterior.length, 1);
        assert.equal(anterior[0].destinatario, MARCA.telefono);
    });

    test('sin WhatsApp el aviso va por correo', async (t) => {
        if (!requiereBase(t)) return;
        await contactos(null, null);
        const ot = await crearOt('asignada', null);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId })).status, 200);
        const lista = await avisos('ot_asignada', ot);
        assert.equal(lista.length, 1);
        assert.equal(lista[0].canal, 'email');
        assert.equal(lista[0].destinatario, 'mecanico@gomaq.test');
    });

    // una cuenta desactivada no puede recibir ordenes: la asignacion misma se rechaza y por lo tanto tampoco hay aviso
    test('a un mecanico inactivo no se le asigna ni se le avisa', async (t) => {
        if (!requiereBase(t)) return;
        await contactos(MARCA.telefono, MARCA.telefonoDos);
        const ot = await crearOt('asignada', null);
        try {
            await pool.query("UPDATE usuarios SET estado_cuenta = 'rechazado' WHERE id = $1", [datos.mecanicoId]);
            const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId });
            assert.equal(r.status, 400);
            assert.equal((await avisos('ot_asignada', ot)).length, 0);
        } finally {
            await pool.query("UPDATE usuarios SET estado_cuenta = 'activo' WHERE id = $1", [datos.mecanicoId]);
        }
    });

    test('cerrar una OT con repuestos facturables avisa al gerente; el reintento del cierre no repite el aviso', async (t) => {
        if (!requiereBase(t)) return;
        await pool.query("UPDATE usuarios SET telefono_whatsapp = '+56933330000' WHERE email = 'admin@gomaq.test'");
        const ot = await crearOt('en_reparacion');
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        const uuid = crypto.randomUUID();
        const cerrar = () => pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { uuid, uuid_cliente: uuid, observacion_final: 'listo' });
        assert.equal((await cerrar()).status, 200);
        const lista = await avisos('ot_por_valorizar', ot);
        assert.equal(lista.length, 2, 'un correo y un WhatsApp para el gerente');
        assert.deepEqual(lista.map((x) => x.canal).sort(), ['email', 'whatsapp']);
        assert.equal(lista[0].payload.causa, 'Orden finalizada');
        assert.equal((await cerrar()).status, 200, 'reintento');
        assert.equal((await avisos('ot_por_valorizar', ot)).length, 2, 'el reintento no duplica');
    });

    test('cerrar una OT sin nada facturable no avisa al gerente', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { observacion_final: 'sin repuestos' })).status, 200);
        assert.equal((await avisos('ot_por_valorizar', ot)).length, 0);
    });

    test('anular la valorizacion por un cambio de lineas avisa al gerente una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        await pool.query("UPDATE usuarios SET telefono_whatsapp = '+56933330000' WHERE email = 'admin@gomaq.test'");
        const { ot, a } = await otValorizada();
        const antes = (await avisos('ot_por_valorizar', ot)).length;
        const r = await pedir('PATCH', rutaLinea(ot, a), 'administrativo', { precio_unitario: 7777, ...MOTIVO_VALIDO });
        assert.equal(r.status, 200);
        const despues = await avisos('ot_por_valorizar', ot);
        assert.equal(despues.length, antes + 2, 'exactamente un correo y un WhatsApp para el gerente');
        assert.equal(despues[despues.length - 1].payload.causa, 'Cambio en las líneas facturables');
        // un segundo cambio ya sin valorizacion no la anula de nuevo ni avisa
        const n = despues.length;
        assert.equal((await pedir('PATCH', rutaLinea(ot, a), 'administrativo', { precio_unitario: 8888, ...MOTIVO_VALIDO })).status, 200);
        assert.equal((await avisos('ot_por_valorizar', ot)).length, n);
    });

    test('anular una factura avisa al gerente; repetir con la misma Idempotency-Key no repite el aviso', async (t) => {
        if (!requiereBase(t)) return;
        await pool.query("UPDATE usuarios SET telefono_whatsapp = '+56933330000' WHERE email = 'admin@gomaq.test'");
        const ot = await crearOt();
        await facturarDirecto(ot, 'T-5301');
        const factura = (await pool.query('SELECT id FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows[0];
        const llave = crypto.randomUUID();
        const anular = () => pedir('POST', `/api/ordenes-trabajo/${ot}/factura/${factura.id}/anular`, 'administrativo',
            { ...MOTIVO_VALIDO }, { 'Idempotency-Key': llave });
        assert.equal((await anular()).status, 200);
        const lista = await avisos('factura_anulada', ot);
        assert.equal(lista.length, 2);
        assert.equal(lista[0].payload.folio, 'T-5301');
        assert.deepEqual(Object.keys(lista[0].payload).sort(), ['folio', 'orden_trabajo_id', 'tipo'], 'payload minimo: sin monto ni motivo libre');
        assert.equal((await anular()).status, 200, 'repeticion');
        assert.equal((await avisos('factura_anulada', ot)).length, 2, 'la repeticion no duplica');
    });

    test('anular una factura que no existe no deja aviso', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const antes = (await avisos('factura_anulada')).length;
        const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/factura/99999999/anular`, 'administrativo', { ...MOTIVO_VALIDO });
        assert.equal(r.status, 404);
        assert.equal((await avisos('factura_anulada')).length, antes);
    });

    test('un conteo por perdida o merma avisa al gerente; por diferencia o sin diferencia no', async (t) => {
        if (!requiereBase(t)) return;
        await pool.query("UPDATE usuarios SET telefono_whatsapp = NULL WHERE email = 'admin@gomaq.test'");
        const ubic = await pool.query("INSERT INTO ubicaciones_stock (nombre, tipo) VALUES ('Aviso prueba 5C', 'bodega') RETURNING id");
        datos.ubicaciones.push(ubic.rows[0].id);
        const insumo = await pool.query("INSERT INTO insumos (nombre, unidad_medida) VALUES ('Insumo aviso 5C', 'un') RETURNING id");
        datos.insumos.push(insumo.rows[0].id);
        await pool.query('INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad) VALUES ($1, $2, 10)', [ubic.rows[0].id, insumo.rows[0].id]);
        const contar = (contada, esperada, motivo, uuid = crypto.randomUUID()) => pedir('POST', '/api/insumos/ajuste', 'administrativo', {
            ubicacion_id: ubic.rows[0].id, insumo_id: insumo.rows[0].id, cantidad_contada: contada, cantidad_esperada: esperada,
            motivo_codigo: motivo, uuid_cliente: uuid,
        });
        const total = async () => (await avisos('ajuste_inventario')).filter((x) => x.payload.insumo_nombre === 'Insumo aviso 5C').length;
        assert.equal((await contar(8, 10, 'diferencia_conteo')).status, 201);
        assert.equal(await total(), 0, 'una diferencia de conteo no avisa');
        assert.equal((await contar(8, 8, 'perdida_robo')).status, 200);
        assert.equal(await total(), 0, 'un conteo sin diferencia no avisa');
        const uuid = crypto.randomUUID();
        assert.equal((await contar(5, 8, 'perdida_robo', uuid)).status, 201);
        assert.equal(await total(), 1);
        const aviso = (await avisos('ajuste_inventario')).find((x) => x.payload.insumo_nombre === 'Insumo aviso 5C');
        assert.equal(aviso.payload.delta, -3);
        assert.equal(aviso.payload.motivo_codigo, 'perdida_robo');
        assert.ok(!('nota' in aviso.payload), 'la nota libre no viaja en el aviso');
        assert.equal((await contar(5, 8, 'perdida_robo', uuid)).status, 200, 'reintento idempotente');
        assert.equal(await total(), 1, 'el reintento no duplica');
        assert.equal((await contar(3, 5, 'danio_merma')).status, 201);
        assert.equal(await total(), 2, 'danio o merma tambien avisa');
    });

    test('una anulacion que deja la OT sin nada facturable no avisa al gerente', async (t) => {
        if (!requiereBase(t)) return;
        await pool.query("UPDATE usuarios SET telefono_whatsapp = '+56933330000' WHERE email = 'admin@gomaq.test'");
        const ot = await crearOt();
        const linea = await agregarLinea(ot, { descripcion: 'unica cobrable', precio_unitario: 1000, facturable: 'si' });
        await cerrarOt(ot, 1000);
        const r = await pedir('POST', `${rutaLinea(ot, linea.id)}/anular`, 'administrativo', { ...MOTIVO_VALIDO });
        assert.equal(r.status, 200);
        const v = await pool.query('SELECT valorizacion, facturable FROM ordenes_trabajo WHERE id = $1', [ot]);
        assert.equal(v.rows[0].valorizacion, null, 'la valorizacion se anulo');
        assert.equal(v.rows[0].facturable, false, 'y no queda nada que cobrar');
        assert.equal((await avisos('ot_por_valorizar', ot)).length, 0);
    });

    test('una OT finalizada no facturable que pasa a facturable avisa al gerente', async (t) => {
        if (!requiereBase(t)) return;
        await pool.query("UPDATE usuarios SET telefono_whatsapp = '+56933330000' WHERE email = 'admin@gomaq.test'");
        const ot = await crearOt();
        await cerrarOt(ot, null);
        assert.equal((await avisos('ot_por_valorizar', ot)).length, 0);
        const r = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo',
            { cantidad: 1, descripcion: 'Repuesto tardio', precio_unitario: 1000, facturable: 'si', ...MOTIVO_VALIDO });
        assert.equal(r.status, 201);
        const lista = await avisos('ot_por_valorizar', ot);
        assert.equal(lista.length, 2, 'correo y WhatsApp');
        // una segunda linea facturable ya no cambia nada: la OT ya estaba esperando valorizacion
        const otra = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo',
            { cantidad: 1, descripcion: 'Otro repuesto', precio_unitario: 500, facturable: 'si', ...MOTIVO_VALIDO });
        assert.equal(otra.status, 201);
        assert.equal((await avisos('ot_por_valorizar', ot)).length, 2);
    });

    test('un gerente inactivo no recibe avisos', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await facturarDirecto(ot, 'T-5302');
        const factura = (await pool.query('SELECT id FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows[0];
        try {
            await pool.query("UPDATE usuarios SET estado_cuenta = 'rechazado' WHERE email = 'admin@gomaq.test'");
            const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/factura/${factura.id}/anular`, 'administrativo', { ...MOTIVO_VALIDO });
            assert.equal(r.status, 200);
            assert.equal((await avisos('factura_anulada', ot)).length, 0);
        } finally {
            await pool.query("UPDATE usuarios SET estado_cuenta = 'activo' WHERE email = 'admin@gomaq.test'");
        }
    });

    test('el gerente que anula la factura no se avisa a si mismo; otro gerente si', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await facturarDirecto(ot, 'T-5303');
        const factura = (await pool.query('SELECT id FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows[0];
        const otro = await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, estado_cuenta)
             VALUES ('Gerente Dos 5C', 'gerente2.5c@gomaq.test', 'x', 'gerente', 'activo') RETURNING id`);
        try {
            const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/factura/${factura.id}/anular`, 'gerente', { ...MOTIVO_VALIDO });
            assert.equal(r.status, 200);
            const lista = await avisos('factura_anulada', ot);
            assert.ok(lista.length >= 1);
            assert.ok(lista.every((x) => x.destinatario !== 'admin@gomaq.test' && x.destinatario !== '+56933330000'),
                'el gerente que ejecuta la accion no recibe el aviso');
            assert.ok(lista.some((x) => x.destinatario === 'gerente2.5c@gomaq.test'), 'el otro gerente si');
        } finally {
            await pool.query('DELETE FROM usuarios WHERE id = $1', [otro.rows[0].id]);
        }
    });

    test('si la transaccion se revierte despues de encolar, el aviso no queda', async (t) => {
        if (!requiereBase(t)) return;
        const { avisarFacturaAnulada } = require('../src/utils/avisos');
        const antes = (await avisos('factura_anulada')).length;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const n = await avisarFacturaAnulada(client, { factura: { orden_trabajo_id: null, folio: 'T-ROLLBACK' } });
            assert.ok(n >= 1, 'se encolo dentro de la transaccion');
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
        assert.equal((await avisos('factura_anulada')).length, antes, 'el ROLLBACK se llevo el aviso');
    });

    test('un conteo que suma stock no avisa aunque el motivo sea perdida o merma', async (t) => {
        if (!requiereBase(t)) return;
        const ubic = await pool.query("INSERT INTO ubicaciones_stock (nombre, tipo) VALUES ('Aviso positivo 5C', 'bodega') RETURNING id");
        datos.ubicaciones.push(ubic.rows[0].id);
        const insumo = await pool.query("INSERT INTO insumos (nombre, unidad_medida) VALUES ('Insumo positivo 5C', 'un') RETURNING id");
        datos.insumos.push(insumo.rows[0].id);
        await pool.query('INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad) VALUES ($1, $2, 2)', [ubic.rows[0].id, insumo.rows[0].id]);
        const r = await pedir('POST', '/api/insumos/ajuste', 'administrativo', {
            ubicacion_id: ubic.rows[0].id, insumo_id: insumo.rows[0].id, cantidad_contada: 6, cantidad_esperada: 2,
            motivo_codigo: 'perdida_robo', uuid_cliente: crypto.randomUUID(),
        });
        assert.equal(r.status, 201);
        assert.equal(r.body.delta, 4);
        const lista = (await avisos('ajuste_inventario')).filter((x) => x.payload.insumo_nombre === 'Insumo positivo 5C');
        assert.equal(lista.length, 0);
    });

    test('el contador de notificaciones en error del dashboard no cuenta los avisos internos', async (t) => {
        if (!requiereBase(t)) return;
        const { TIPOS_INTERNOS } = require('../src/utils/avisos');
        assert.deepEqual([...TIPOS_INTERNOS].sort(), [...TIPOS].sort());
        const cuenta = async () => Number((await pool.query(
            `SELECT COUNT(*) AS n FROM notificaciones_pendientes WHERE estado = 'error' AND COALESCE(payload->>'tipo', '') <> ALL($1::text[])`,
            [TIPOS_INTERNOS])).rows[0].n);
        const antes = await cuenta();
        const interno = await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload, estado, intentos)
             VALUES ('email', 'x@gomaq.test', '{"tipo":"ot_asignada"}', 'error', 5) RETURNING id`);
        const cliente = await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload, estado, intentos)
             VALUES ('email', 'y@gomaq.test', '{"tipo":"ot_finalizada"}', 'error', 5) RETURNING id`);
        try {
            assert.equal(await cuenta(), antes + 1, 'solo el aviso al cliente cuenta');
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = ANY($1)', [[interno.rows[0].id, cliente.rows[0].id]]);
        }
    });

    test('los avisos nuevos quedan pendientes como cualquier otro y no rompen al worker', async (t) => {
        if (!requiereBase(t)) return;
        const pendientes = await pool.query(
            `SELECT estado, intentos FROM notificaciones_pendientes WHERE created_at >= $1 AND payload->>'tipo' = ANY($2)`, [inicio, TIPOS]);
        assert.ok(pendientes.rows.length > 0);
        // en el CI el servidor corre el worker adentro y, con el proveedor aun simulado, puede tomar
        // un aviso (intentos > 0 o estado 'error') antes de que esta prueba lo lea: lo que importa es
        // que el aviso exista y que ni el worker ni su estado se rompan (nunca 'cancelado' ni raro)
        assert.ok(pendientes.rows.every((x) => ['pendiente', 'error', 'enviado'].includes(x.estado) && x.intentos >= 0));
    });
});

describe('bloque 6 (parte 1): contratos para el dashboard, Ordenes y el portal', () => {
    const tokenCliente = tokenClienteDe(987655);
    // el dashboard guarda los arriendos 30 s: las pruebas, que acaban de crear datos, lo vacian antes de leer
    const pendientes = async (rol = 'administrativo') => {
        require('../src/routes/dashboard').vaciarCacheArriendos();
        return pedir('GET', '/api/dashboard/pendientes', rol);
    };
    const total = async (ruta) => {
        const r = await pedir('GET', `${ruta}${ruta.includes('?') ? '&' : '?'}limit=1`, 'administrativo');
        assert.equal(r.status, 200, `${ruta} -> ${r.status}`);
        return r.body.total;
    };
    const otSinAsignar = async () => {
        const r = await pool.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo)
             SELECT id, cliente_id, 'pendiente', 'OT sin asignar de prueba' FROM maquinarias WHERE id = $1 RETURNING id`,
            [datos.maquinariaId]);
        datos.ordenes.push(r.rows[0].id);
        return r.rows[0].id;
    };

    test('GET /dashboard/pendientes: solo administrativo y gerente, con todos los numeros', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await pedir('GET', '/api/dashboard/pendientes', 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/dashboard/pendientes', 'cliente')).status, 403);
        const g = await pendientes('gerente');
        assert.equal(g.status, 200);
        const a = await pendientes('administrativo');
        assert.equal(a.status, 200);
        const claves = ['mantencion_vencida', 'mantencion_proxima', 'ot_sin_asignar', 'asistencias_por_atender', 'avisos_con_problemas',
            'por_facturar', 'arriendos_con_aviso', 'ot_por_valorizar', 'guias_sin_documento', 'descuadres', 'cuentas_por_aprobar'];
        for (const c of claves) {
            assert.ok(Number.isInteger(a.body[c]) && a.body[c] >= 0, `${c} debe ser un entero >= 0: ${a.body[c]}`);
        }
        assert.ok(!Number.isNaN(Date.parse(a.body.generado_en)));
    });

    test('cada numero de /dashboard/pendientes es el de la lista a la que lleva', async (t) => {
        if (!requiereBase(t)) return;
        // algo en cada lista, para que la igualdad no sea 0 = 0
        const equipo = await crearEquipo(null);
        const cliente = await algunCliente();
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-01-02T09:00:00-03:00', $2)`, [equipo.id, cliente]);
        const cerrado = await crearEquipo(null);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-01-02T09:00:00-03:00', $2)`, [cerrado.id, cliente]);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'recepcion', 'x', '2026-01-20T10:00:00-03:00', $2)`, [cerrado.id, cliente]);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', NULL, now(), $2)`, [(await crearEquipo(null)).id, cliente]);
        await otSinAsignar();
        const valorizar = await crearOt();
        await agregarLinea(valorizar, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(valorizar, null);
        const lista = await crearOt();
        await agregarLinea(lista, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(lista, 1000);

        const p = (await pendientes()).body;
        assert.ok(p.ot_sin_asignar >= 1 && p.por_facturar >= 2 && p.arriendos_con_aviso >= 1 && p.ot_por_valorizar >= 1);

        assert.equal(p.ot_sin_asignar, await total('/api/ordenes-trabajo?sin_asignar=1'));
        const fact = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body;
        assert.equal(p.por_facturar, fact.arriendos.length + fact.reparaciones_listas.length);
        assert.equal(p.ot_por_valorizar, fact.reparaciones_pendientes_valorizar.length);
        const enCurso = (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'administrativo')).body.arriendos;
        assert.equal(p.arriendos_con_aviso, enCurso.filter((x) => x.aviso === true).length);
        const alertas = (await pedir('GET', '/api/horometro/alertas', 'administrativo')).body.equipos;
        assert.equal(p.mantencion_vencida, alertas.filter((e) => e.vencida).length);
        assert.equal(p.mantencion_proxima, alertas.filter((e) => e.por_vencer && !e.vencida).length);
        const descuadres = (await pedir('GET', '/api/insumos/descuadres', 'administrativo')).body;
        assert.equal(p.descuadres, descuadres.length);
        const problemas = (await pedir('GET', '/api/notificaciones?problemas=1', 'administrativo')).body;
        assert.equal(p.avisos_con_problemas, problemas.total, 'el total de la lista es el numero del dashboard (sin el tope de 200)');
        assert.ok(problemas.items.length <= 200);
        // la lista real de cada pendiente simple, no el SQL del contador
        const solicitudes = await pedir('GET', '/api/solicitudes?estado=pendiente', 'administrativo');
        assert.equal(p.asistencias_por_atender, solicitudes.body.length);
        const guiasSin = await pedir('GET', '/api/maquinarias/guias/recientes?sin_documento=1', 'administrativo');
        assert.equal(p.guias_sin_documento, guiasSin.body.length);
        const cuentas = await pedir('GET', '/api/usuarios/solicitudes', 'administrativo');
        assert.equal(p.cuentas_por_aprobar, cuentas.body.length);
        // /resumen conserva sus atajos
        const resumen = (await pedir('GET', '/api/dashboard/resumen', 'administrativo')).body;
        assert.ok('pendientes_facturar' in resumen.atajos && 'notificaciones_error' in resumen.atajos);
    });

    test('sin asignar: sube al crear una OT sin mecanico y baja al asignarla', async (t) => {
        if (!requiereBase(t)) return;
        const antes = (await pendientes()).body.ot_sin_asignar;
        const ot = await otSinAsignar();
        assert.equal((await pendientes()).body.ot_sin_asignar, antes + 1);
        const lista = await pedir('GET', '/api/ordenes-trabajo?sin_asignar=1&limit=200', 'gerente');
        assert.ok(lista.body.items.some((o) => o.id === ot), 'la OT esta en la lista Sin asignar');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId })).status, 200);
        assert.equal((await pendientes()).body.ot_sin_asignar, antes);
        const despues = await pedir('GET', '/api/ordenes-trabajo?sin_asignar=1&limit=200', 'gerente');
        assert.ok(!despues.body.items.some((o) => o.id === ot));
    });

    test('GET /ordenes-trabajo/resumen: permisos y conteos iguales a las listas', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await pedir('GET', '/api/ordenes-trabajo/resumen', 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/ordenes-trabajo/resumen', 'cliente')).status, 403);
        await otSinAsignar();
        await crearOt('en_terreno');
        await crearOt('asignada');
        const cerrada = await crearOt();
        await cerrarOt(cerrada, null);
        for (const rol of ['administrativo', 'gerente']) {
            const r = await pedir('GET', '/api/ordenes-trabajo/resumen', rol);
            assert.equal(r.status, 200, rol);
            assert.equal(r.body.todas, await total('/api/ordenes-trabajo'));
            assert.equal(r.body.sin_asignar, await total('/api/ordenes-trabajo?sin_asignar=1'));
            assert.equal(r.body.en_curso, await total('/api/ordenes-trabajo?estado=asignada,aceptada,en_camino,en_terreno,en_reparacion'));
            assert.equal(r.body.finalizadas, await total('/api/ordenes-trabajo?estado=finalizada'));
            assert.equal(r.body.por_estado.finalizada, r.body.finalizadas);
            assert.ok(r.body.sin_asignar >= 1 && r.body.en_curso >= 2 && r.body.finalizadas >= 1);
        }
    });

    test('GET /ordenes-trabajo: lista de estados, 400 si es desconocido, orden y nombre del mecanico', async (t) => {
        if (!requiereBase(t)) return;
        const abierta = await crearOt('en_terreno');
        const sin = await otSinAsignar();
        const dosEstados = await pedir('GET', '/api/ordenes-trabajo?estado=pendiente,en_terreno&limit=200', 'administrativo');
        assert.equal(dosEstados.status, 200);
        assert.ok(dosEstados.body.items.every((o) => ['pendiente', 'en_terreno'].includes(o.estado)));
        assert.ok(dosEstados.body.items.some((o) => o.id === abierta) && dosEstados.body.items.some((o) => o.id === sin));
        for (const malo of ['inventado', 'en_terreno,inventado', 'en_terreno,']) {
            assert.equal((await pedir('GET', `/api/ordenes-trabajo?estado=${malo}`, 'administrativo')).status, 400, malo);
        }
        const conMecanico = dosEstados.body.items.find((o) => o.id === abierta);
        assert.ok(conMecanico.mecanico_nombre, 'trae el nombre del mecanico');
        assert.equal(dosEstados.body.items.find((o) => o.id === sin).mecanico_nombre, null);
        const asc = (await pedir('GET', '/api/ordenes-trabajo?dir=asc&limit=200', 'administrativo')).body.items;
        const desc = (await pedir('GET', '/api/ordenes-trabajo?limit=200', 'administrativo')).body.items;
        const fechas = (lista) => lista.map((o) => new Date(o.fecha_creacion).getTime());
        assert.deepEqual(fechas(asc), [...fechas(asc)].sort((x, y) => x - y), 'ascendente');
        assert.deepEqual(fechas(desc), [...fechas(desc)].sort((x, y) => y - x), 'descendente por defecto');
        // la rama del mecanico no cambia: solo ve las suyas
        const mias = await pedir('GET', '/api/ordenes-trabajo?limit=200', 'mecanico');
        assert.ok(mias.body.items.every((o) => o.mecanico_id === datos.mecanicoId));
        const disponibles = await pedir('GET', '/api/ordenes-trabajo?sin_asignar=1&limit=200', 'mecanico');
        assert.ok(disponibles.body.items.some((o) => o.id === sin), 'el mecanico ve las sin asignar para tomarlas');
    });

    test('GET /notificaciones?problemas=1 lista lo que cuenta el dashboard y no los avisos internos en error', async (t) => {
        if (!requiereBase(t)) return;
        const interno = await pool.query(`INSERT INTO notificaciones_pendientes (canal, destinatario, payload, estado, intentos) VALUES ('email', 'x@gomaq.test', '{"tipo":"ot_asignada"}', 'error', 5) RETURNING id`);
        const cliente = await pool.query(`INSERT INTO notificaciones_pendientes (canal, destinatario, payload, estado, intentos) VALUES ('email', 'y@gomaq.test', '{"tipo":"ot_finalizada"}', 'error', 5) RETURNING id`);
        try {
            assert.equal((await pedir('GET', '/api/notificaciones?problemas=1', 'mecanico')).status, 403);
            const r = await pedir('GET', '/api/notificaciones?problemas=1', 'administrativo');
            assert.equal(r.status, 200);
            const ids = r.body.items.map((x) => x.id);
            assert.ok(ids.includes(cliente.rows[0].id), 'el aviso al cliente en error aparece');
            assert.ok(!ids.includes(interno.rows[0].id), 'el interno no');
            assert.ok(r.body.items.length <= 200 && r.body.total >= r.body.items.length);
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = ANY($1)', [[interno.rows[0].id, cliente.rows[0].id]]);
        }
    });

    describe('portal: GET /ordenes-trabajo/mias', () => {
        async function conVehiculo(usar) {
            const existente = await pool.query('SELECT id FROM vehiculos WHERE usuario_id = $1', [datos.mecanicoId]);
            let creado = null;
            if (existente.rows.length === 0) {
                creado = (await pool.query(
                    `INSERT INTO vehiculos (patente, marca, modelo, usuario_id) VALUES ($1, 'Ford', 'Transit', $2) RETURNING id, patente`,
                    [`T${crypto.randomUUID().slice(0, 6).toUpperCase()}`, datos.mecanicoId])).rows[0];
            }
            try {
                await pool.query('UPDATE vehiculos SET activo = true WHERE usuario_id = $1', [datos.mecanicoId]);
                const v = (await pool.query('SELECT patente, marca, modelo FROM vehiculos WHERE usuario_id = $1', [datos.mecanicoId])).rows[0];
                await usar(v);
            } finally {
                if (creado) await pool.query('DELETE FROM vehiculos WHERE id = $1', [creado.id]);
            }
        }

        test('una OT abierta trae las horas de cada paso, el tecnico y su vehiculo; sin RUT ni datos internos', async (t) => {
            if (!requiereBase(t)) return;
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            const ot = (await pool.query(
                `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo, aceptada_at, en_camino_at, llegada_at)
                 VALUES ($1, $2, $3, 'en_terreno', 'OT del portal', '2026-03-02T10:00:00Z', '2026-03-02T10:30:00Z', '2026-03-02T11:15:00Z') RETURNING id`,
                [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
            datos.ordenes.push(ot);
            // el evento mas antiguo no se aplico (llego atrasado): no cuenta como la asignacion
            await pool.query(
                `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen, aplicado)
                 VALUES ($1, 'asignacion', '2026-03-02T09:45:00Z', 'panel', true), ($1, 'asignacion', '2026-03-01T00:00:00Z', 'panel', false)`, [ot]);
            await conVehiculo(async (v) => {
                const r = await pedirConToken('/api/ordenes-trabajo/mias', tokenCliente(cliente));
                assert.equal(r.status, 200);
                const o = r.body.find((x) => x.id === ot);
                assert.ok(o, 'la OT esta en el historial');
                assert.equal(new Date(o.aceptada_at).toISOString(), '2026-03-02T10:00:00.000Z');
                assert.equal(new Date(o.en_camino_at).toISOString(), '2026-03-02T10:30:00.000Z');
                assert.equal(new Date(o.llegada_at).toISOString(), '2026-03-02T11:15:00.000Z');
                assert.equal(new Date(o.asignada_at).toISOString(), '2026-03-02T09:45:00.000Z', 'la asignacion aplicada, no el evento atrasado');
                assert.equal(o.vehiculo_patente, v.patente);
                assert.equal(o.vehiculo_marca, v.marca);
                assert.equal(o.vehiculo_modelo, v.modelo);
                assert.ok(o.mecanico_nombre);
                assert.equal(o.cobro, null, 'abierta: sin mensaje de cobro');
                afirmarClavesPortal(o);
            });
        });

        test('una OT en camino trae la hora estimada de llegada y nunca coordenadas', async (t) => {
            if (!requiereBase(t)) return;
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            const ot = (await pool.query(
                `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo,
                        destino_lat, destino_lng, destino_origen,
                        eta_segundos, eta_distancia_m, eta_calculada_at, eta_fuente, eta_origen_lat, eta_origen_lng, eta_consultas)
                 VALUES ($1, $2, $3, 'en_camino', 'OT con ETA', -38.7359, -72.5904, 'cliente',
                         600, 5000, '2026-03-02T10:00:00Z', 'aproximada', -38.70, -72.50, 3) RETURNING id`,
                [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
            datos.ordenes.push(ot);

            const r = await pedirConToken('/api/ordenes-trabajo/mias', tokenCliente(cliente));
            assert.equal(r.status, 200);
            const o = r.body.find((x) => x.id === ot);
            assert.ok(o, 'la OT esta en el historial');
            assert.equal(new Date(o.eta_llegada_at).toISOString(), '2026-03-02T10:10:00.000Z', 'calculada_at + segundos');
            assert.equal(new Date(o.eta_calculada_at).toISOString(), '2026-03-02T10:00:00.000Z');
            assert.equal(o.eta_aproximada, true);
            afirmarClavesPortal(o);

            // al llegar, la hora estimada deja de mostrarse al cliente
            await pool.query(`UPDATE ordenes_trabajo SET estado = 'en_terreno' WHERE id = $1`, [ot]);
            const despues = (await pedirConToken('/api/ordenes-trabajo/mias', tokenCliente(cliente))).body.find((x) => x.id === ot);
            assert.equal(despues.eta_llegada_at, null);
            assert.equal(despues.eta_aproximada, null);
        });

        test('ETA por rutas: el cupo diario se respeta aunque lleguen reservas simultaneas', async (t) => {
            if (!requiereBase(t)) return;
            const { reservarConsulta } = require('../src/services/rutasEta');
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            await pool.query('DELETE FROM uso_ors');
            const ids = [];
            for (let i = 0; i < 8; i++) {
                const ot = (await pool.query(
                    `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo)
                     VALUES ($1, $2, $3, 'en_camino', 'cupo ors') RETURNING id`, [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
                datos.ordenes.push(ot);
                ids.push(ot);
            }
            const r = await Promise.all(ids.map((id) => reservarConsulta(pool, id, { maxPorOt: 15, cupoDiario: 3 })));
            assert.equal(r.filter((x) => x.ok).length, 3, 'solo pasan las que caben en el cupo');
            assert.ok(r.filter((x) => !x.ok).every((x) => x.motivo === 'cupo_diario'));
            assert.equal((await pool.query('SELECT consultas FROM uso_ors')).rows[0].consultas, 3);
            // las rechazadas devuelven su reserva: no queda gastada una consulta que no se hizo
            const gastadas = (await pool.query('SELECT count(*)::int AS c FROM ordenes_trabajo WHERE id = ANY($1) AND eta_consultas > 0', [ids])).rows[0].c;
            assert.equal(gastadas, 3);
            await pool.query('DELETE FROM uso_ors');
        });

        test('ETA por rutas: guarda la ruta, no la pisa con la aproximada y si el servicio falla conserva la aproximada', async (t) => {
            if (!requiereBase(t)) return;
            const { mejorarEtaConRutas } = require('../src/services/rutasEta');
            const { guardarPosicion } = require('../src/utils/posicionMecanico');
            const { ErrorOrs } = require('../src/services/ors');
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            await pool.query('DELETE FROM uso_ors');
            const nuevaOt = async () => {
                const ot = (await pool.query(
                    `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo, destino_lat, destino_lng, destino_origen)
                     VALUES ($1, $2, $3, 'en_camino', 'ruta', -38.7359, -72.5904, 'cliente') RETURNING id`,
                    [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
                datos.ordenes.push(ot);
                return ot;
            };
            const leer = async (id) => (await pool.query('SELECT eta_fuente, eta_segundos, eta_consultas FROM ordenes_trabajo WHERE id = $1', [id])).rows[0];
            const origen = { latitud: -38.70, longitud: -72.50 };
            const silencio = { warn() {}, error() {} };
            const opciones = (llamar) => ({ llamar, hayLlave: () => true, log: silencio });

            // con ruta: queda la ETA del servicio, y una posicion nueva no la reemplaza por la aproximada
            const conRuta = await nuevaOt();
            const r = await mejorarEtaConRutas(pool, { ordenId: conRuta, usuarioId: datos.mecanicoId, origen },
                opciones(async () => ({ distancia_m: 5000, segundos: 600 })));
            assert.equal(r.guardada, true);
            assert.deepEqual(await leer(conRuta), { eta_fuente: 'ors', eta_segundos: 600, eta_consultas: 1 });
            await guardarPosicion(pool, { ordenId: conRuta, usuarioId: datos.mecanicoId, posicion: { ...origen, capturada_en: new Date().toISOString() } });
            assert.equal((await leer(conRuta)).eta_fuente, 'ors', 'la aproximada no pisa a la ruta real');

            // el servicio falla: no lanza, conserva la aproximada y la consulta cuenta
            const conFallo = await nuevaOt();
            await guardarPosicion(pool, { ordenId: conFallo, usuarioId: datos.mecanicoId, posicion: { ...origen, capturada_en: new Date().toISOString() } });
            const aprox = await leer(conFallo);
            assert.equal(aprox.eta_fuente, 'aproximada');
            const f = await mejorarEtaConRutas(pool, { ordenId: conFallo, usuarioId: datos.mecanicoId, origen },
                opciones(async () => { throw new ErrorOrs('timeout', 'sin respuesta'); }));
            assert.equal(f.motivo, 'ors_fallo');
            assert.deepEqual(await leer(conFallo), { ...aprox, eta_consultas: 1 });

            // sin llave no se llama a nadie ni se gasta cupo
            const sinLlave = await nuevaOt();
            const s = await mejorarEtaConRutas(pool, { ordenId: sinLlave, usuarioId: datos.mecanicoId, origen },
                { llamar: async () => assert.fail('no debia llamar'), hayLlave: () => false, log: silencio });
            assert.equal(s.motivo, 'sin_llave');
            assert.equal((await leer(sinLlave)).eta_consultas, 0);
            await pool.query('DELETE FROM uso_ors');
        });

        test('cuentas internas: crear desde el panel, iniciar sesion, y una cuenta desactivada pierde la sesion al instante', async (t) => {
            if (!requiereBase(t)) return;
            const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
            const correo = `qa.cuentas.${sufijo}@gomaq.test`;
            const creados = [];
            try {
                // el administrativo crea mecanicos y administrativos; solo un gerente crea otro gerente
                assert.equal((await pedir('POST', '/api/usuarios', 'administrativo', {
                    nombre: 'QA gerente', email: `qa.gerente.no.${sufijo}@gomaq.test`, rol: 'gerente', password: 'clave-de-prueba-1',
                })).status, 403);
                for (const rol of ['mecanico', 'administrativo', 'gerente']) {
                    const r = await pedir('POST', '/api/usuarios', rol === 'gerente' ? 'gerente' : 'administrativo', {
                        nombre: `QA ${rol}`,
                        email: rol === 'mecanico' ? correo.toUpperCase() : `qa.${rol}.${sufijo}@gomaq.test`,
                        rol,
                        password: 'clave-de-prueba-1',
                    });
                    assert.equal(r.status, 201, `${rol}: ${JSON.stringify(r.body)}`);
                    assert.equal(r.body.rol, rol);
                    assert.equal(r.body.estado_cuenta, 'activo');
                    assert.ok(!('password_hash' in r.body) && !('password' in r.body), 'nunca devuelve la clave');
                    creados.push(r.body.id);
                }
                const mecanicoNuevo = creados[0];
                // el correo se guardo en minusculas aunque se escribio en mayusculas
                assert.equal((await pool.query('SELECT email FROM usuarios WHERE id = $1', [mecanicoNuevo])).rows[0].email, correo);
                // repetir el correo (con otras mayusculas) es 409
                assert.equal((await pedir('POST', '/api/usuarios', 'gerente', { nombre: 'Otra', email: correo.replace('qa', 'QA'), rol: 'mecanico', password: 'clave-de-prueba-1' })).status, 409);
                // cliente y clave corta no se crean por esta ruta
                assert.equal((await pedir('POST', '/api/usuarios', 'administrativo', { nombre: 'Cli', email: `cli.${sufijo}@gomaq.test`, rol: 'cliente', password: 'clave-de-prueba-1' })).status, 400);
                assert.equal((await pedir('POST', '/api/usuarios', 'administrativo', { nombre: 'Corta', email: `corta.${sufijo}@gomaq.test`, rol: 'mecanico', password: '1234' })).status, 400);
                // el mecanico no puede crear cuentas ni desactivarlas
                assert.equal((await pedir('POST', '/api/usuarios', 'mecanico', { nombre: 'X', email: `x.${sufijo}@gomaq.test`, rol: 'gerente', password: 'clave-de-prueba-1' })).status, 403);
                assert.equal((await pedir('PATCH', `/api/usuarios/${mecanicoNuevo}/estado`, 'mecanico', { activo: false })).status, 403);

                // inicia sesion con el correo escrito de cualquier forma
                const login = await fetch(`${base}/api/auth/login`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: correo.toUpperCase(), password: 'clave-de-prueba-1' }),
                });
                assert.equal(login.status, 200);
                let { token } = await login.json();
                const conToken = (ruta) => fetch(`${base}${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
                assert.equal((await conToken('/api/ordenes-trabajo?limit=1')).status, 200, 'la sesion nueva funciona');

                // no se desactiva a si mismo
                const yo = (await pool.query(`SELECT id FROM usuarios WHERE email = 'administrativo@gomaq.test'`)).rows[0].id;
                assert.equal((await pedir('PATCH', `/api/usuarios/${yo}/estado`, 'administrativo', { activo: false })).status, 409);
                // activo debe ser booleano
                assert.equal((await pedir('PATCH', `/api/usuarios/${mecanicoNuevo}/estado`, 'administrativo', { activo: 'false' })).status, 400);

                // desactivada: el token que ya tenia deja de valer en la siguiente peticion, y no puede volver a entrar
                const baja = await pedir('PATCH', `/api/usuarios/${mecanicoNuevo}/estado`, 'administrativo', { activo: false });
                assert.equal(baja.status, 200);
                assert.equal(baja.body.estado_cuenta, 'rechazado');
                assert.equal((await conToken('/api/ordenes-trabajo?limit=1')).status, 401, 'la sesion vigente se corta');
                const relogin = await fetch(`${base}/api/auth/login`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: correo, password: 'clave-de-prueba-1' }),
                });
                assert.equal(relogin.status, 403);

                // reactivada: la sesion que tenia no revive (se cerro al desactivarla); entrando de nuevo, si
                assert.equal((await pedir('PATCH', `/api/usuarios/${mecanicoNuevo}/estado`, 'gerente', { activo: true })).status, 200);
                assert.equal((await conToken('/api/ordenes-trabajo?limit=1')).status, 401, 'reactivar no revive la sesion anterior');
                const reentrada = await fetch(`${base}/api/auth/login`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: correo, password: 'clave-de-prueba-1' }),
                });
                assert.equal(reentrada.status, 200);
                token = (await reentrada.json()).token;
                assert.equal((await conToken('/api/ordenes-trabajo?limit=1')).status, 200);

                // un cambio de rol rige de inmediato: el token sigue diciendo mecanico pero ahora es cliente
                await pool.query(`UPDATE usuarios SET rol = 'cliente' WHERE id = $1`, [mecanicoNuevo]);
                assert.equal((await conToken('/api/ordenes-trabajo?limit=1')).status, 403, 'manda el rol de la base, no el del token');

                // una cuenta de cliente no se desactiva por esta ruta (va por Solicitudes)
                assert.equal((await pedir('PATCH', `/api/usuarios/${mecanicoNuevo}/estado`, 'administrativo', { activo: false })).status, 404);

                // el listado trae el estado de cada cuenta
                const lista = await pedir('GET', '/api/usuarios', 'gerente');
                assert.ok(lista.body.every((u) => 'estado_cuenta' in u));
            } finally {
                if (creados.length) await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [creados]);
            }
        });

        test('restablecer la contraseña de otra cuenta: la clave nueva entra, la vieja no, y la sesion abierta se corta', async (t) => {
            if (!requiereBase(t)) return;
            const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
            const correo = `qa.clave.${sufijo}@gomaq.test`;
            const creada = await pedir('POST', '/api/usuarios', 'administrativo', {
                nombre: 'QA clave', email: correo, rol: 'mecanico', password: 'clave-original-1',
            });
            assert.equal(creada.status, 201);
            const id = creada.body.id;
            const entrar = (password) => fetch(`${base}/api/auth/login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: correo, password }),
            });
            try {
                const sesion = await (await entrar('clave-original-1')).json();
                const conToken = (token) => fetch(`${base}/api/ordenes-trabajo?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
                assert.equal((await conToken(sesion.token)).status, 200);

                // el mecanico no restablece claves; una clave corta o mal tipada se rechaza
                assert.equal((await pedir('POST', `/api/usuarios/${id}/password`, 'mecanico', { password: 'otra-clave-nueva' })).status, 403);
                assert.equal((await pedir('POST', `/api/usuarios/${id}/password`, 'administrativo', { password: '123' })).status, 400);
                assert.equal((await pedir('POST', `/api/usuarios/${id}/password`, 'administrativo', { password: 12345678 })).status, 400);
                assert.equal((await conToken(sesion.token)).status, 200, 'un intento rechazado no corta la sesion');

                // sin esperas: el corte no depende de la hora en segundos del token (claim pc, en milisegundos)
                const cambio = await pedir('POST', `/api/usuarios/${id}/password`, 'gerente', { password: 'clave-restablecida-2' });
                assert.equal(cambio.status, 200);
                assert.ok(!JSON.stringify(cambio.body).includes('clave-restablecida-2'), 'nunca devuelve la clave');
                assert.ok(!('password_hash' in cambio.body));

                assert.equal((await conToken(sesion.token)).status, 401, 'la sesion que ya tenia se corta');
                assert.equal((await entrar('clave-original-1')).status, 401, 'la clave vieja ya no sirve');
                const nueva = await entrar('clave-restablecida-2');
                assert.equal(nueva.status, 200, 'la clave nueva entra');
                assert.equal((await conToken((await nueva.json()).token)).status, 200, 'y su sesion funciona de inmediato');

                // las cuentas de cliente y las que no existen quedan fuera
                const cliente = (await pool.query(`SELECT id FROM usuarios WHERE rol = 'cliente' LIMIT 1`)).rows[0];
                if (cliente) assert.equal((await pedir('POST', `/api/usuarios/${cliente.id}/password`, 'administrativo', { password: 'clave-restablecida-2' })).status, 404);
                assert.equal((await pedir('POST', '/api/usuarios/99999999/password', 'administrativo', { password: 'clave-restablecida-2' })).status, 404);
            } finally {
                await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
            }
        });

        test('ETA ajustada y quieto desde: la hora de llegada sigue a la posicion, y un intento fallido espera', async (t) => {
            if (!requiereBase(t)) return;
            const { mejorarEtaConRutas } = require('../src/services/rutasEta');
            const { guardarPosicion } = require('../src/utils/posicionMecanico');
            const { ErrorOrs } = require('../src/services/ors');
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            await pool.query('DELETE FROM uso_ors');
            const ot = (await pool.query(
                `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo, destino_lat, destino_lng, destino_origen)
                 VALUES ($1, $2, $3, 'en_camino', 'eta ajustada', -38.7359, -72.5904, 'cliente') RETURNING id`,
                [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
            datos.ordenes.push(ot);
            const leerOt = async () => (await pool.query(
                `SELECT eta_segundos, eta_calculada_at, eta_fuente, eta_consultas, eta_intento_at,
                        eta_ajustada_llegada_at, eta_ajustada_at FROM ordenes_trabajo WHERE id = $1`, [ot])).rows[0];
            const silencio = { warn() {}, error() {} };
            const origen = { latitud: -38.70, longitud: -72.50 };
            const mitad = { latitud: -38.718, longitud: -72.545 };

            // 1) el servicio falla: el intento queda anotado y el siguiente espera (no gasta otra consulta)
            const falla = { llamar: async () => { throw new ErrorOrs('timeout', 'sin respuesta'); }, hayLlave: () => true, log: silencio };
            assert.equal((await mejorarEtaConRutas(pool, { ordenId: ot, usuarioId: datos.mecanicoId, origen }, falla)).motivo, 'ors_fallo');
            const tras = await mejorarEtaConRutas(pool, { ordenId: ot, usuarioId: datos.mecanicoId, origen }, falla);
            assert.equal(tras.consultada, false);
            assert.equal(tras.motivo, 'muy_reciente');
            assert.equal((await leerOt()).eta_consultas, 1);
            assert.ok((await leerOt()).eta_intento_at);

            // 2) pasado el minimo, una ruta buena se guarda y no hay ajuste todavia
            await pool.query(`UPDATE ordenes_trabajo SET eta_intento_at = now() - interval '10 minutes' WHERE id = $1`, [ot]);
            const buena = { llamar: async () => ({ distancia_m: 9000, segundos: 1200 }), hayLlave: () => true, log: silencio };
            assert.equal((await mejorarEtaConRutas(pool, { ordenId: ot, usuarioId: datos.mecanicoId, origen }, buena)).guardada, true);
            const conRuta = await leerOt();
            assert.equal(conRuta.eta_fuente, 'ors');
            assert.equal(conRuta.eta_ajustada_llegada_at, null);

            // 3) a mitad de camino quedan mas o menos la mitad de los segundos; eta_segundos y eta_calculada_at no cambian
            const hace2min = new Date(Date.now() - 120000);
            const hace1min = new Date(Date.now() - 60000);
            const ahora = new Date();
            await guardarPosicion(pool, { ordenId: ot, usuarioId: datos.mecanicoId, posicion: { ...origen, capturada_en: hace2min.toISOString() } });
            await guardarPosicion(pool, { ordenId: ot, usuarioId: datos.mecanicoId, posicion: { ...mitad, capturada_en: hace1min.toISOString() } });
            const r3 = await guardarPosicion(pool, { ordenId: ot, usuarioId: datos.mecanicoId, posicion: { ...mitad, capturada_en: ahora.toISOString() } });
            assert.equal(r3.eta.fuente, 'ors');
            const ajustada = await leerOt();
            assert.equal(ajustada.eta_segundos, 1200, 'eta_segundos no se toca');
            assert.equal(new Date(ajustada.eta_calculada_at).getTime(), new Date(conRuta.eta_calculada_at).getTime());
            const restante = (new Date(ajustada.eta_ajustada_llegada_at).getTime() - ahora.getTime()) / 1000;
            assert.ok(restante > 300 && restante < 900, `quedaban cerca de la mitad de 1200 s: ${restante}`);
            assert.equal(new Date(ajustada.eta_ajustada_at).getTime(), ahora.getTime());

            // 4) quieto desde: la ultima vez que se movio fue al pasar de `origen` a `mitad` (hace 1 min)
            const pos = (await pool.query('SELECT quieto_desde FROM posiciones_mecanico WHERE usuario_id = $1', [datos.mecanicoId])).rows[0];
            assert.equal(new Date(pos.quieto_desde).getTime(), hace1min.getTime());

            // 5) el portal del cliente ve la hora ajustada y cuando se actualizo, sin coordenadas
            const portal = (await pedirConToken('/api/ordenes-trabajo/mias', tokenCliente(cliente))).body.find((x) => x.id === ot);
            assert.equal(new Date(portal.eta_llegada_at).getTime(), new Date(ajustada.eta_ajustada_llegada_at).getTime());
            assert.equal(new Date(portal.eta_calculada_at).getTime(), ahora.getTime(), 'Actualizada hace X sigue a la posicion');
            assert.equal(portal.eta_aproximada, false, 'escalada desde la ruta real: no es aproximada');
            afirmarClavesPortal(portal);

            // el detalle de la OT (lo ve tambien el mecanico) no trae el estado interno de la ETA
            const detalle = await pedir('GET', `/api/ordenes-trabajo/${ot}`, 'administrativo');
            assert.equal(detalle.status, 200);
            for (const interno of ['eta_origen_lat', 'eta_origen_lng', 'eta_consultas', 'eta_intento_at', 'eta_ajustada_llegada_at', 'eta_ajustada_at']) {
                assert.ok(!(interno in detalle.body), `el detalle no debe traer ${interno}`);
            }

            // 6) al llegar una ruta nueva el ajuste se descarta (manda la ruta real)
            await pool.query(`UPDATE ordenes_trabajo SET eta_intento_at = now() - interval '10 minutes', eta_calculada_at = now() - interval '10 minutes' WHERE id = $1`, [ot]);
            const nueva = { llamar: async () => ({ distancia_m: 4000, segundos: 500 }), hayLlave: () => true, log: silencio };
            assert.equal((await mejorarEtaConRutas(pool, { ordenId: ot, usuarioId: datos.mecanicoId, origen: mitad }, { ...nueva, ahora: new Date() })).guardada, true);
            const despues = await leerOt();
            assert.equal(despues.eta_ajustada_llegada_at, null);
            assert.equal(despues.eta_ajustada_at, null);
            await pool.query('DELETE FROM uso_ors');
        });

        test('una OT finalizada no trae el vehiculo de hoy y dice si habra cobro', async (t) => {
            if (!requiereBase(t)) return;
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            const crear = async () => {
                const ot = (await pool.query(
                    `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo)
                     VALUES ($1, $2, $3, 'en_terreno', 'OT para el cobro') RETURNING id`, [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
                datos.ordenes.push(ot);
                return ot;
            };
            const sinLineas = await crear();
            await cerrarOt(sinLineas, null);
            const conCobro = await crear();
            await agregarLinea(conCobro, { facturable: 'si', precio_unitario: 1000 });
            await cerrarOt(conCobro, 1000);
            const porDefinir = await crear();
            await agregarLinea(porDefinir, { facturable: 'pendiente' });
            await cerrarOt(porDefinir, null);
            await conVehiculo(async () => {
                const r = await pedirConToken('/api/ordenes-trabajo/mias', tokenCliente(cliente));
                const por = Object.fromEntries(r.body.map((o) => [o.id, o]));
                assert.equal(por[sinLineas].cobro, 'sin_cobro');
                assert.equal(por[conCobro].cobro, 'con_cobro');
                assert.equal(por[porDefinir].cobro, 'por_definir');
                for (const id of [sinLineas, conCobro, porDefinir]) {
                    assert.equal(por[id].vehiculo_patente, null, 'finalizada: sin vehiculo');
                    assert.equal(por[id].vehiculo_marca, null);
                    assert.ok(!('valorizacion' in por[id]) && !('facturable' in por[id]));
                }
            });
        });

        test('sigue pidiendo una cuenta de cliente vinculada', async (t) => {
            if (!requiereBase(t)) return;
            assert.equal((await pedir('GET', '/api/ordenes-trabajo/mias', 'mecanico')).status, 403);
            assert.equal((await pedir('GET', '/api/ordenes-trabajo/mias', 'cliente')).status, 400, 'el token de prueba no tiene cliente_id');
        });
    });
});

describe('bloque 6 (parte 1): correcciones de la revision experta', () => {
    const tokenCliente = tokenClienteDe(987656);
    async function conToken(ruta, token) {
        const r = await fetch(`${base}${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
        let json = null;
        try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
        return { status: r.status, body: json, cabeceras: r.headers };
    }

    test('asignada_at es la ultima asignacion aplicada y no pasa de la aceptacion: A acepta, se reasigna a B', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const ot = (await pool.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo)
             VALUES ($1, $2, $3, 'asignada', 'OT reasignada') RETURNING id`, [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
        datos.ordenes.push(ot);
        const evento = (hora) => pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen, aplicado) VALUES ($1, 'asignacion', $2, 'panel', true)`, [ot, hora]);
        const leer = async () => (await conToken('/api/ordenes-trabajo/mias', tokenCliente(cliente))).body.find((o) => o.id === ot);
        // A recibe la OT a las 09:00 y la acepta a las 09:30
        await evento('2026-03-02T09:00:00Z');
        await pool.query(`UPDATE ordenes_trabajo SET estado = 'aceptada', aceptada_at = '2026-03-02T09:30:00Z' WHERE id = $1`, [ot]);
        assert.equal(new Date((await leer()).asignada_at).toISOString(), '2026-03-02T09:00:00.000Z');
        // se reasigna a B a las 10:00: los pasos del viaje se borran y la ultima asignacion es la de B
        await evento('2026-03-02T10:00:00Z');
        await pool.query(`UPDATE ordenes_trabajo SET estado = 'asignada', aceptada_at = NULL WHERE id = $1`, [ot]);
        assert.equal(new Date((await leer()).asignada_at).toISOString(), '2026-03-02T10:00:00.000Z', 'se ve la hora de B');
        // B acepta a las 10:20: una reasignacion posterior a la aceptacion no mueve la linea de tiempo hacia atras
        await pool.query(`UPDATE ordenes_trabajo SET estado = 'aceptada', aceptada_at = '2026-03-02T10:20:00Z' WHERE id = $1`, [ot]);
        await evento('2026-03-02T11:00:00Z');
        const o = await leer();
        assert.equal(new Date(o.asignada_at).toISOString(), '2026-03-02T10:00:00.000Z');
        assert.ok(new Date(o.asignada_at) <= new Date(o.aceptada_at), 'la asignacion nunca es posterior a la aceptacion');
    });

    test('/mias: un cliente no ve las ordenes de otro y la respuesta no se guarda en caches', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = (await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 2')).rows;
        if (clientes.length < 2) return t.skip('la semilla no tiene dos clientes');
        const [a, b] = clientes.map((c) => c.id);
        const equipo = await crearEquipo(null);
        const crear = async (cliente) => {
            const ot = (await pool.query(
                `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo)
                 VALUES ($1, $2, $3, 'en_terreno', 'OT de un cliente') RETURNING id`, [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
            datos.ordenes.push(ot);
            return ot;
        };
        const deA = await crear(a);
        const deB = await crear(b);
        const rA = await conToken('/api/ordenes-trabajo/mias', tokenCliente(a));
        assert.equal(rA.status, 200);
        const idsA = rA.body.map((o) => o.id);
        assert.ok(idsA.includes(deA) && !idsA.includes(deB), 'A solo ve la suya');
        const idsB = (await conToken('/api/ordenes-trabajo/mias', tokenCliente(b))).body.map((o) => o.id);
        assert.ok(idsB.includes(deB) && !idsB.includes(deA), 'B solo ve la suya');
        assert.equal(rA.cabeceras.get('cache-control'), 'no-store');
    });

    test('/dashboard/pendientes no se guarda en caches y /resumen trae todos los estados con 0', async (t) => {
        if (!requiereBase(t)) return;
        const r = await fetch(`${base}/api/dashboard/pendientes`, { headers: { Authorization: `Bearer ${tokens.administrativo}` } });
        assert.equal(r.headers.get('cache-control'), 'no-store');
        const { ESTADOS } = require('../src/utils/estadosOt');
        const resumen = (await pedir('GET', '/api/ordenes-trabajo/resumen', 'administrativo')).body;
        assert.deepEqual(Object.keys(resumen.por_estado).sort(), [...ESTADOS].sort());
        assert.ok(Object.values(resumen.por_estado).every((n) => Number.isInteger(n) && n >= 0));
        assert.equal(Object.values(resumen.por_estado).reduce((x, y) => x + y, 0), resumen.todas);
    });

    test('el cache de arriendos del dashboard dura 30 s y se puede vaciar', async (t) => {
        if (!requiereBase(t)) return;
        const dashboard = require('../src/routes/dashboard');
        dashboard.vaciarCacheArriendos();
        const equipo = await crearEquipo(null);
        const cliente = await algunCliente();
        const antes = (await pedir('GET', '/api/dashboard/pendientes', 'administrativo')).body.arriendos_con_aviso;
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-01-02T09:00:00-03:00', $2)`, [equipo.id, cliente]);
        // dentro de los 30 s el numero no cambia...
        assert.equal((await pedir('GET', '/api/dashboard/pendientes', 'administrativo')).body.arriendos_con_aviso, antes);
        // ...y al vaciar el cache ve el arriendo nuevo
        dashboard.vaciarCacheArriendos();
        assert.equal((await pedir('GET', '/api/dashboard/pendientes', 'administrativo')).body.arriendos_con_aviso, antes + 1);
    });

    test('paginacion de /ordenes-trabajo con fechas repetidas: ninguna fila se repite ni se pierde, en los dos sentidos', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const ids = [];
        // cinco ordenes con exactamente la misma fecha de creacion
        for (let i = 0; i < 5; i++) {
            const ot = (await pool.query(
                `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo, fecha_creacion)
                 VALUES ($1, $2, 'pendiente', 'OT con fecha repetida', '2030-01-01T00:00:00Z') RETURNING id`, [equipo.id, cliente])).rows[0].id;
            datos.ordenes.push(ot);
            ids.push(ot);
        }
        for (const dir of ['asc', 'desc']) {
            const vistos = [];
            // paginas de 2 sobre el filtro Sin asignar, que incluye estas cinco
            for (let offset = 0; ; offset += 2) {
                const r = await pedir('GET', `/api/ordenes-trabajo?sin_asignar=1&dir=${dir}&limit=2&offset=${offset}`, 'administrativo');
                assert.equal(r.status, 200);
                vistos.push(...r.body.items.map((o) => o.id));
                if (!r.body.hay_mas) break;
            }
            assert.equal(new Set(vistos).size, vistos.length, `${dir}: sin repetidos`);
            const total = (await pedir('GET', '/api/ordenes-trabajo?sin_asignar=1&limit=1', 'administrativo')).body.total;
            assert.equal(vistos.length, total, `${dir}: ninguna perdida`);
            for (const id of ids) assert.ok(vistos.includes(id), `${dir}: aparece la orden ${id}`);
            const propias = vistos.filter((id) => ids.includes(id));
            const esperado = [...ids].sort((x, y) => (dir === 'asc' ? x - y : y - x));
            assert.deepEqual(propias, esperado, `${dir}: las de fecha repetida salen por id`);
        }
    });

    test('GET /solicitudes?estado=: filtra por estado y rechaza uno desconocido', async (t) => {
        if (!requiereBase(t)) return;
        const todas = await pedir('GET', '/api/solicitudes', 'administrativo');
        const pendientes = await pedir('GET', '/api/solicitudes?estado=pendiente', 'administrativo');
        assert.equal(pendientes.status, 200);
        assert.ok(pendientes.body.every((x) => x.estado === 'pendiente'));
        assert.ok(pendientes.body.length <= todas.body.length);
        assert.equal((await pedir('GET', '/api/solicitudes?estado=inventado', 'administrativo')).status, 400);
        assert.equal((await pedir('GET', '/api/solicitudes?estado=pendiente', 'mecanico')).status, 403);
    });
});

describe('cambio de cliente y recepcion: el dia se cobra segun la hora de corte', () => {
    const guiaSql = async (equipoId, tipo, fecha, clienteId) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, $2::tipo_guia, 'x', $3, $4) RETURNING id`,
        [equipoId, tipo, fecha, clienteId])).rows[0].id;

    const dosClientes = async () => {
        const r = await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 2');
        if (r.rows.length < 2) return null;
        return [r.rows[0].id, r.rows[1].id];
    };

    const propuesta = (d) => pedir('GET', `/api/facturacion/arriendos/${d}/propuesta`, 'administrativo');
    const enCurso = async (equipoId) => (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'administrativo')).body
        .arriendos.find((a) => a.maquinaria_id === equipoId);
    const pendiente = async (equipoId) => (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body
        .arriendos.find((a) => a.maquinaria_id === equipoId);

    test('ACSA a Prize a las 10:00: el dia 10 se cobra a Prize y ACSA termina el 9', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = await dosClientes();
        if (!clientes) return t.skip('la semilla tiene menos de dos clientes');
        const [acsa, prize] = clientes;
        const equipo = await crearEquipo(null);
        const dA = await guiaSql(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', acsa);
        const dP = await guiaSql(equipo.id, 'despacho', '2026-03-10T10:00:00-03:00', prize);
        const pA = await propuesta(dA);
        assert.equal(pA.status, 200);
        assert.equal(pA.body.falta_recepcion, true);
        assert.equal(pA.body.desde, '2026-03-01');
        assert.equal(pA.body.fin, '2026-03-09');
        // `dias` llega hasta el primer fin de periodo (dia 5 de facturacion), no hasta el fin del arriendo
        assert.equal(pA.body.opciones_hasta.at(-1), '2026-03-09');
        assert.equal(diasEntre(pA.body.desde, pA.body.fin), 9);
        const pendA = await pendiente(equipo.id);
        assert.equal(pendA.cliente_id, acsa);
        assert.equal(pendA.dias, 9);
        assert.equal(pendA.falta_recepcion, true);
        // Prize esta en curso y parte el mismo dia 10
        const curso = await enCurso(equipo.id);
        assert.equal(curso.guia_despacho_id, dP);
        assert.equal(curso.cliente_id, prize);
        assert.equal(curso.inicio_cobro, '2026-03-10');
        assert.equal(curso.desde, '2026-03-10');
    });

    test('ACSA a Prize a las 15:00: el dia 10 se cobra a ACSA y Prize parte el 11', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = await dosClientes();
        if (!clientes) return t.skip('la semilla tiene menos de dos clientes');
        const [acsa, prize] = clientes;
        const equipo = await crearEquipo(null);
        const dA = await guiaSql(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', acsa);
        await guiaSql(equipo.id, 'despacho', '2026-03-10T15:00:00-03:00', prize);
        const pA = await propuesta(dA);
        assert.equal(pA.body.fin, '2026-03-10');
        assert.equal(diasEntre(pA.body.desde, pA.body.fin), 10);
        const curso = await enCurso(equipo.id);
        assert.equal(curso.cliente_id, prize);
        assert.equal(curso.inicio_cobro, '2026-03-11');
        assert.equal(curso.desde, '2026-03-11');
    });

    test('los dias de ACSA y de Prize son contiguos y suman el total, a cualquier hora', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = await dosClientes();
        if (!clientes) return t.skip('la semilla tiene menos de dos clientes');
        const [acsa, prize] = clientes;
        for (const hora of ['00:00', '09:59', '12:59', '13:00', '23:59']) {
            const equipo = await crearEquipo(null);
            const dA = await guiaSql(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', acsa);
            const dP = await guiaSql(equipo.id, 'despacho', `2026-03-10T${hora}:00-03:00`, prize);
            const pA = await propuesta(dA);
            const curso = await enCurso(equipo.id);
            assert.equal(curso.guia_despacho_id, dP);
            const finA = new Date(`${pA.body.fin}T00:00:00Z`).getTime();
            const inicioP = new Date(`${curso.inicio_cobro}T00:00:00Z`).getTime();
            assert.equal(inicioP - finA, 86400000, `fin de ACSA ${pA.body.fin} e inicio de Prize ${curso.inicio_cobro} a las ${hora}`);
        }
    });

    test('el cliente anterior que empezo el mismo dia del cambio queda en 0 dias: nada que facturar', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = await dosClientes();
        if (!clientes) return t.skip('la semilla tiene menos de dos clientes');
        const [acsa, prize] = clientes;
        const equipo = await crearEquipo(null);
        const dA = await guiaSql(equipo.id, 'despacho', '2026-03-10T09:00:00-03:00', acsa);
        await guiaSql(equipo.id, 'despacho', '2026-03-10T10:00:00-03:00', prize);
        const pA = await propuesta(dA);
        assert.equal(pA.body.dias, 0);
        assert.equal(pA.body.nada_que_facturar, true);
        const pend = await pendiente(equipo.id);
        assert.equal(pend, undefined, 'sin dias por facturar no aparece en la lista');
    });

    test('recepcion normal por la ruta real: 10:00 no cobra el dia, 13:00 si', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        for (const [hora, fin] of [['10:00', '2026-03-09'], ['12:59', '2026-03-09'], ['13:00', '2026-03-10']]) {
            const equipo = await crearEquipo(null);
            const dA = await guiaSql(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
            await pool.query('UPDATE maquinarias SET cliente_id = $1 WHERE id = $2', [cliente, equipo.id]);
            const formulario = new FormData();
            formulario.append('tipo', 'recepcion');
            formulario.append('sin_documento', 'true');
            formulario.append('fecha_hora', `2026-03-10T${hora}:00-03:00`);
            const r = await fetch(`${base}/api/maquinarias/${equipo.id}/guias`, {
                method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario });
            assert.equal(r.status, 201, hora);
            const p = await propuesta(dA);
            assert.equal(p.body.fin, fin, `recepcion a las ${hora}`);
        }
    });
});

describe('fin de arriendo guardado: la configuracion nueva rige solo hacia adelante', () => {
    const SQL_028 = () => require('fs').readFileSync(
        require('path').join(__dirname, '../../db/migrations/028_fin_arriendo_hora_corte.sql'), 'utf8');
    const guiaSql = async (equipoId, tipo, fecha, clienteId) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, $2::tipo_guia, 'x', $3, $4) RETURNING id`,
        [equipoId, tipo, fecha, clienteId])).rows[0].id;
    const dosClientes = async () => {
        const r = await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 2');
        return r.rows.length < 2 ? null : [r.rows[0].id, r.rows[1].id];
    };
    const propuesta = (d) => pedir('GET', `/api/facturacion/arriendos/${d}/propuesta`, 'administrativo');
    const pendiente = async (equipoId) => (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body
        .arriendos.find((a) => a.maquinaria_id === equipoId);
    const restaurarConfiguracion = async () => {
        for (const [clave, valor] of Object.entries({ dia_facturacion: 5, hora_corte_despacho: 13, corte_cierra_periodo: true })) {
            await pool.query('UPDATE configuracion SET valor = $2::jsonb, actualizado_por = NULL WHERE clave = $1', [clave, JSON.stringify(valor)]);
        }
    };
    const aplicarMigracion = async () => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SQL_028());
            await client.query('COMMIT');
        } finally {
            client.release();
        }
    };

    test('factura final emitida antes de la migracion (recepcion a las 10): no queda facturado de mas ni pendiente', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guiaSql(equipo.id, 'despacho', '2026-10-01T09:00:00-03:00', cliente);
        const r = await guiaSql(equipo.id, 'recepcion', '2026-11-05T10:00:00-03:00', cliente);
        // como estaba antes de la 028: la recepcion sin fin guardado y la factura final hasta el dia de la recepcion
        await pool.query('UPDATE guias SET fin_cobro = NULL WHERE id = $1', [r]);
        await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, guia_recepcion_id, periodo_desde, periodo_hasta, folio, archivo_url, monto)
             VALUES ($1, $2, $3, '2026-10-01', '2026-11-05', 'T-2801', 'x', 1000)`, [equipo.id, d, r]);
        await aplicarMigracion();
        const fin = (await pool.query("SELECT to_char(fin_cobro, 'YYYY-MM-DD') AS d FROM guias WHERE id = $1", [r])).rows[0].d;
        assert.equal(fin, '2026-11-05', 'el relleno usa la regla con la que se facturo');
        const p = await propuesta(d);
        assert.equal(p.body.fin, '2026-11-05');
        assert.equal(p.body.facturado_de_mas, false);
        assert.equal(p.body.nada_que_facturar, true);
        assert.equal(await pendiente(equipo.id), undefined, 'no aparece en /pendientes');
    });

    test('una recepcion nueva a las 10:00 si termina el dia anterior', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guiaSql(equipo.id, 'despacho', '2026-10-01T09:00:00-03:00', cliente);
        await guiaSql(equipo.id, 'recepcion', '2026-11-05T10:00:00-03:00', cliente);
        assert.equal((await propuesta(d)).body.fin, '2026-11-04');
    });

    test('el relleno respeta incluir_dia_recepcion=false con el que se facturo y es idempotente', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const r = await guiaSql(equipo.id, 'recepcion', '2026-03-05T10:00:00-03:00', cliente);
        await pool.query('UPDATE guias SET fin_cobro = NULL WHERE id = $1', [r]);
        try {
            await pool.query("UPDATE configuracion SET valor = 'false' WHERE clave = 'incluir_dia_recepcion'");
            await aplicarMigracion();
            await aplicarMigracion();
        } finally {
            await pool.query("UPDATE configuracion SET valor = 'true', actualizado_por = NULL WHERE clave = 'incluir_dia_recepcion'");
        }
        const fin = (await pool.query("SELECT to_char(fin_cobro, 'YYYY-MM-DD') AS d FROM guias WHERE id = $1", [r])).rows[0].d;
        assert.equal(fin, '2026-03-04');
    });

    test('cambiar la hora de corte despues de registrar el cambio de cliente y la recepcion no altera ningun fin ni inicio', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = await dosClientes();
        if (!clientes) return t.skip('la semilla tiene menos de dos clientes');
        const [acsa, prize] = clientes;
        const equipo = await crearEquipo(null);
        const dA = await guiaSql(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', acsa);
        const dP = await guiaSql(equipo.id, 'despacho', '2026-03-10T12:00:00-03:00', prize);
        const rP = await guiaSql(equipo.id, 'recepcion', '2026-03-20T11:00:00-03:00', prize);
        const foto = async () => {
            const a = (await propuesta(dA)).body;
            const p = (await propuesta(dP)).body;
            return { finA: a.fin, desdeA: a.desde, desdeP: p.desde, finP: p.fin };
        };
        const antes = await foto();
        assert.deepEqual(antes, { finA: '2026-03-09', desdeA: '2026-03-01', desdeP: '2026-03-10', finP: '2026-03-19' });
        try {
            for (const corte of [0, 9, 12, 23]) {
                assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { hora_corte_despacho: corte })).status, 200);
                assert.deepEqual(await foto(), antes, `con corte ${corte} nada cambia`);
            }
        } finally {
            await restaurarConfiguracion();
        }
        assert.ok(rP);
    });

    test('el PUT con solo incluir_dia_recepcion (obsoleta) responde 200 sin guardar ni tocar quien/cuando', async (t) => {
        if (!requiereBase(t)) return;
        const antes = (await pool.query("SELECT valor::text AS v, actualizado_por, actualizado_at FROM configuracion WHERE clave = 'incluir_dia_recepcion'")).rows[0];
        const r = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { incluir_dia_recepcion: !(antes.v === 'true') });
        assert.equal(r.status, 200);
        assert.equal('incluir_dia_recepcion' in r.body, false);
        const despues = (await pool.query("SELECT valor::text AS v, actualizado_por, actualizado_at FROM configuracion WHERE clave = 'incluir_dia_recepcion'")).rows[0];
        assert.deepEqual(despues, antes, 'la fila no cambia');
        // una clave obsoleta junto a una vigente guarda solo la vigente
        const r2 = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { incluir_dia_recepcion: false, dia_facturacion: 6 });
        assert.equal(r2.status, 200);
        assert.equal(r2.body.dia_facturacion, 6);
        await restaurarConfiguracion();
    });

    test('recepcion antes del corte en los flujos de periodos: parcial, facturado de mas y recepcion repetida', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        // periodo parcial: el fin es el dia anterior a la recepcion de las 10
        const e1 = await crearEquipo(null);
        const d1 = await guiaSql(e1.id, 'despacho', '2026-08-01T09:00:00-03:00', cliente);
        await guiaSql(e1.id, 'recepcion', '2026-10-20T10:00:00-03:00', cliente);
        const p1 = await propuesta(d1);
        assert.equal(p1.body.fin, '2026-10-19');
        assert.equal(p1.body.opciones_hasta[p1.body.opciones_hasta.length - 1], '2026-10-19');
        // recepcion repetida (huerfana): no cambia el fin del arriendo
        await guiaSql(e1.id, 'recepcion', '2026-10-22T10:00:00-03:00', cliente);
        assert.equal((await propuesta(d1)).body.fin, '2026-10-19');
        // facturado de mas: se facturo hasta el 20 y la recepcion (a las 10) registrada despues cierra el 19
        const e2 = await crearEquipo(null);
        const d2 = await guiaSql(e2.id, 'despacho', '2026-10-01T09:00:00-03:00', cliente);
        await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, folio, archivo_url)
             VALUES ($1, $2, '2026-10-01', '2026-10-20', 'T-2802', 'x')`, [e2.id, d2]);
        await guiaSql(e2.id, 'recepcion', '2026-10-20T10:00:00-03:00', cliente);
        const p2 = await propuesta(d2);
        assert.equal(p2.body.fin, '2026-10-19');
        assert.equal(p2.body.facturado_de_mas, true);
    });
});

describe('portal del cliente: equipos anteriores (mias/historicos)', () => {
    const esc = {};
    const tokenCliente = tokenClienteDe(987655);


    const guia = async (equipoId, tipo, fecha, clienteId, creada = null) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id, created_at)
         VALUES ($1, $2::tipo_guia, 'x', $3, $4, COALESCE($5, now())) RETURNING id`,
        [equipoId, tipo, fecha, clienteId, creada])).rows[0].id;

    before(async () => {
        if (!HABILITADO) return;
        const nuevoCliente = async (nombre) => (await pool.query(
            "INSERT INTO clientes (nombre, email) VALUES ($1, 'hist@gomaq.test') RETURNING id", [`${nombre} ${crypto.randomUUID().slice(0, 6)}`])).rows[0].id;
        esc.acsa = await nuevoCliente('ACSA');
        esc.prize = await nuevoCliente('Prize');
        esc.servinut = await nuevoCliente('Servinut');
        esc.sin = await nuevoCliente('Sin documentos');
        // equipo 1: ACSA, Prize, Servinut y de nuevo ACSA (vigente hoy)
        esc.e1 = await crearEquipo(null);
        await guia(esc.e1.id, 'despacho', '2026-01-02T09:00:00-03:00', esc.acsa);
        await guia(esc.e1.id, 'recepcion', '2026-01-20T10:00:00-03:00', esc.acsa);
        await guia(esc.e1.id, 'despacho', '2026-02-02T09:00:00-03:00', esc.prize);
        await guia(esc.e1.id, 'recepcion', '2026-02-10T10:00:00-03:00', esc.prize);
        await guia(esc.e1.id, 'despacho', '2026-03-02T09:00:00-03:00', esc.servinut);
        await guia(esc.e1.id, 'recepcion', '2026-03-12T10:00:00-03:00', esc.servinut);
        await guia(esc.e1.id, 'despacho', '2026-04-02T09:00:00-03:00', esc.acsa);
        await pool.query('UPDATE maquinarias SET cliente_id = $1 WHERE id = $2', [esc.acsa, esc.e1.id]);
        // equipo 2: solo de ACSA (Prize no debe verlo)
        esc.e2 = await crearEquipo(null);
        await guia(esc.e2.id, 'despacho', '2026-05-02T09:00:00-03:00', esc.acsa);
        // equipo 3: Prize solo tiene una guia anterior a la migracion 010 (relleno poco confiable): no debe verlo
        esc.e3 = await crearEquipo(null);
        await guia(esc.e3.id, 'despacho', '2025-06-01T09:00:00-03:00', esc.prize, '2000-01-01T00:00:00Z');
        // equipo 4: Servinut tiene solo una factura de reparacion (por su OT), sin guias
        esc.e4 = await crearEquipo(null);
        esc.ot = (await pool.query(
            "INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo) VALUES ($1, $2, 'finalizada', 'Reparacion Servinut') RETURNING id",
            [esc.e4.id, esc.servinut])).rows[0].id;
        datos.ordenes.push(esc.ot);
        await pool.query("INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, monto) VALUES ($1, 'H-1', 'facturas/h1.pdf', 5000)", [esc.ot]);
    });

    after(async () => {
        if (!HABILITADO || !esc.e1) return;
        const equipos = [esc.e1.id, esc.e2.id, esc.e3.id, esc.e4.id];
        await pool.query('DELETE FROM facturas WHERE maquinaria_id = ANY($1) OR orden_trabajo_id = $2', [equipos, esc.ot]);
        await pool.query('DELETE FROM guias WHERE maquinaria_id = ANY($1)', [equipos]);
        await purgarOrdenes([esc.ot]);
        await pool.query('UPDATE maquinarias SET cliente_id = NULL WHERE id = ANY($1)', [equipos]);
        await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [[esc.acsa, esc.prize, esc.servinut, esc.sin]]);
    });

    const ids = (r) => r.body.map((e) => e.id).sort((a, b) => a - b);

    test('Prize ve el equipo que tuvo aunque hoy este con ACSA, y no ve nada de ACSA', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedirConToken('/api/maquinarias/mias/historicos', tokenCliente(esc.prize));
        assert.equal(r.status, 200);
        assert.deepEqual(ids(r), [esc.e1.id], 'solo el equipo 1: el 2 es de ACSA y el 3 solo tiene una guia anterior a la 010');
        const e1 = r.body[0];
        assert.equal(e1.actual, false, 'hoy esta con ACSA');
        assert.equal(e1.codigo, esc.e1.codigo);
        assert.ok(e1.primer_documento && e1.ultimo_documento);
        assert.ok(new Date(e1.primer_documento) <= new Date(e1.ultimo_documento));
        assert.equal(new Date(e1.primer_documento).toISOString().slice(0, 10), '2026-02-02');
        assert.equal(new Date(e1.ultimo_documento).toISOString().slice(0, 10), '2026-02-10');
        // nada que identifique a otro cliente ni costos
        assert.deepEqual(Object.keys(e1).sort(), ['actual', 'codigo', 'id', 'primer_documento', 'tipo', 'ultimo_documento']);
    });

    test('ACSA ve su equipo vigente y el otro que tuvo, ambos con sus fechas; el actual va primero', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedirConToken('/api/maquinarias/mias/historicos', tokenCliente(esc.acsa));
        assert.equal(r.status, 200);
        assert.deepEqual(ids(r), [esc.e1.id, esc.e2.id].sort((a, b) => a - b));
        const e1 = r.body.find((e) => e.id === esc.e1.id);
        assert.equal(e1.actual, true);
        assert.equal(new Date(e1.primer_documento).toISOString().slice(0, 10), '2026-01-02');
        assert.equal(new Date(e1.ultimo_documento).toISOString().slice(0, 10), '2026-04-02');
        assert.equal(r.body[0].actual, true, 'los vigentes primero');
    });

    test('un equipo que solo tiene una factura de reparacion del cliente tambien aparece', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedirConToken('/api/maquinarias/mias/historicos', tokenCliente(esc.servinut));
        assert.deepEqual(ids(r), [esc.e1.id, esc.e4.id].sort((a, b) => a - b));
    });

    test('un cliente sin documentos recibe una lista vacia', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedirConToken('/api/maquinarias/mias/historicos', tokenCliente(esc.sin));
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, []);
    });

    test('permisos: mecanico, administrativo y gerente 403; token sin cliente_id 400; ?cliente_id se ignora', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await pedir('GET', '/api/maquinarias/mias/historicos', 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/maquinarias/mias/historicos', 'administrativo')).status, 403);
        assert.equal((await pedir('GET', '/api/maquinarias/mias/historicos', 'gerente')).status, 403);
        assert.equal((await pedirConToken('/api/maquinarias/mias/historicos', tokenCliente(null))).status, 400);
        assert.equal((await pedirConToken('/api/maquinarias/mias/historicos', tokenCliente(0))).status, 400);
        const r = await pedirConToken(`/api/maquinarias/mias/historicos?cliente_id=${esc.acsa}`, tokenCliente(esc.prize));
        assert.deepEqual(ids(r), [esc.e1.id], 'sigue siendo Prize');
    });

    test('/mias (equipos de hoy) no cambia y no confunde la ruta nueva con un id', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedirConToken('/api/maquinarias/mias', tokenCliente(esc.acsa));
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.map((e) => e.id), [esc.e1.id]);
        const p = await pedirConToken('/api/maquinarias/mias', tokenCliente(esc.prize));
        assert.deepEqual(p.body, []);
    });

    test('el boton Documentos del equipo anterior abre exactamente los documentos del cliente', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedirConToken(`/api/maquinarias/${esc.e1.id}/documentos`, tokenCliente(esc.prize));
        assert.equal(r.status, 200);
        assert.equal(r.body.documentos.length, 2);
        assert.ok(r.body.documentos.every((d) => d.cliente_id === esc.prize));
    });
});

describe('portal del cliente: equipos anteriores, casos de la revision', () => {
    const esc = {};
    const tokenCliente = tokenClienteDe(987656);

    async function historicos(clienteId) {
        const r = await fetch(`${base}/api/maquinarias/mias/historicos`, { headers: { Authorization: `Bearer ${tokenCliente(clienteId)}` } });
        return { status: r.status, body: await r.json() };
    }

    const guia = async (equipoId, tipo, fecha, clienteId, creada = null) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id, created_at)
         VALUES ($1, $2::tipo_guia, 'x', $3, $4, COALESCE($5, now())) RETURNING id`,
        [equipoId, tipo, fecha, clienteId, creada])).rows[0].id;

    before(async () => {
        if (!HABILITADO) return;
        const nuevoCliente = async (nombre) => (await pool.query(
            "INSERT INTO clientes (nombre, email) VALUES ($1, 'hist2@gomaq.test') RETURNING id", [`${nombre} ${crypto.randomUUID().slice(0, 6)}`])).rows[0].id;
        esc.a = await nuevoCliente('Cliente A');
        esc.b = await nuevoCliente('Cliente B');
        // equipo sin cliente hoy, con una guia de A
        esc.libre = await crearEquipo(null);
        await guia(esc.libre.id, 'despacho', '2026-02-02T09:00:00-03:00', esc.a);
        await guia(esc.libre.id, 'recepcion', '2026-02-10T10:00:00-03:00', esc.a);
        // equipo hoy con B, que A tuvo antes
        esc.deB = await crearEquipo(null);
        await guia(esc.deB.id, 'despacho', '2026-02-02T09:00:00-03:00', esc.a);
        await guia(esc.deB.id, 'despacho', '2026-03-02T09:00:00-03:00', esc.b);
        await pool.query('UPDATE maquinarias SET cliente_id = $1 WHERE id = $2', [esc.b, esc.deB.id]);
        // equipo con una factura colgada de una recepcion anterior a la 010 y otra de un despacho anterior a la 010
        esc.viejo = await crearEquipo(null);
        esc.dVieja = await guia(esc.viejo.id, 'despacho', '2025-05-01T09:00:00-03:00', esc.a, '2000-01-01T00:00:00Z');
        esc.rVieja = await guia(esc.viejo.id, 'recepcion', '2025-05-20T09:00:00-03:00', esc.a, '2000-01-01T00:00:00Z');
        await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_recepcion_id, cliente_id, folio, archivo_url) VALUES ($1, $2, $3, 'HV-1', 'x')`,
            [esc.viejo.id, esc.rVieja, esc.a]);
        esc.viejo2 = await crearEquipo(null);
        esc.dVieja2 = await guia(esc.viejo2.id, 'despacho', '2025-06-01T09:00:00-03:00', esc.a, '2000-01-01T00:00:00Z');
        await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, cliente_id, folio, archivo_url)
             VALUES ($1, $2, '2025-06-02', '2025-06-30', $3, 'HV-2', 'x')`,
            [esc.viejo2.id, esc.dVieja2, esc.a]);
        // equipo con una factura de reparacion con fecha_emision (DATE): debe contar el dia de Santiago
        esc.fe = await crearEquipo(null);
        esc.otFe = (await pool.query(
            "INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo) VALUES ($1, $2, 'finalizada', 'Reparacion') RETURNING id",
            [esc.fe.id, esc.a])).rows[0].id;
        datos.ordenes.push(esc.otFe);
        await pool.query("INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, fecha_emision) VALUES ($1, 'HV-3', 'x', '2026-03-05')", [esc.otFe]);
    });

    after(async () => {
        if (!HABILITADO || !esc.libre) return;
        const equipos = [esc.libre.id, esc.deB.id, esc.viejo.id, esc.viejo2.id, esc.fe.id];
        await pool.query('DELETE FROM facturas WHERE maquinaria_id = ANY($1) OR orden_trabajo_id = $2', [equipos, esc.otFe]);
        await pool.query('DELETE FROM guias WHERE maquinaria_id = ANY($1)', [equipos]);
        await purgarOrdenes([esc.otFe]);
        await pool.query('UPDATE maquinarias SET cliente_id = NULL WHERE id = ANY($1)', [equipos]);
        await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [[esc.a, esc.b]]);
    });

    test('actual es siempre true o false: un equipo sin cliente o con otro cliente da false', async (t) => {
        if (!requiereBase(t)) return;
        const r = await historicos(esc.a);
        assert.equal(r.status, 200);
        for (const id of [esc.libre.id, esc.deB.id]) {
            const e = r.body.find((x) => x.id === id);
            assert.ok(e, `aparece ${id}`);
            assert.strictEqual(e.actual, false);
        }
        assert.ok(r.body.every((e) => typeof e.actual === 'boolean'), 'nunca null');
    });

    test('una factura colgada de una recepcion o de un despacho anterior a la 010 no hace aparecer el equipo', async (t) => {
        if (!requiereBase(t)) return;
        const ids = (await historicos(esc.a)).body.map((e) => e.id);
        assert.ok(!ids.includes(esc.viejo.id), 'factura de recepcion anterior a la 010');
        assert.ok(!ids.includes(esc.viejo2.id), 'factura de despacho anterior a la 010');
    });

    test('sin registro de la migracion 010 no aparecen equipos que solo tienen guias (falla cerrado)', async (t) => {
        if (!requiereBase(t)) return;
        const original = (await pool.query("SELECT nombre FROM schema_migraciones WHERE nombre LIKE '010%'")).rows[0].nombre;
        try {
            await pool.query("UPDATE schema_migraciones SET nombre = 'x-' || nombre WHERE nombre = $1", [original]);
            const r = await historicos(esc.a);
            assert.equal(r.status, 200);
            const ids = r.body.map((e) => e.id);
            assert.ok(!ids.includes(esc.libre.id) && !ids.includes(esc.deB.id), 'solo tenian guias');
            assert.ok(ids.includes(esc.fe.id), 'el equipo con una OT propia sigue');
        } finally {
            await pool.query("UPDATE schema_migraciones SET nombre = $1 WHERE nombre = 'x-' || $1", [original]);
        }
        assert.ok((await pool.query('SELECT 1 FROM schema_migraciones WHERE nombre = $1', [original])).rows.length === 1, 'registro restaurado');
    });

    test('la fecha de una factura con fecha_emision es el dia de Santiago, no el del servidor', async (t) => {
        if (!requiereBase(t)) return;
        const e = (await historicos(esc.a)).body.find((x) => x.id === esc.fe.id);
        assert.ok(e);
        // la OT es de hoy; la factura es del 5 de marzo de 2026 y es la fecha mas antigua del equipo
        assert.equal(new Date(e.primer_documento).toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }), '2026-03-05');
    });
});

describe('validacion de dinero y cantidades (hallazgos del QA)', () => {
    test('corregir el monto de una factura exige pesos enteros', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        await facturarDirecto(ot, 'T-3001');
        const id = (await pool.query('SELECT id FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows[0].id;
        for (const malo of [1234.5, -5, 'abc', '1e3']) {
            const r = await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { monto: malo });
            assert.equal(r.status, 400, String(malo));
        }
        assert.equal(Number((await pool.query('SELECT monto FROM facturas WHERE id = $1', [id])).rows[0].monto), 100000);
        const bien = await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { monto: 123456 });
        assert.equal(bien.status, 200);
        assert.equal(Number(bien.body.monto), 123456);
    });

    test('la valorizacion de la OT exige pesos enteros', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, null);
        for (const malo of [5000.5, -10, 'abc', '1e3']) {
            const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: malo });
            assert.equal(r.status, 400, String(malo));
        }
        const bien = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 5000 });
        assert.equal(bien.status, 200);
    });

    test('crear un insumo valida el costo y conserva el 0', async (t) => {
        if (!requiereBase(t)) return;
        const crear = (costo) => pedir('POST', '/api/insumos', 'administrativo', { nombre: `Insumo QA ${Date.now()}`, unidad_medida: 'lt', costo_unitario: costo });
        for (const malo of [-50, 99.5, 'abc', '1e3']) {
            assert.equal((await crear(malo)).status, 400, String(malo));
        }
        const cero = await crear(0);
        assert.equal(cero.status, 201);
        assert.equal(Number(cero.body.costo_unitario), 0);
        const sin = await crear(undefined);
        assert.equal(sin.status, 201);
        assert.equal(sin.body.costo_unitario, null);
        const mal = await pedir('PATCH', `/api/insumos/${cero.body.id}`, 'administrativo', { costo_unitario: 12.5 });
        assert.equal(mal.status, 400);
        await pool.query('DELETE FROM insumos WHERE id = ANY($1)', [[cero.body.id, sin.body.id]]);
    });

    test('la cantidad de un repuesto acepta litros (2 decimales) pero no exponente', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const agregar = (cantidad) => pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { cantidad, descripcion: 'Aceite', precio_unitario: 1000 });
        for (const mala of ['1e3', '1.234', 0, -1, 'abc']) {
            assert.equal((await agregar(mala)).status, 400, String(mala));
        }
        assert.equal((await agregar(0.5)).status, 201);
    });

    test('un id de insumo no numerico responde 400 y no 500', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/insumos/abc/ingreso', 'administrativo', { cantidad: 1 });
        assert.equal(r.status, 400);
    });
});

// Concurrencia de guias y orden de bloqueo OT -> equipo

async function crearClienteDePrueba(nombre) {
    const r = await pool.query('INSERT INTO clientes (nombre) VALUES ($1) RETURNING id', [`${nombre} ${crypto.randomUUID().slice(0, 6)}`]);
    datos.clientes.push(r.rows[0].id);
    return r.rows[0].id;
}

const haceDias = (n) => new Date(Date.now() - n * 86400000).toISOString();

async function clienteDelEquipo(id) {
    return (await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [id])).rows[0].cliente_id;
}

describe('el cliente del equipo sale de la guia mas reciente por fecha', () => {
    const guia = (equipo, cuerpo) => pedir('POST', `/api/maquinarias/${equipo}/guias`, 'administrativo', { sin_documento: true, ...cuerpo });

    test('una recepcion atrasada no deja sin cliente a un equipo con un despacho mas nuevo', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearClienteDePrueba('Cliente A');
        const b = await crearClienteDePrueba('Cliente B');
        const equipo = await crearEquipo();
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: a, fecha_hora: haceDias(20) })).status, 201);
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: b, fecha_hora: haceDias(1) })).status, 201);
        assert.equal(await clienteDelEquipo(equipo.id), b);
        // llega tarde la recepcion que cerraba el arriendo de A, 10 dias atras
        const recepcion = await guia(equipo.id, { tipo: 'recepcion', fecha_hora: haceDias(10) });
        assert.equal(recepcion.status, 201);
        assert.equal(await clienteDelEquipo(equipo.id), b, 'el equipo sigue con B: su despacho es mas nuevo que la recepcion');
        // la guia de recepcion queda a nombre del cliente que tenia el equipo en SU fecha (A)
        assert.equal(recepcion.body.cliente_id, a);
    });

    test('un despacho atrasado no pisa un despacho mas nuevo', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearClienteDePrueba('Cliente A');
        const b = await crearClienteDePrueba('Cliente B');
        const equipo = await crearEquipo();
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: b, fecha_hora: haceDias(1) })).status, 201);
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: a, fecha_hora: haceDias(5) })).status, 201);
        assert.equal(await clienteDelEquipo(equipo.id), b);
    });

    test('un despacho atrasado no ocupa un equipo cuya ultima guia es una recepcion', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearClienteDePrueba('Cliente A');
        const equipo = await crearEquipo();
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: a, fecha_hora: haceDias(30) })).status, 201);
        assert.equal((await guia(equipo.id, { tipo: 'recepcion', fecha_hora: haceDias(1) })).status, 201);
        assert.equal(await clienteDelEquipo(equipo.id), null);
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: a, fecha_hora: haceDias(10) })).status, 201);
        assert.equal(await clienteDelEquipo(equipo.id), null, 'la recepcion mas reciente manda');
    });

    test('una guia fallida no cambia el cliente del equipo', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearClienteDePrueba('Cliente A');
        const b = await crearClienteDePrueba('Cliente B');
        const equipo = await crearEquipo();
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: a, fecha_hora: haceDias(5) })).status, 201);
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: b, fecha_hora: haceDias(1), fallido: true })).status, 201);
        assert.equal(await clienteDelEquipo(equipo.id), a);
    });

    test('despachos simultaneos a clientes distintos: queda el de la guia con fecha mas reciente', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearClienteDePrueba('Cliente A');
        const b = await crearClienteDePrueba('Cliente B');
        for (let i = 0; i < 12; i++) {
            const equipo = await crearEquipo();
            // el orden de llegada cambia entre vueltas: la ganadora es siempre la de fecha mas nueva
            const viejo = () => guia(equipo.id, { tipo: 'despacho', cliente_id: a, fecha_hora: haceDias(2) });
            const nuevo = () => guia(equipo.id, { tipo: 'despacho', cliente_id: b, fecha_hora: haceDias(1) });
            const resultados = await Promise.all(i % 2 === 0 ? [viejo(), nuevo()] : [nuevo(), viejo()]);
            assert.deepEqual(resultados.map((r) => r.status), [201, 201], `vuelta ${i}`);
            assert.equal(await clienteDelEquipo(equipo.id), b, `vuelta ${i}`);
        }
    });

    test('la guia espera si otra transaccion tiene bloqueado el equipo', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearClienteDePrueba('Cliente A');
        const equipo = await crearEquipo();
        const otra = await pool.connect();
        try {
            await otra.query('BEGIN');
            await otra.query('SELECT 1 FROM maquinarias WHERE id = $1 FOR NO KEY UPDATE', [equipo.id]);
            let terminada = false;
            const pendiente = guia(equipo.id, { tipo: 'despacho', cliente_id: a }).then((r) => { terminada = true; return r; });
            await esperarBloqueos(1, '%FROM maquinarias%');
            assert.equal(terminada, false, 'la guia no debe avanzar mientras el equipo esta bloqueado');
            await otra.query('COMMIT');
            assert.equal((await pendiente).status, 201);
        } finally {
            otra.release();
        }
        assert.equal(await clienteDelEquipo(equipo.id), a);
    });
});

describe('orden de bloqueo OT -> equipo sin ciclos', () => {
    test('un cierre de OT y una lectura de horometro con esa OT no se bloquean entre si', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo();
        const ot = await crearOt('en_terreno', datos.mecanicoId, equipo.id);
        const otra = await pool.connect();
        try {
            // esta transaccion hace lo que hace una lectura de horometro: toma el equipo y despues
            // inserta una lectura que apunta a la OT (KEY SHARE sobre la OT)
            await otra.query('BEGIN');
            await otra.query('SELECT 1 FROM maquinarias WHERE id = $1 FOR NO KEY UPDATE', [equipo.id]);
            // el cierre toma la OT y pide el equipo: queda esperando a la transaccion de arriba
            const cierre = pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { sin_persona: true });
            await esperarBloqueos(1, '%FROM maquinarias%');
            // con FOR UPDATE sobre la OT esto formaba un ciclo (deadlock); con FOR NO KEY UPDATE no
            await otra.query(
                `INSERT INTO lecturas_horometro (maquinaria_id, valor, origen, orden_trabajo_id, usuario_id)
                 VALUES ($1, 10, 'panel', $2, $3)`,
                [equipo.id, ot, datos.mecanicoId]
            );
            await otra.query('COMMIT');
            const r = await cierre;
            assert.equal(r.status, 200, JSON.stringify(r.body));
        } finally {
            await otra.query('ROLLBACK').catch(() => {});
            otra.release();
        }
    });

    test('dos mecanicos abriendo una OT en terreno sobre el mismo equipo a la vez no se bloquean', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo();
        const usados = [];
        for (let vuelta = 0; vuelta < 8; vuelta++) {
            const abrir = (rol) => {
                const uuid = crypto.randomUUID();
                return pedir('POST', '/api/ordenes-trabajo/en-terreno', rol, { maquinaria_id: equipo.id, uuid_cliente: uuid });
            };
            const rs = await Promise.all([abrir('mecanico'), abrir('mecanicoDos'), abrir('mecanico'), abrir('mecanicoDos')]);
            for (const r of rs) {
                assert.equal(r.status, 201, `vuelta ${vuelta}: ${JSON.stringify(r.body)}`);
                usados.push(r.body.id);
            }
        }
        datos.ordenes.push(...usados);
    });

    test('una lectura de horometro con una OT que no existe responde 400', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo();
        const r = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'administrativo', { valor: 5, orden_trabajo_id: 2000000000 });
        assert.equal(r.status, 400);
    });
});

describe('cuentas del equipo: asignar a un desactivado y aprobar con correo repetido', () => {
    test('asignar una OT a un mecanico desactivado responde 400', async (t) => {
        if (!requiereBase(t)) return;
        const correo = `desactivado-${crypto.randomUUID()}@gomaq.test`;
        const u = await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, estado_cuenta)
             VALUES ('Mecanico desactivado de prueba', $1, 'x', 'mecanico', 'rechazado') RETURNING id`,
            [correo]
        );
        try {
            const ot = await crearOt('pendiente', null);
            const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: u.rows[0].id });
            assert.equal(r.status, 400, JSON.stringify(r.body));
            assert.match(r.body.error, /desactivado/);
        } finally {
            await pool.query('DELETE FROM usuarios WHERE id = $1', [u.rows[0].id]);
        }
    });

    test('aprobar una solicitud cuyo correo ya tiene cuenta (otra capitalizacion) responde 409', async (t) => {
        if (!requiereBase(t)) return;
        const correo = `duplicado-${crypto.randomUUID()}@gomaq.test`;
        const u = await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, estado_cuenta)
             VALUES ('Cuenta existente de prueba', $1, 'x', 'cliente', 'activo') RETURNING id`,
            [correo]
        );
        const s = await pool.query(
            `INSERT INTO solicitudes_cliente (nombre_contacto, email, password_hash) VALUES ('Contacto de prueba', $1, 'x') RETURNING id`,
            [correo.toUpperCase()]
        );
        try {
            const r = await pedir('POST', `/api/usuarios/solicitudes/${s.rows[0].id}/aprobar`, 'administrativo', {});
            assert.equal(r.status, 409, JSON.stringify(r.body));
        } finally {
            await pool.query('DELETE FROM solicitudes_cliente WHERE id = $1', [s.rows[0].id]);
            await pool.query('DELETE FROM usuarios WHERE id = $1', [u.rows[0].id]);
        }
    });
});
