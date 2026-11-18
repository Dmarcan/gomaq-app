// Pruebas de POST /api/facturacion/exportar sin base ni Supabase reales: la consulta (pool.query) y el
// almacenamiento se reemplazan por dobles, y los tokens se firman con un secreto de la prueba.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-solo-para-pruebas-de-exportar';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ci.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'clave-solo-para-pruebas';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { servirApp, leerRespuesta } = require('./utils/http');
const zlib = require('node:zlib');
const jwt = require('jsonwebtoken');
const express = require('express');
const { creerEnElToken } = require('./_sesionDePrueba');

let servidor;
let base;
let pool;
let consultas;
let filasDeLaBase;
let subidas;
let errorSubida;
const token = (rol, id = 5) => jwt.sign({ id, rol, cliente_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' });

const filaBase = (c = {}) => ({
    id: 1, folio: '1500', orden_trabajo_id: null, cliente_rut: '11111111-1', cliente_nombre: 'Cliente Ficticio',
    cliente_direccion: null, cliente_giro: null, cliente_email: null, ejecutivo_nombre: null, categoria_equipo: 'alzahombre',
    tipo_equipo: 'Plataforma', modelo: null, marca: null, maquinaria_codigo: 'PL-1232', periodo_desde: '2026-10-01',
    periodo_hasta: '2026-10-31', monto: '119000', monto_neto: null, monto_traslado: '0', traslado_entrega: null,
    traslado_retiro: null, fecha_emision: '2026-11-02', fecha_ref: '2026-11-02', fecha_vencimiento: '2026-11-01',
    fecha_pago: null, anulada_nc: null, hoy: '2026-11-17', ...c,
});

before(async () => {
    creerEnElToken();
    pool = require('../src/config/db');
    pool.query = async (sql, params) => {
        consultas.push({ sql, params });
        return { rows: filasDeLaBase };
    };
    const { supabase } = require('../src/config/supabase');
    supabase.storage.from = (bucket) => ({
        upload: async (ruta, datos, opciones) => {
            subidas.push({ bucket, ruta, datos, opciones });
            return errorSubida ? { data: null, error: { message: 'falla simulada' } } : { data: {}, error: null };
        },
        createSignedUrl: async (ruta, segundos) => ({ data: { signedUrl: `https://firmada.test/${ruta}?exp=${segundos}` }, error: null }),
    });
    const app = express();
    app.use(express.json());
    app.use('/api/facturacion', require('../src/routes/facturacion'));
    ({ servidor, base } = await servirApp(app));
});

after(async () => {
    await new Promise((resolve) => servidor.close(resolve));
});

function reiniciar() {
    consultas = [];
    subidas = [];
    errorSubida = false;
    filasDeLaBase = [filaBase(), filaBase({ id: 2, folio: 'X-9', monto_neto: '100000' })];
}

async function exportar(rol, cuerpo, id) {
    const headers = { 'Content-Type': 'application/json' };
    if (rol) headers.Authorization = `Bearer ${token(rol, id)}`;
    const r = await fetch(`${base}/api/facturacion/exportar`, { method: 'POST', headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
    return leerRespuesta(r);
}

test('sin token: 401', async () => {
    reiniciar();
    assert.equal((await exportar(null, {})).status, 401);
    assert.equal(consultas.length, 0);
});

test('mecanico y cliente: 403 y no se consulta ni se sube nada', async () => {
    reiniciar();
    for (const rol of ['mecanico', 'cliente']) {
        assert.equal((await exportar(rol, {})).status, 403, rol);
    }
    assert.equal(consultas.length, 0);
    assert.equal(subidas.length, 0);
});

test('administrativo y gerente: 200, sube el xlsx al bucket privado y devuelve la url firmada de 1 hora', async () => {
    for (const [rol, id] of [['administrativo', 5], ['gerente', 9]]) {
        reiniciar();
        const r = await exportar(rol, {}, id);
        assert.equal(r.status, 200, rol);
        assert.equal(r.body.filas, 2);
        assert.equal(r.body.sin_neto, 1);
        assert.equal(r.body.generado_en, '2026-11-17');
        assert.equal(r.body.url, `https://firmada.test/exportaciones/facturacion-usuario-${id}.xlsx?exp=3600`);
        assert.equal(subidas.length, 1);
        assert.equal(subidas[0].ruta, `exportaciones/facturacion-usuario-${id}.xlsx`);
        assert.equal(subidas[0].opciones.upsert, true);
        assert.equal(subidas[0].opciones.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        assert.equal(subidas[0].datos.subarray(0, 2).toString(), 'PK');
        assert.ok(subidas[0].bucket);
    }
});

test('el archivo subido trae la hoja CLIENTES con las filas', async () => {
    reiniciar();
    await exportar('administrativo', {});
    const buf = subidas[0].datos;
    // busca la parte de la hoja por el directorio central
    const fin = buf.length - 22;
    let pos = buf.readUInt32LE(fin + 16);
    let hoja = null;
    for (let i = 0; i < buf.readUInt16LE(fin + 10); i += 1) {
        const largo = buf.readUInt16LE(pos + 28);
        const nombre = buf.toString('utf8', pos + 46, pos + 46 + largo);
        if (nombre === 'xl/worksheets/sheet1.xml') {
            const desp = buf.readUInt32LE(pos + 42);
            const inicio = desp + 30 + buf.readUInt16LE(desp + 26) + buf.readUInt16LE(desp + 28);
            hoja = zlib.inflateRawSync(buf.subarray(inicio, inicio + buf.readUInt32LE(pos + 20))).toString('utf8');
        }
        pos += 46 + largo + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
    }
    assert.ok(hoja);
    assert.match(hoja, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">CLIENTES MENSUALES<\/t>/);
    assert.match(hoja, /<c r="A4" t="inlineStr"><is><t xml:space="preserve">Rut<\/t>/);
    assert.match(hoja, /<c r="Y4" t="inlineStr"><is><t xml:space="preserve">DIAS MORA<\/t>/);
    assert.match(hoja, /<c r="Q5" t="inlineStr"><is><t xml:space="preserve">F\/1500<\/t>/);
    assert.match(hoja, /<c r="Q6" t="inlineStr"><is><t xml:space="preserve">X-9<\/t>/);
    assert.match(hoja, /<c r="Y5"><v>16<\/v>/);
});

test('los filtros llegan a la consulta como parametros', async () => {
    reiniciar();
    const r = await exportar('gerente', { desde: '2026-01-01', hasta: '2026-06-30', cliente_id: 12 });
    assert.equal(r.status, 200);
    assert.deepEqual(consultas[0].params, [12, '2026-01-01', '2026-06-30']);
    reiniciar();
    await exportar('gerente');
    assert.deepEqual(consultas[0].params, [null, null, null]);
});

test('filtros invalidos: 400 sin consultar', async () => {
    reiniciar();
    for (const cuerpo of [
        { desde: '2026-13-01' }, { hasta: 'ayer' }, { desde: 20260101 }, { cliente_id: 'abc' }, { cliente_id: -1 },
        { desde: '2026-06-02', hasta: '2026-06-01' },
    ]) {
        assert.equal((await exportar('administrativo', cuerpo)).status, 400, JSON.stringify(cuerpo));
    }
    assert.equal(consultas.length, 0);
});

test('mas de 5.000 facturas: 400 y no se sube nada', async () => {
    reiniciar();
    filasDeLaBase = Array.from({ length: 5001 }, (_, i) => filaBase({ id: i + 1 }));
    const r = await exportar('administrativo', {});
    assert.equal(r.status, 400);
    assert.match(r.body.error, /5000/);
    assert.equal(subidas.length, 0);
});

test('sin facturas: 200 con 0 filas', async () => {
    reiniciar();
    filasDeLaBase = [];
    const r = await exportar('administrativo', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.filas, 0);
    assert.match(r.body.generado_en, /^\d{4}-\d{2}-\d{2}$/);
});

test('si falla la subida: 500 sin url', async () => {
    reiniciar();
    errorSubida = true;
    const r = await exportar('administrativo', {});
    assert.equal(r.status, 500);
    assert.equal(r.body.url, undefined);
});
