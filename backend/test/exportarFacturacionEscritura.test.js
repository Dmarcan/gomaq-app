// La consulta de la exportacion contra una base real (datos FICTICIOS propios, se borran al terminar).
// Las pruebas sin base (exportarFacturacion.test.js y exportarFacturacionRuta.test.js) no validan el SQL.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);
const sufijo = crypto.randomUUID().slice(0, 6).toUpperCase();
let pool;
const creado = { cliente: null, ejecutivo: null, equipo: null, facturas: [] };

before(async () => {
    if (!HABILITADO) return;
    pool = require('../src/config/db');
    creado.ejecutivo = (await pool.query(`INSERT INTO ejecutivos (nombre) VALUES ($1) RETURNING id`, [`Vendedor Prueba ${sufijo}`])).rows[0].id;
    creado.cliente = (await pool.query(
        `INSERT INTO clientes (nombre, rut, email, direccion, giro, ejecutivo_id) VALUES ($1, '11111111-1', 'x@ficticio.test', 'Calle 1', 'Giro de prueba', $2) RETURNING id`,
        [`Cliente Exportar ${sufijo}`, creado.ejecutivo]
    )).rows[0].id;
    creado.equipo = (await pool.query(
        `INSERT INTO maquinarias (codigo, tipo, marca, modelo, categoria_equipo) VALUES ($1, 'Plataforma', 'MarcaX', 'M-1', 'alzahombre') RETURNING id`,
        [`EX-${crypto.randomUUID().slice(0, 6).toUpperCase()}1232`]
    )).rows[0].id;
    for (const [folio, monto, neto, traslado, emision] of [['9001', 249900, 210000, 140000, '2026-05-10'], ['9002', 119000, null, 0, '2026-06-10']]) {
        const r = await pool.query(
            `INSERT INTO facturas (folio, archivo_url, monto, monto_neto, monto_traslado, fecha_emision, fecha_vencimiento, cliente_id, maquinaria_id, periodo_desde, periodo_hasta)
             VALUES ($1, 'x.pdf', $2, $3, $4, $5::date, $5::date + 30, $6, $7, $5::date, $5::date + 30) RETURNING id`,
            [folio, monto, neto, traslado, emision, creado.cliente, creado.equipo]
        );
        creado.facturas.push(r.rows[0].id);
    }
});

after(async () => {
    if (!HABILITADO) return;
    if (creado.facturas.length) await pool.query('DELETE FROM facturas WHERE id = ANY($1)', [creado.facturas]);
    if (creado.equipo) await pool.query('DELETE FROM maquinarias WHERE id = ANY($1)', [[creado.equipo]]);
    if (creado.cliente) await pool.query('DELETE FROM clientes WHERE id = $1', [creado.cliente]);
    if (creado.ejecutivo) await pool.query('DELETE FROM ejecutivos WHERE id = $1', [creado.ejecutivo]);
    await pool.end();
});

test('la consulta de exportacion funciona contra la base y arma las filas', async (t) => {
    if (!HABILITADO) return t.skip('pruebas de escritura deshabilitadas: usar GOMAQ_TEST_ESCRITURA=1 con una base local');
    const { cargarFilasExportacion, armarHoja, ENCABEZADOS } = require('../src/utils/exportarFacturacion');
    const { items, hoy } = await cargarFilasExportacion(pool, { clienteId: creado.cliente });
    assert.equal(items.length, 2);
    assert.match(hoy, /^\d{4}-\d{2}-\d{2}$/);
    const { matriz, filas, sin_neto: sinNeto } = armarHoja(items, { hoy });
    assert.equal(filas, 2);
    assert.equal(sinNeto, 1);
    const c = (fila, nombre) => matriz[fila][ENCABEZADOS.indexOf(nombre)];
    assert.equal(c(4, 'Factura N°'), 'F/9001'); // ordenadas por emision
    assert.equal(c(5, 'Factura N°'), 'F/9002');
    assert.equal(c(4, 'Rut'), '11111111-1');
    assert.equal(c(4, 'CONTACTO'), `Vendedor Prueba ${sufijo}`);
    assert.equal(c(4, 'Giro'), 'Giro de prueba');
    assert.equal(c(4, 'CATEGORIA'), 'PLATAFORMA');
    assert.equal(c(4, 'Equipo'), 'ARRIENDO PLATAFORMA');
    assert.equal(c(4, 'N° Interno'), 1232);
    assert.equal(c(4, '$ Neto equipo'), 70000);
    assert.equal(c(4, 'Traslado Entrega'), 140000);
    assert.equal(c(4, 'Total $'), 249900);
    assert.equal(c(5, '$ Neto equipo'), 100000);
    assert.equal(c(4, 'Periodo Arriendo'), '10 MAY AL 09 JUN 2026');
    assert.deepEqual(c(4, 'Emision'), { fecha: '2026-05-10' });

    const acotado = await cargarFilasExportacion(pool, { clienteId: creado.cliente, desde: '2026-06-01', hasta: '2026-06-30' });
    assert.equal(acotado.items.length, 1);
    assert.equal(acotado.items[0].folio, '9002');
});
