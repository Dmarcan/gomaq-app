// Prueba de escritura del script de carga de clientes (scripts/cargar_clientes.js) contra una base local.
// Usa un archivo de clientes ficticios (fixtures/clientes_prueba.json) y borra lo que crea.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test
//
// Sin esa variable (o sin DATABASE_URL) se omite, igual que las demas pruebas de escritura.

require('dotenv').config();
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { cargarClientes } = require('../scripts/cargar_clientes');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);
const RUTS = ['11111111-1', '22222222-2', '33333333-3'];
const clientes = require('./fixtures/clientes_prueba.json').clientes;

describe('carga de clientes con la base', { skip: HABILITADO ? false : 'pruebas de escritura deshabilitadas: usar GOMAQ_TEST_ESCRITURA=1 con una base local' }, () => {
    let db;
    let ejecutivosAntes;

    const limpiar = async () => {
        await db.query(
            "DELETE FROM clientes WHERE upper(regexp_replace(rut, '[^0-9kK]', '', 'g')) = ANY($1)",
            [RUTS.map((r) => r.replace('-', ''))]
        );
        await db.query(
            'DELETE FROM ejecutivos WHERE id <> ALL($1::int[]) AND nombre = ANY($2::text[])',
            [ejecutivosAntes, ['Freddy', 'Alejandra', 'Wenceslao', 'Oscar']]
        );
    };
    const contar = async (tabla) => (await db.query(`SELECT COUNT(*)::int AS n FROM ${tabla}`)).rows[0].n;

    before(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL });
        await db.connect();
        ejecutivosAntes = (await db.query('SELECT id FROM ejecutivos')).rows.map((r) => r.id);
        await limpiar();
    });
    after(async () => {
        if (!db) return;
        await limpiar();
        await db.end();
    });

    test('--simular no cambia ni clientes ni ejecutivos', async () => {
        const c0 = await contar('clientes');
        const e0 = await contar('ejecutivos');
        const r = await cargarClientes(db, clientes, { simular: true });
        assert.equal(r.nuevos, 3);
        assert.equal(await contar('clientes'), c0);
        assert.equal(await contar('ejecutivos'), e0);
    });

    test('la carga real inserta, sin correo ni telefono, y la segunda corrida no inserta nada', async () => {
        // un cliente que ya existe con el RUT escrito con puntos: no se duplica ni se modifica
        await db.query("INSERT INTO clientes (nombre, rut, giro) VALUES ('Existente Prueba', '22.222.222-2', 'No tocar')");
        const c0 = await contar('clientes');

        const r1 = await cargarClientes(db, clientes, { simular: false });
        assert.equal(r1.nuevos, 2);
        assert.equal(r1.yaExistian, 1);
        assert.equal(await contar('clientes'), c0 + 2);
        assert.deepEqual(r1.porEjecutivo, { Oscar: 1 });
        assert.equal(r1.sinEjecutivo, 1);
        assert.deepEqual(r1.ejecutivosCreados.sort(), ['Alejandra', 'Freddy', 'Oscar', 'Wenceslao']);

        const existente = (await db.query("SELECT nombre, giro, plazo_pago_dias, ejecutivo_id FROM clientes WHERE rut = '22.222.222-2'")).rows;
        assert.equal(existente.length, 1);
        assert.deepEqual(existente[0], { nombre: 'Existente Prueba', giro: 'No tocar', plazo_pago_dias: null, ejecutivo_id: null });

        const nuevos = (await db.query(
            "SELECT c.rut, c.email, c.telefono, c.giro, c.plazo_pago_dias, e.nombre AS ejecutivo FROM clientes c LEFT JOIN ejecutivos e ON e.id = c.ejecutivo_id WHERE c.rut IN ('11111111-1', '33333333-3') ORDER BY c.rut"
        )).rows;
        assert.deepEqual(nuevos, [
            { rut: '11111111-1', email: null, telefono: null, giro: 'Servicios de prueba', plazo_pago_dias: 30, ejecutivo: 'Oscar' },
            { rut: '33333333-3', email: null, telefono: null, giro: 'Comercio', plazo_pago_dias: 0, ejecutivo: null },
        ]);

        const e1 = await contar('ejecutivos');
        const r2 = await cargarClientes(db, clientes, { simular: false });
        assert.equal(r2.nuevos, 0);
        assert.equal(r2.yaExistian, 3);
        assert.deepEqual(r2.ejecutivosCreados, []);
        assert.equal(await contar('clientes'), c0 + 2);
        assert.equal(await contar('ejecutivos'), e1);
    });

    test('un archivo con correo no inserta nada', async () => {
        const c0 = await contar('clientes');
        await assert.rejects(
            cargarClientes(db, [{ ...clientes[0], rut: '33333333-3', email: 'a@b.cl' }], { simular: false }),
            /no se inserto nada/
        );
        assert.equal(await contar('clientes'), c0);
    });

    test('cargar_equipos.js --simular no guarda nada', () => {
        const salida = execFileSync(process.execPath, [path.join(__dirname, '../scripts/cargar_equipos.js'), '--simular'], {
            env: process.env, encoding: 'utf8',
        });
        assert.match(salida, /Simulacion: no se guardo nada/);
        assert.match(salida, /96 en el archivo/);
    });
});
