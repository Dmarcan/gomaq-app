// Contrato con la app del mecanico: cada cuerpo que la cola de terreno envia, contra las rutas reales.
//
// Los fixtures `fixtures/terreno_cuerpos_v*.json` los escribe la prueba de Dart
// `terreno/test/contrato_cuerpos_test.dart` con el codigo real de la app (ver su cabecera). Aqui se
// envia cada paso, en orden, a su ruta, con el mecanico de la semilla y una OT recien creada, y se
// exige:
//   1. 2xx al primer envio;
//   2. 2xx tambien al repetir el mismo envio (mismo uuid_cliente, como un reintento de la cola), SIN
//      filas nuevas ni cambios: la idempotencia que la cola offline necesita;
//   3. que el primer envio si haya dejado algo (si no, la prueba no probaria nada).
//
// Hay un fixture por version de la app. Se prueban TODOS: los telefonos se actualizan a mano y los
// APK antiguos siguen enviando sus cuerpos, asi que un fixture solo se borra cuando ya no queda
// ningun telefono con esa version.
//
// Convenciones del fixture (las resuelve `resolver`): rutas con :orden, :equipo y :linea; el
// segmento `ot-5/` de una ruta de archivo es la orden; los uuid y las horas se rehacen en cada
// corrida (si se repitieran, el segundo envio de la prueba ya existiria en la base).
//
//   GOMAQ_TEST_ESCRITURA=1 npm test      (con DATABASE_URL local; sin eso se omite, como escritura.test.js)

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-contrato';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);
const CARPETA_FIXTURES = path.join(__dirname, 'fixtures');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// la orden con la que la prueba de Dart armo las rutas de archivo (`ot-5/...`)
const ORDEN_DE_DART = 5;

let servidor;
let base;
let pool;
let tokenMecanico;
let mecanicoId;
const datos = { ordenes: [], equipos: [], insumos: [], inicio: null };

const versiones = fs.existsSync(CARPETA_FIXTURES)
    ? fs.readdirSync(CARPETA_FIXTURES).filter((f) => /^terreno_cuerpos_v.+\.json$/.test(f)).sort()
    : [];

function requiereBase(t) {
    if (!HABILITADO) {
        t.skip('pruebas de escritura deshabilitadas: usar GOMAQ_TEST_ESCRITURA=1 con una base local');
        return false;
    }
    return true;
}

async function enviar(metodo, ruta, cuerpo) {
    const r = await fetch(`${base}${ruta}`, {
        method: metodo,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenMecanico}` },
        body: JSON.stringify(cuerpo),
    });
    let json = null;
    try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
    return { status: r.status, body: json };
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
    app.use('/api/ordenes-trabajo', require('../src/routes/ordenes'));
    app.use('/api/ordenes-trabajo', require('../src/routes/evidencias'));
    app.use('/api/insumos', require('../src/routes/insumos'));
    app.use('/api/horometro', require('../src/routes/horometro').router);
    // la subida de archivos no toca Supabase de verdad: solo se pide la URL firmada
    const { supabase } = require('../src/config/supabase');
    supabase.storage.from = () => ({
        createSignedUploadUrl: async (ruta) => ({
            data: { path: ruta, token: 'token-de-prueba', signedUrl: `https://firmada.test/${ruta}` },
            error: null,
        }),
    });
    await new Promise((resolve) => { servidor = app.listen(0, resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;

    const mecanico = await pool.query("SELECT id, rol FROM usuarios WHERE email = 'mecanico@gomaq.test'");
    mecanicoId = mecanico.rows[0].id;
    tokenMecanico = jwt.sign({ id: mecanicoId, rol: 'mecanico', cliente_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' });
    datos.inicio = new Date();
});

after(async () => {
    if (!HABILITADO) return;
    // todas las OT de los equipos de prueba, incluso la que un paso fallido alcanzo a crear
    const propias = await pool.query('SELECT id FROM ordenes_trabajo WHERE maquinaria_id = ANY($1)', [datos.equipos]);
    const ots = [...new Set([...datos.ordenes, ...propias.rows.map((r) => r.id)])];
    if (ots.length) {
        await pool.query("DELETE FROM notificaciones_pendientes WHERE (payload->>'orden_trabajo_id')::int = ANY($1)", [ots]);
        await pool.query('DELETE FROM posiciones_mecanico WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM lecturas_horometro WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM tramos_trabajo WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM evidencias_fotograficas WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM firmas_recepcion WHERE orden_trabajo_id = ANY($1)', [ots]);
        await pool.query('DELETE FROM movimientos_insumo WHERE orden_trabajo_id = ANY($1)', [ots]);
    }
    if (datos.insumos.length) {
        await pool.query('DELETE FROM movimientos_insumo WHERE insumo_id = ANY($1)', [datos.insumos]);
        await pool.query('DELETE FROM stock_ubicacion WHERE insumo_id = ANY($1)', [datos.insumos]);
    }
    if (ots.length) {
        // ordenes_eventos es de solo insercion (migracion 020): borrar las OT de prueba y su historial
        // exige la via de purga, que vale solo dentro de esta transaccion
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL gomaq.purga = 'on'");
            await client.query('DELETE FROM ordenes_eventos WHERE orden_trabajo_id = ANY($1)', [ots]);
            await client.query('DELETE FROM ordenes_trabajo WHERE id = ANY($1)', [ots]);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
    if (datos.insumos.length) await pool.query('DELETE FROM insumos WHERE id = ANY($1)', [datos.insumos]);
    if (datos.equipos.length) {
        await pool.query('DELETE FROM lecturas_horometro WHERE maquinaria_id = ANY($1)', [datos.equipos]);
        await pool.query('DELETE FROM notificaciones_pendientes WHERE created_at >= $1 AND payload->>\'tipo\' = \'mantencion_proxima\'', [datos.inicio]);
        await pool.query('DELETE FROM maquinarias WHERE id = ANY($1)', [datos.equipos]);
    }
    await new Promise((resolve) => servidor.close(resolve));
    await pool.end();
});

/** Lo que el fixture trae de fijo se cambia por valores validos en esta corrida. */
function resolver(valor, clave, ctx) {
    if (Array.isArray(valor)) return clave === 'servicio_ids' ? ctx.servicios : valor.map((v) => resolver(v, null, ctx));
    if (valor && typeof valor === 'object') {
        return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, resolver(v, k, ctx)]));
    }
    if (typeof valor === 'string') {
        if (UUID.test(valor)) {
            if (!ctx.uuids.has(valor)) ctx.uuids.set(valor, crypto.randomUUID());
            return ctx.uuids.get(valor);
        }
        if (clave === 'ocurrio_en' || clave === 'capturada_en') return new Date(Date.now() - 60 * 1000).toISOString();
        return valor.replaceAll(`ot-${ORDEN_DE_DART}/`, `ot-${ctx.ordenId}/`);
    }
    if (clave === 'maquinaria_id') return ctx.equipoId;
    if (clave === 'orden_trabajo_id') return ctx.ordenId;
    if (clave === 'insumo_id') return ctx.insumoId;
    return valor;
}

function resolverRuta(ruta, ctx) {
    return ruta.replace(':orden', ctx.ordenId).replace(':equipo', ctx.equipoId).replace(':linea', ctx.ultimaLinea);
}

/** Foto de la base alrededor de la OT de la prueba: si un reintento duplica algo, cambia. */
async function foto(ctx) {
    // las OT del equipo de prueba: la propia y la que crea el paso crear_ot
    const ids = (await pool.query('SELECT id FROM ordenes_trabajo WHERE maquinaria_id = $1', [ctx.equipoId])).rows.map((r) => r.id);
    const una = async (sql, params) => Number((await pool.query(sql, params)).rows[0].n);
    return {
        ordenes: await una('SELECT count(*) AS n FROM ordenes_trabajo WHERE id = ANY($1)', [ids]),
        eventos: await una('SELECT count(*) AS n FROM ordenes_eventos WHERE orden_trabajo_id = ANY($1)', [ids]),
        estados: (await pool.query('SELECT string_agg(estado::text, \',\' ORDER BY id) AS e FROM ordenes_trabajo WHERE id = ANY($1)', [ids])).rows[0].e,
        tramos: await una('SELECT count(*) AS n FROM tramos_trabajo WHERE orden_trabajo_id = ANY($1)', [ids]),
        tramosCerrados: await una('SELECT count(*) AS n FROM tramos_trabajo WHERE orden_trabajo_id = ANY($1) AND termino IS NOT NULL', [ids]),
        horometro: await una('SELECT count(*) AS n FROM lecturas_horometro WHERE maquinaria_id = $1', [ctx.equipoId]),
        lineas: await una('SELECT count(*) AS n FROM movimientos_insumo WHERE orden_trabajo_id = ANY($1)', [ids]),
        lineasAnuladas: await una('SELECT count(*) AS n FROM movimientos_insumo WHERE orden_trabajo_id = ANY($1) AND anulada_at IS NOT NULL', [ids]),
        evidencias: await una('SELECT count(*) AS n FROM evidencias_fotograficas WHERE orden_trabajo_id = ANY($1)', [ids]),
        firmas: await una('SELECT count(*) AS n FROM firmas_recepcion WHERE orden_trabajo_id = ANY($1)', [ids]),
        checklist: await una('SELECT count(*) AS n FROM ot_servicios WHERE orden_trabajo_id = ANY($1)', [ids]),
        avisos: await una("SELECT count(*) AS n FROM notificaciones_pendientes WHERE (payload->>'orden_trabajo_id')::int = ANY($1)", [ids]),
    };
}

/** Tipos cuyo efecto no cambia ningun conteo de la foto: se comprueba directo en la base. */
const EFECTOS_DIRECTOS = {
    datos_ot: async (ctx, cuerpo) => {
        const fila = (await pool.query('SELECT tipo_servicio, folio_papel, observacion_final FROM ordenes_trabajo WHERE id = $1', [ctx.ordenId])).rows[0];
        assert.equal(fila.tipo_servicio, cuerpo.tipo_servicio);
        assert.equal(fila.folio_papel, cuerpo.folio_papel);
        assert.equal(fila.observacion_final, cuerpo.observacion_final);
    },
    posicion: async (ctx, cuerpo) => {
        const fila = (await pool.query('SELECT latitud, longitud FROM posiciones_mecanico WHERE usuario_id = $1 AND orden_trabajo_id = $2', [mecanicoId, ctx.ordenId])).rows[0];
        assert.ok(fila, 'la posicion debe quedar guardada');
        assert.ok(Math.abs(Number(fila.latitud) - cuerpo.latitud) < 0.01);
    },
    solicitar_subida: async () => {},
};

for (const archivo of versiones) {
    const fixture = JSON.parse(fs.readFileSync(path.join(CARPETA_FIXTURES, archivo), 'utf8'));

    describe(`contrato con la app de terreno ${fixture.version}`, () => {
        const ctx = { uuids: new Map(), ordenId: null, equipoId: null, insumoId: null, servicios: [], ultimaLinea: null };

        before(async () => {
            if (!HABILITADO) return;
            // equipo, repuesto y OT propios: no dependen de lo que dejen otras pruebas
            const equipo = await pool.query(
                "INSERT INTO maquinarias (codigo, tipo) VALUES ($1, 'Equipo de contrato') RETURNING id", [`ZZ-${crypto.randomUUID().slice(0, 8)}`]);
            ctx.equipoId = equipo.rows[0].id;
            datos.equipos.push(ctx.equipoId);
            const insumo = await pool.query(
                "INSERT INTO insumos (nombre, unidad_medida) VALUES ($1, 'unidad') RETURNING id", [`Insumo de contrato ${crypto.randomUUID()}`]);
            ctx.insumoId = insumo.rows[0].id;
            datos.insumos.push(ctx.insumoId);
            // la OT parte asignada: la app la acepta, sale en camino, llega y cierra
            const ot = await pool.query(
                `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo)
                 VALUES ($1, NULL, $2, 'asignada', 'OT de prueba de contrato') RETURNING id`, [ctx.equipoId, mecanicoId]);
            ctx.ordenId = ot.rows[0].id;
            datos.ordenes.push(ctx.ordenId);
            ctx.servicios = (await pool.query('SELECT id FROM servicios_checklist WHERE activo ORDER BY id LIMIT 2')).rows.map((r) => r.id);
            assert.equal(ctx.servicios.length, 2, 'la migracion 013 carga el checklist');
        });

        test('el fixture trae pasos', () => {
            assert.ok(Array.isArray(fixture.pasos) && fixture.pasos.length >= 10, `fixture ${archivo} sin pasos`);
        });

        fixture.pasos.forEach((paso, i) => {
            test(`paso ${i + 1}: ${paso.tipo} (${paso.metodo} ${paso.ruta}) responde 2xx y el reintento no duplica`, async (t) => {
                if (!requiereBase(t)) return;
                const cuerpo = resolver(paso.cuerpo, null, ctx);
                const ruta = resolverRuta(paso.ruta, ctx);
                const antes = await foto(ctx);

                const primera = await enviar(paso.metodo, ruta, cuerpo);
                assert.ok(primera.status >= 200 && primera.status < 300,
                    `primer envio: se esperaba 2xx y respondio ${primera.status} ${JSON.stringify(primera.body)}`);
                if (paso.tipo === 'crear_ot') datos.ordenes.push(primera.body.id);
                const tras = await foto(ctx);
                if (EFECTOS_DIRECTOS[paso.tipo]) {
                    await EFECTOS_DIRECTOS[paso.tipo](ctx, cuerpo);
                } else {
                    assert.notDeepEqual(tras, antes, 'el primer envio debe dejar algo en la base');
                }
                if (paso.tipo === 'insumo') ctx.ultimaLinea = primera.body.id;

                const repetida = await enviar(paso.metodo, ruta, cuerpo);
                assert.ok(repetida.status >= 200 && repetida.status < 300,
                    `reintento: se esperaba 2xx y respondio ${repetida.status} ${JSON.stringify(repetida.body)}`);
                // la OT creada por el paso se cuenta tambien en la foto del reintento
                assert.deepEqual(await foto(ctx), tras, 'el reintento con el mismo uuid_cliente no debe tocar la base');
            });
        });
    });
}

describe('fixtures del contrato con terreno', () => {
    test('hay al menos un fixture (si se borran todos, el contrato deja de probarse)', () => {
        assert.ok(versiones.length >= 1, `no hay terreno_cuerpos_v*.json en ${CARPETA_FIXTURES}`);
    });
});
