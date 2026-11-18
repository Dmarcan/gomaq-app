// Pruebas de escritura de la cobranza (migracion 038): trigger del traslado, lista de facturas emitidas,
// tarjetas del inicio, marcar pagada o anulada con nota de credito, subida y correccion de facturas con los
// campos nuevos (y sin ellos, como el panel anterior) y la rentabilidad con neto y nota de credito.
// Rutas en memoria sobre la base de DATABASE_URL, datos FICTICIOS propios que se borran al terminar y tokens
// firmados con un secreto de la prueba. Supabase no se llama: la subida del PDF se simula.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-cobranza';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { requiereBase, servirApp, leerRespuesta } = require('./utils/http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
const tokens = {};
const datos = { clientes: [], equipos: [], guias: [], facturas: [] };
const sufijo = crypto.randomUUID().slice(0, 6).toUpperCase();

async function pedir(metodo, ruta, rol, cuerpo) {
    const headers = { 'Content-Type': 'application/json' };
    if (rol) headers.Authorization = `Bearer ${tokens[rol]}`;
    const r = await fetch(`${base}${ruta}`, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
    return leerRespuesta(r);
}

async function facturar(campos, rol = 'administrativo') {
    const formulario = new FormData();
    for (const [k, v] of Object.entries(campos)) if (v !== undefined && v !== null) formulario.append(k, String(v));
    formulario.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'f.pdf');
    const r = await fetch(`${base}/api/facturacion/arriendo`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[rol]}` }, body: formulario });
    let body = null;
    try { body = await r.json(); } catch (_) { /* sin cuerpo */ }
    if (body && body.id) datos.facturas.push(body.id);
    return { status: r.status, body };
}

before(async () => {
    if (!HABILITADO) return;
    exigirBaseLocal();
    const express = require('express');
    pool = require('../src/config/db');
    const app = express();
    app.use(express.json());
    app.use('/api/facturacion', require('../src/routes/facturacion'));
    app.use('/api/dashboard', require('../src/routes/dashboard'));
    app.use('/api/rentabilidad', require('../src/routes/rentabilidad'));
    const { supabase } = require('../src/config/supabase');
    supabase.storage.from = () => ({
        upload: async () => ({ data: {}, error: null }),
        remove: async () => ({ data: [], error: null }),
        createSignedUrl: async (ruta) => ({ data: { signedUrl: `https://firmada.test/${ruta}` }, error: null }),
    });
    ({ servidor, base } = await servirApp(app));

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

    const EQUIPOS_DE_PRUEBA = 5;
    const codigos = Array.from({ length: EQUIPOS_DE_PRUEBA }, () => `CB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`);
    const eq = await pool.query(
        `INSERT INTO maquinarias (codigo, tipo) SELECT c, 'Equipo de prueba' FROM unnest($1::text[]) AS c RETURNING id, codigo`, [codigos]);
    datos.equipos.push(...eq.rows.map((e) => e.id));
    equiposLibres.push(...eq.rows);
});

after(async () => {
    if (!HABILITADO) return;
    if (datos.facturas.length) await pool.query('DELETE FROM facturas WHERE id = ANY($1)', [datos.facturas]);
    if (datos.guias.length) await pool.query('DELETE FROM guias WHERE id = ANY($1)', [datos.guias]);
    if (datos.equipos.length) await pool.query('DELETE FROM maquinarias WHERE id = ANY($1)', [datos.equipos]);
    if (datos.clientes.length) await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [datos.clientes]);
    await new Promise((resolve) => servidor.close(resolve));
    await pool.end();
});

/** Dia de hoy en Santiago mas `n` dias, segun la base. */
async function dia(n) {
    return (await pool.query(`SELECT (((now() AT TIME ZONE 'America/Santiago')::date) + $1::int)::text AS d`, [n])).rows[0].d;
}

async function crearCliente(nombre, plazo = null) {
    const r = await pool.query('INSERT INTO clientes (nombre, plazo_pago_dias) VALUES ($1, $2) RETURNING id', [`${nombre} ${sufijo}`, plazo]);
    datos.clientes.push(r.rows[0].id);
    return r.rows[0].id;
}

// Los equipos de la prueba se crean todos juntos al inicio, en un solo INSERT: otras pruebas que corren en
// paralelo comparan dos lecturas de la flota y no deben ver aparecer un equipo entre una y otra.
const equiposLibres = [];
async function crearEquipo() {
    if (equiposLibres.length === 0) throw new Error('faltan equipos de prueba: subir EQUIPOS_DE_PRUEBA');
    return equiposLibres.shift();
}

/** Corre `fn` en una transaccion: lo que inserta aparece de una vez para las demas pruebas. */
async function enTransaccion(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const r = await fn(client);
        await client.query('COMMIT');
        return r;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function insertarFactura(campos, db = pool) {
    const columnas = Object.keys(campos);
    const r = await db.query(
        `INSERT INTO facturas (archivo_url, ${columnas.join(', ')}) VALUES ('facturas/prueba.pdf', ${columnas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        Object.values(campos));
    datos.facturas.push(r.rows[0].id);
    return r.rows[0];
}

/**
 * Arriendo cerrado de un equipo nuevo, con el periodo que propone el sistema. Despacho y recepcion van en
 * un solo INSERT: el arriendo nunca se ve "en curso" desde otra prueba que corre en paralelo.
 */
async function arriendo(clienteId) {
    const equipo = await crearEquipo();
    const g = await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id)
         VALUES ($1, 'despacho', 'x', '2026-08-01T09:00:00-03:00', $2), ($1, 'recepcion', 'x', '2026-08-20T14:00:00-03:00', $2)
         RETURNING id, tipo::text AS tipo`,
        [equipo.id, clienteId]);
    datos.guias.push(...g.rows.map((x) => x.id));
    const d = g.rows.find((x) => x.tipo === 'despacho').id;
    const p = await pedir('GET', `/api/facturacion/arriendos/${d}/propuesta`, 'administrativo');
    assert.equal(p.status, 200, JSON.stringify(p.body));
    return { equipo, d, desde: p.body.desde, hasta: p.body.hasta_sugerido };
}

describe('migracion 038', () => {
    test('se puede correr otra vez sin error (dentro de una transaccion que se deshace)', async (t) => {
        if (!requiereBase(t)) return;
        const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '038_facturas_cobranza.sql'), 'utf8');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query(sql);
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
    });

    test('el trigger borra una division que no cuadra (como si el servidor anterior corrigiera el total)', async (t) => {
        if (!requiereBase(t)) return;
        const f = await insertarFactura({ folio: `TR-${sufijo}`, monto: 249900, monto_traslado: 140000, traslado_entrega: 70000, traslado_retiro: 70000 });
        assert.equal(Number(f.traslado_entrega), 70000);
        assert.equal(Number(f.traslado_retiro), 70000);
        // el servidor anterior solo escribe el total
        const u = (await pool.query('UPDATE facturas SET monto_traslado = 100000 WHERE id = $1 RETURNING *', [f.id])).rows[0];
        assert.equal(u.traslado_entrega, null);
        assert.equal(u.traslado_retiro, null);
        assert.equal(Number(u.monto_traslado), 100000);
        // una division que no suma el total no se guarda al insertar
        const mala = await insertarFactura({ folio: `TR2-${sufijo}`, monto: 100000, monto_traslado: 30000, traslado_entrega: 20000, traslado_retiro: 20000 });
        assert.equal(mala.traslado_entrega, null);
        assert.equal(mala.traslado_retiro, null);
        // solo entrega, con el retiro nulo: cuadra y se guarda
        const sola = await insertarFactura({ folio: `TR3-${sufijo}`, monto: 100000, monto_traslado: 30000, traslado_entrega: 30000 });
        assert.equal(Number(sola.traslado_entrega), 30000);
        assert.equal(sola.traslado_retiro, null);
        // un cambio que no toca el traslado conserva la division
        const otra = (await pool.query("UPDATE facturas SET folio = folio || 'X' WHERE id = $1 RETURNING *", [sola.id])).rows[0];
        assert.equal(Number(otra.traslado_entrega), 30000);
    });

    test('el trigger borra un neto mayor que el monto (como si el servidor anterior bajara el monto)', async (t) => {
        if (!requiereBase(t)) return;
        const f = await insertarFactura({ folio: `NT-${sufijo}`, monto: 249900, monto_neto: 210000 });
        assert.equal(Number(f.monto_neto), 210000);
        // un monto que sigue siendo mayor o igual al neto lo conserva
        const igual = (await pool.query('UPDATE facturas SET monto = 210000 WHERE id = $1 RETURNING *', [f.id])).rows[0];
        assert.equal(Number(igual.monto_neto), 210000);
        // el servidor anterior baja el monto bajo el neto: el neto se borra y vuelve la regla anterior
        const bajo = (await pool.query('UPDATE facturas SET monto = 100000 WHERE id = $1 RETURNING *', [f.id])).rows[0];
        assert.equal(bajo.monto_neto, null);
        assert.equal(Number(bajo.monto), 100000);
        // al insertar, un neto mayor que el monto no se guarda
        const mala = await insertarFactura({ folio: `NT2-${sufijo}`, monto: 1000, monto_neto: 2000 });
        assert.equal(mala.monto_neto, null);
        // sin monto no hay con que comparar: el neto se conserva
        const sinMonto = await insertarFactura({ folio: `NT3-${sufijo}`, monto_neto: 5000 });
        assert.equal(Number(sinMonto.monto_neto), 5000);
    });

    test('los CHECK nuevos rechazan montos negativos y un folio de NC vacio', async (t) => {
        if (!requiereBase(t)) return;
        await assert.rejects(insertarFactura({ folio: `CK-${sufijo}`, monto: 1000, monto_neto: -1 }), /facturas_cobranza_montos_chk/);
        await assert.rejects(insertarFactura({ folio: `CK2-${sufijo}`, monto: 1000, anulada_nc: '  ' }), /facturas_anulada_nc_chk/);
    });
});

describe('roles y validaciones', () => {
    test('sin token 401; mecanico y cliente 403; el gerente lee pero no marca pago', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await pedir('GET', '/api/facturacion/emitidas', null)).status, 401);
        assert.equal((await pedir('PATCH', '/api/facturacion/1/pago', null, { fecha_pago: null })).status, 401);
        for (const rol of ['mecanico', 'cliente']) {
            assert.equal((await pedir('GET', '/api/facturacion/emitidas', rol)).status, 403, rol);
            assert.equal((await pedir('PATCH', '/api/facturacion/1/pago', rol, { fecha_pago: null })).status, 403, rol);
        }
        assert.equal((await pedir('GET', '/api/facturacion/emitidas?limit=1', 'gerente')).status, 200);
        assert.equal((await pedir('GET', '/api/facturacion/emitidas?limit=1', 'administrativo')).status, 200);
        assert.equal((await pedir('PATCH', '/api/facturacion/1/pago', 'gerente', { fecha_pago: null })).status, 403);
    });

    test('filtros y ids invalidos responden 400; factura inexistente 404', async (t) => {
        if (!requiereBase(t)) return;
        for (const q of ['estado=otra', 'cliente_id=abc', 'cliente_id=0', 'desde=2026-02-30', 'hasta=ayer', 'estado[]=vencidas']) {
            assert.equal((await pedir('GET', `/api/facturacion/emitidas?${q}`, 'administrativo')).status, 400, q);
        }
        assert.equal((await pedir('PATCH', '/api/facturacion/abc/pago', 'administrativo', { fecha_pago: null })).status, 400);
        assert.equal((await pedir('PATCH', '/api/facturacion/2147483647/pago', 'administrativo', { fecha_pago: null })).status, 404);
        assert.equal((await pedir('PATCH', '/api/facturacion/1/pago', 'administrativo', {})).status, 400, 'sin campos');
    });
});

describe('lista de emitidas, tarjetas y pago', () => {
    test('cada estado sale con su filtro y el contador del inicio es el largo de la lista', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await crearCliente('Cobranza Ficticia');
        const equipo = await crearEquipo();
        const base = { cliente_id: cliente, maquinaria_id: equipo.id, monto: 119000, fecha_emision: await dia(-40) };
        const d = {};
        for (const n of [-10, -5, -3, -1, 0, 7, 8]) d[n] = await dia(n);
        const [vencida, venceHoy, proxima, alDia, pagada, anulada, sinVenc] = await enTransaccion(async (c) => [
            await insertarFactura({ ...base, folio: `V-${sufijo}`, fecha_vencimiento: d[-3] }, c),
            await insertarFactura({ ...base, folio: `H-${sufijo}`, fecha_vencimiento: d[0] }, c),
            await insertarFactura({ ...base, folio: `P-${sufijo}`, fecha_vencimiento: d[7] }, c),
            await insertarFactura({ ...base, folio: `A-${sufijo}`, fecha_vencimiento: d[8] }, c),
            await insertarFactura({ ...base, folio: `G-${sufijo}`, fecha_vencimiento: d[-10], fecha_pago: d[-1] }, c),
            await insertarFactura({ ...base, folio: `N-${sufijo}`, fecha_vencimiento: d[-5], anulada_nc: '76' }, c),
            await insertarFactura({ ...base, folio: `S-${sufijo}`, fecha_emision: null }, c),
        ]);

        const lista = async (estado) => (await pedir('GET', `/api/facturacion/emitidas?cliente_id=${cliente}&estado=${estado}`, 'administrativo')).body;
        const ids = (b) => b.items.map((x) => x.id);
        assert.deepEqual(ids(await lista('vencidas')), [vencida.id]);
        assert.deepEqual(ids(await lista('proximas')), [venceHoy.id, proxima.id], 'vence hoy y en 7 dias, la mas cercana primero');
        assert.deepEqual(ids(await lista('pagadas')), [pagada.id]);
        assert.deepEqual(ids(await lista('anuladas')), [anulada.id]);
        assert.deepEqual(new Set(ids(await lista('por_cobrar'))), new Set([vencida.id, venceHoy.id, proxima.id, alDia.id, sinVenc.id]));
        const todas = await lista('todas');
        assert.equal(todas.total, 7);
        const porId = Object.fromEntries(todas.items.map((x) => [x.id, x]));
        assert.equal(porId[vencida.id].estado_cobranza, 'vencida');
        assert.equal(porId[vencida.id].dias_mora, 3);
        assert.equal(porId[venceHoy.id].estado_cobranza, 'proxima');
        assert.equal(porId[venceHoy.id].dias_para_vencer, 0);
        assert.equal(porId[proxima.id].dias_para_vencer, 7);
        assert.equal(porId[alDia.id].estado_cobranza, 'al_dia');
        assert.equal(porId[pagada.id].estado_cobranza, 'pagada');
        assert.equal(porId[pagada.id].dias_mora, 9, 'pagada tarde');
        assert.equal(porId[anulada.id].estado_cobranza, 'anulada');
        assert.equal(porId[sinVenc.id].estado_cobranza, 'sin_vencimiento');
        assert.equal(porId[vencida.id].cliente_nombre, `Cobranza Ficticia ${sufijo}`);
        assert.equal(porId[vencida.id].maquinaria_codigo, equipo.codigo);
        assert.equal(porId[vencida.id].tipo, 'arriendo');
        assert.equal(porId[vencida.id].monto, 119000);
        assert.equal(JSON.stringify(todas).includes('archivo_url'), false, 'sin documentos');
        assert.equal(JSON.stringify(todas).includes('prueba.pdf'), false);

        // busqueda por folio y paginacion
        const buscada = (await pedir('GET', `/api/facturacion/emitidas?q=V-${sufijo}`, 'gerente')).body;
        assert.deepEqual(ids(buscada), [vencida.id]);
        const pagina = (await pedir('GET', `/api/facturacion/emitidas?cliente_id=${cliente}&limit=2&offset=0`, 'gerente')).body;
        assert.equal(pagina.items.length, 2);
        assert.equal(pagina.total, 7);
        assert.equal(pagina.hay_mas, true);
        // un comodin en la busqueda se toma como texto
        assert.equal((await pedir('GET', `/api/facturacion/emitidas?cliente_id=${cliente}&q=%25`, 'gerente')).body.total, 0);

        // el contador de las tarjetas es el largo de la lista completa (mismo predicado)
        const resumen = (await pedir('GET', '/api/dashboard/resumen', 'gerente')).body;
        const vencidasTodas = (await pedir('GET', '/api/facturacion/emitidas?estado=vencidas', 'administrativo')).body;
        const proximasTodas = (await pedir('GET', '/api/facturacion/emitidas?estado=proximas', 'administrativo')).body;
        assert.equal(resumen.cobranza.vencidas, vencidasTodas.items.length);
        assert.equal(resumen.cobranza.vencidas, vencidasTodas.total);
        assert.equal(resumen.cobranza.proximas, proximasTodas.items.length);
        assert.ok(resumen.cobranza.vencidas >= 1 && resumen.cobranza.proximas >= 2);
        assert.ok(resumen.atajos, 'el resto del resumen sigue igual');
    });

    test('marcar pagada, deshacer, anular con nota de credito y deshacer', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await crearCliente('Pago Ficticio');
        const f = await insertarFactura({ cliente_id: cliente, folio: `MP-${sufijo}`, monto: 50000, fecha_emision: await dia(-30), fecha_vencimiento: await dia(-2) });
        const estado = async () => (await pedir('GET', `/api/facturacion/emitidas?cliente_id=${cliente}`, 'gerente')).body.items[0];
        assert.equal((await estado()).estado_cobranza, 'vencida');

        const hoy = await dia(0);
        // marcar pagada una factura por cobrar exige el comprobante (foto o PDF): sin archivo, 400 y nada cambia
        const sinComprobante = await pedir('PATCH', `/api/facturacion/${f.id}/pago`, 'administrativo', { fecha_pago: hoy });
        assert.equal(sinComprobante.status, 400, JSON.stringify(sinComprobante.body));
        assert.match(sinComprobante.body.error, /comprobante/i);
        assert.equal((await estado()).estado_cobranza, 'vencida');
        assert.equal((await pedir('GET', `/api/facturacion/${f.id}/comprobante`, 'administrativo')).status, 404, 'sin comprobante no hay enlace');
        // una factura que ya estaba pagada antes de esta regla (sin comprobante) conserva su pago y puede corregirse la fecha
        await pool.query('UPDATE facturas SET fecha_pago = $2 WHERE id = $1', [f.id, hoy]);
        const pago = await pedir('PATCH', `/api/facturacion/${f.id}/pago`, 'administrativo', { fecha_pago: hoy });
        assert.equal(pago.status, 200, JSON.stringify(pago.body));
        assert.equal(pago.body.tiene_comprobante, false);
        assert.equal(pago.body.id, f.id);
        assert.equal(pago.body.fecha_pago, hoy);
        assert.equal(pago.body.estado_cobranza, 'pagada');
        assert.equal(pago.body.dias_mora, 2);
        const vencidas = (await pedir('GET', `/api/facturacion/emitidas?cliente_id=${cliente}&estado=vencidas`, 'gerente')).body;
        assert.equal(vencidas.total, 0, 'la pagada sale de vencidas');

        const futura = await pedir('PATCH', `/api/facturacion/${f.id}/pago`, 'administrativo', { fecha_pago: await dia(1) });
        assert.equal(futura.status, 400);
        assert.equal((await pedir('PATCH', `/api/facturacion/${f.id}/pago`, 'administrativo', { fecha_pago: '2026-02-30' })).status, 400);

        const deshacer = await pedir('PATCH', `/api/facturacion/${f.id}/pago`, 'administrativo', { fecha_pago: null });
        assert.equal(deshacer.status, 200);
        assert.equal(deshacer.body.estado_cobranza, 'vencida');

        const nc = await pedir('PATCH', `/api/facturacion/${f.id}/pago`, 'administrativo', { anulada_nc: ' NC-76 ' });
        assert.equal(nc.status, 200);
        assert.equal(nc.body.anulada_nc, 'NC-76');
        assert.equal(nc.body.estado_cobranza, 'anulada');
        assert.equal(nc.body.dias_mora, 0);
        assert.equal((await pedir('GET', `/api/facturacion/emitidas?cliente_id=${cliente}&estado=vencidas`, 'gerente')).body.total, 0);
        assert.equal((await pedir('PATCH', `/api/facturacion/${f.id}/pago`, 'administrativo', { anulada_nc: 'a;b' })).status, 400);
        // la anulacion no borra la fila: el periodo facturado sigue facturado
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM facturas WHERE id = $1', [f.id])).rows[0].n, 1);

        const sinNc = await pedir('PATCH', `/api/facturacion/${f.id}/pago`, 'administrativo', { anulada_nc: null });
        assert.equal(sinNc.body.anulada_nc, null);
        assert.equal(sinNc.body.estado_cobranza, 'vencida');
    });
});

describe('subida y correccion de la factura de arriendo', () => {
    test('un panel anterior sin los campos nuevos sigue recibiendo 201', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await crearCliente('Panel Antiguo');
        const a = await arriendo(cliente);
        const r = await facturar({ guia_despacho_id: a.d, periodo_desde: a.desde, periodo_hasta: a.hasta, folio: `OLD-${sufijo}`, monto: 119000, monto_traslado: 20000 });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(Number(r.body.monto_traslado), 20000);
        assert.equal(r.body.monto_neto, null);
        assert.equal(r.body.traslado_entrega, null);
        assert.equal(r.body.fecha_emision, null);
        assert.equal(r.body.fecha_vencimiento, null);
    });

    test('guarda neto, division del traslado, emision y vencimiento; valida que cuadren', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await crearCliente('Factura Nueva', 45);
        const a = await arriendo(cliente);
        const emision = await dia(-5);
        const vencimiento = await dia(40);
        const comun = { guia_despacho_id: a.d, periodo_desde: a.desde, periodo_hasta: a.hasta, monto: 249900, monto_neto: 210000 };

        // tres montos de traslado que no cuadran, traslado mayor que el neto, vencimiento antes de la emision, neto mayor que el total
        assert.equal((await facturar({ ...comun, folio: 'X1', monto_traslado: 140000, traslado_entrega: 70000, traslado_retiro: 60000 })).status, 400);
        assert.equal((await facturar({ ...comun, folio: 'X2', monto_neto: 100000, traslado_entrega: 70000, traslado_retiro: 70000 })).status, 400);
        assert.equal((await facturar({ ...comun, folio: 'X3', fecha_emision: emision, fecha_vencimiento: await dia(-6) })).status, 400);
        assert.equal((await facturar({ ...comun, folio: 'X4', monto_neto: 300000 })).status, 400);
        assert.equal((await facturar({ ...comun, folio: 'X5', fecha_emision: '2035-01-01' })).status, 400);

        const r = await facturar({ ...comun, folio: `NEW-${sufijo}`, traslado_entrega: 70000, traslado_retiro: 70000, fecha_emision: emision, fecha_vencimiento: vencimiento });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(Number(r.body.monto_traslado), 140000, 'sin total, el total es la suma de las partes');
        assert.equal(Number(r.body.traslado_entrega), 70000);
        assert.equal(Number(r.body.traslado_retiro), 70000);
        assert.equal(Number(r.body.monto_neto), 210000);
        assert.equal(r.body.fecha_emision, emision);
        assert.equal(r.body.fecha_vencimiento, vencimiento);

        // correccion: solo el total -> la division vieja ya no cuadra y el trigger la borra
        const soloTotal = await pedir('PATCH', `/api/facturacion/${r.body.id}`, 'administrativo', { monto_traslado: 100000 });
        assert.equal(soloTotal.status, 200, JSON.stringify(soloTotal.body));
        assert.equal(Number(soloTotal.body.monto_traslado), 100000);
        assert.equal(soloTotal.body.traslado_entrega, null);
        assert.equal(Number(soloTotal.body.monto_neto), 210000, 'lo no enviado no cambia');
        assert.equal(soloTotal.body.fecha_vencimiento, vencimiento);

        // correccion: las partes -> el total es su suma
        const partes = await pedir('PATCH', `/api/facturacion/${r.body.id}`, 'administrativo', { traslado_entrega: 50000, traslado_retiro: 40000 });
        assert.equal(partes.status, 200, JSON.stringify(partes.body));
        assert.equal(Number(partes.body.monto_traslado), 90000);
        assert.equal(Number(partes.body.traslado_entrega), 50000);
        assert.equal(Number(partes.body.traslado_retiro), 40000);

        // un total que sigue cuadrando conserva la division
        const mismo = await pedir('PATCH', `/api/facturacion/${r.body.id}`, 'administrativo', { folio: `NEW2-${sufijo}` });
        assert.equal(Number(mismo.body.traslado_entrega), 50000);

        // reglas contra lo guardado: neto menor que el traslado, vencimiento antes de la emision guardada
        assert.equal((await pedir('PATCH', `/api/facturacion/${r.body.id}`, 'administrativo', { monto_neto: 80000 })).status, 400);
        assert.equal((await pedir('PATCH', `/api/facturacion/${r.body.id}`, 'administrativo', { fecha_vencimiento: await dia(-6) })).status, 400);
        assert.equal((await pedir('PATCH', `/api/facturacion/${r.body.id}`, 'administrativo', { traslado_entrega: 1, traslado_retiro: 1, monto_traslado: 5 })).status, 400);

        // borrar neto y vencimiento con null
        const borrar = await pedir('PATCH', `/api/facturacion/${r.body.id}`, 'administrativo', { monto_neto: null, fecha_vencimiento: null });
        assert.equal(borrar.status, 200);
        assert.equal(borrar.body.monto_neto, null);
        assert.equal(borrar.body.fecha_vencimiento, null);
        assert.equal(borrar.body.fecha_emision, emision);
    });

    test('ventas por ejecutivo cuenta la factura de arriendo por su emision guardada', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await crearCliente('Ventas Ficticia');
        const a = await arriendo(cliente);
        // una fecha que ninguna otra prueba usa
        const emision = '2011-03-07';
        const r = await facturar({ guia_despacho_id: a.d, periodo_desde: a.desde, periodo_hasta: a.hasta, folio: `VE-${sufijo}`, monto: 333000, fecha_emision: emision });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        const v = await pedir('GET', `/api/dashboard/ventas-por-ejecutivo?desde=${emision}&hasta=${emision}`, 'gerente');
        assert.equal(v.status, 200);
        assert.equal(v.body.total_general, 333000);
    });
});

describe('rentabilidad con neto y nota de credito', () => {
    test('antigua como antes, nueva en neto y la anulada con NC no cuenta', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo();
        const anulada = await enTransaccion(async (c) => {
            await insertarFactura({ folio: `R1-${sufijo}`, maquinaria_id: equipo.id, monto: 249900, monto_traslado: 140000 }, c);
            await insertarFactura({ folio: `R2-${sufijo}`, maquinaria_id: equipo.id, monto: 249900, monto_traslado: 140000, monto_neto: 210000 }, c);
            return insertarFactura({ folio: `R3-${sufijo}`, maquinaria_id: equipo.id, monto: 500000, monto_neto: 420000, anulada_nc: '9' }, c);
        });

        // hasta explicito (pasado mañana): el reloj del proceso y el de la base pueden diferir unos milisegundos
        const hasta = await dia(2);
        const detalle = await pedir('GET', `/api/rentabilidad/maquinaria/${equipo.id}?hasta=${hasta}`, 'gerente');
        assert.equal(detalle.status, 200, JSON.stringify(detalle.body));
        assert.equal(detalle.body.ingreso, 109900 + 70000 + 0);
        const fa = detalle.body.facturas.find((x) => x.id === anulada.id);
        assert.equal(fa.ingreso, 0);
        assert.equal(fa.anulada_nc, '9');
        assert.equal(fa.monto_neto, 420000);

        const flota = await pedir('GET', `/api/rentabilidad?q=${equipo.codigo}&hasta=${hasta}`, 'administrativo');
        assert.equal(flota.status, 200);
        assert.equal(flota.body.items.find((x) => x.id === equipo.id).ingreso, 179900, 'una sola regla para la flota y el detalle');
    });
});
