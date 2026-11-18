// Comprobante de pago: tipos de archivo que acepta el subidor y la migracion 040.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { subidaComprobante } = require('../src/middleware/upload');
const { armarFilaEmitida } = require('../src/utils/facturasEmitidas');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PDF = Buffer.from('%PDF-1.4 contenido de prueba del comprobante');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);

// el segundo middleware de .single() es la comprobacion de la firma del contenido
const verificar = subidaComprobante.single('archivo')[1];
function pasa(buffer, mimetype) {
    const req = { file: { buffer, mimetype, originalname: 'x' } };
    let estado = null;
    const res = { status(c) { estado = c; return this; }, json() { return this; } };
    let siguio = false;
    verificar(req, res, () => { siguio = true; });
    return { siguio, estado, mimetype: req.file.mimetype };
}

test('el comprobante acepta PDF, JPG y PNG por su contenido', () => {
    assert.deepStrictEqual(pasa(PDF, 'application/pdf'), { siguio: true, estado: null, mimetype: 'application/pdf' });
    assert.strictEqual(pasa(JPG, 'application/octet-stream').mimetype, 'image/jpeg');
    assert.strictEqual(pasa(PNG, 'image/png').mimetype, 'image/png');
});

test('el comprobante rechaza WEBP/HEIC y archivos que mienten sobre su tipo', () => {
    assert.strictEqual(pasa(WEBP, 'image/webp').estado, 400);
    assert.strictEqual(pasa(Buffer.from('<svg></svg>'), 'image/png').estado, 400);
    assert.strictEqual(pasa(Buffer.from('MZ....'), 'application/pdf').estado, 400);
});

test('la fila de emitidas dice si tiene comprobante y nunca entrega la ruta', () => {
    const base = { id: 1, folio: 'A-1', orden_trabajo_id: null, fecha_pago: '2026-11-10', monto: 100 };
    const con = armarFilaEmitida({ ...base, tiene_comprobante: true, comprobante_pago_ruta: 'comprobantes/1/x.png' }, '2026-11-17');
    assert.strictEqual(con.tiene_comprobante, true);
    assert.strictEqual(armarFilaEmitida(base, '2026-11-17').tiene_comprobante, false);
    assert.ok(!JSON.stringify(con).includes('comprobantes/1'));
});

test('migracion 040: solo agrega una columna nula', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '040_comprobante_pago.sql'), 'utf8');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS comprobante_pago_ruta TEXT;/);
    assert.doesNotMatch(sql, /NOT NULL|\bDROP\b|\bDELETE\b/);
});
