// Entorno compartido de las pruebas de escritura contra una base local.
//
// Levanta las rutas en memoria sobre la base de `DATABASE_URL`, firma los tokens de prueba, reemplaza
// el almacenamiento por un doble y, al terminar, borra todo lo que las pruebas crearon. Cada archivo
// de escritura lo carga con `require` y ya queda con sus propios `before` y `after`.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test
//
// Sin esa variable se omiten con el motivo, igual que la bateria de integracion.
//
// Los tokens se firman con un secreto propio de la prueba: no se usa ninguna credencial real.

require('dotenv').config();
const { exigirBaseLocal } = require('../_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-escritura';

const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { servirApp, leerRespuesta, pedirConToken: pedirConTokenEn } = require('./http');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
// los archivos de prueba piden `pool` antes de que `before` abra la conexion: se resuelve al usarlo
const poolPerezoso = new Proxy({}, {
    get: (_, clave) => (typeof pool[clave] === 'function' ? pool[clave].bind(pool) : pool[clave]),
    set: (_, clave, valor) => { pool[clave] = valor; return true; },
});
const entorno = { get base() { return base; } };
const datos = { usuariosPush: [], ordenes: [], insumos: [], equipos: [], ubicaciones: [], solicitudes: [], clientes: [], storage: { subidos: [], borrados: [] } };
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
    pool = require('../../src/config/db');
    // verifyToken revisa la cuenta en la base. Los usuarios reales se buscan ahi; los tokens de
    // relleno de los portales (ids 98765x, que no existen) valen lo que firman, como antes.
    require('../../src/middleware/auth').usarBuscadorDeUsuarios(async (id, claims) => {
        if (id >= 987000) return { rol: claims.rol, cliente_id: claims.cliente_id ?? null, estado_cuenta: 'activo' };
        const r = await pool.query('SELECT rol, cliente_id, estado_cuenta, password_cambiada_at FROM usuarios WHERE id = $1', [id]);
        return r.rows[0] || null;
    });

    const app = express();
    app.use(express.json());
    app.use('/api/ordenes-trabajo', require('../../src/routes/ordenes'));
    app.use('/api/ordenes-trabajo', require('../../src/routes/evidencias'));
    app.use('/api/ordenes-trabajo', require('../../src/routes/facturas'));
    app.use('/api/solicitudes', require('../../src/routes/solicitudes'));
    app.use('/api/insumos', require('../../src/routes/insumos'));
    app.use('/api/horometro', require('../../src/routes/horometro').router);
    app.use('/api/facturacion', require('../../src/routes/facturacion'));
    app.use('/api/notificaciones', require('../../src/routes/notificaciones'));
    app.use('/api/dashboard', require('../../src/routes/dashboard'));
    app.use('/api/usuarios', require('../../src/routes/usuarios'));
    app.use('/api/auth', require('../../src/routes/auth'));
    app.use('/api/rentabilidad', require('../../src/routes/rentabilidad'));
    app.use('/api/clientes', require('../../src/routes/clientes'));
    app.use('/api/maquinarias', require('../../src/routes/maquinarias'));
    app.use('/api/maquinarias', require('../../src/routes/guias'));
    app.use('/api/dispositivos', require('../../src/routes/dispositivos'));
    // la subida de la factura no toca Supabase de verdad: se anotan los archivos que se suben y borran
    const { supabase } = require('../../src/config/supabase');
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
    if (datos.usuariosPush.length) {
        await pool.query('DELETE FROM dispositivos_push WHERE usuario_id = ANY($1)', [datos.usuariosPush]);
        await pool.query('DELETE FROM sesiones WHERE usuario_id = ANY($1)', [datos.usuariosPush]);
        await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [datos.usuariosPush]);
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


// Ayudas compartidas por varios archivos de prueba
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

/** Eventos de una OT en el orden en que se registraron. */
async function eventosDe(ot) {
    const r = await pool.query('SELECT * FROM ordenes_eventos WHERE orden_trabajo_id = $1 ORDER BY id', [ot]);
    return r.rows;
}

/** Eventos de la OT de un tipo, en el orden en que se escribieron (id). */
async function eventosTipo(ot, tipo) {
    const r = await pool.query(
        'SELECT * FROM ordenes_eventos WHERE orden_trabajo_id = $1 AND tipo = $2 ORDER BY id', [ot, tipo]);
    return r.rows;
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

module.exports = {
    pool: poolPerezoso,
    datos,
    tokens,
    entorno,
    HABILITADO,
    pedir,
    pedirConToken,
    purgarOrdenes,
    crearOt,
    crearInsumoConStock,
    crearFurgonDePrueba,
    stockBodega,
    CLAVES_OT_PORTAL,
    afirmarClavesPortal,
    MOTIVO_VALIDO,
    crearEquipo,
    algunCliente,
    eventosDe,
    eventosTipo,
    cerrarOt,
    facturarDirecto,
    agregarLinea,
    rutaLinea,
    subirFactura,
    otValorizada,
    estadoValorizacion,
    esperarBloqueos,
    pendientesDeValorizar,
};
