// Pruebas de robustez: un campo mal tipado o una base caida deben responder un 4xx/5xx en JSON
// y dejar el proceso en pie. No necesitan base de datos: la URL apunta a un puerto cerrado a
// proposito, y las validaciones corren antes de cualquier consulta.
//
// Si un handler asincrono lanzara sin que nadie lo atrape, Node terminaria el proceso de prueba
// con un `unhandledRejection` y esta suite fallaria entera.

process.env.DATABASE_URL = 'postgres://nadie:nada@127.0.0.1:1/ninguna';
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-robustez';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://ci.invalid';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'clave-solo-para-pruebas';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const express = require('express');
const { creerEnElToken } = require('./_sesionDePrueba');

// sin base de datos: la cuenta del token se da por buena (verifyToken la revisa en la base en cada peticion)
creerEnElToken();

let servidor;
let base;
const token = (rol) => jwt.sign({ id: 1, rol, cliente_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function pedir(metodo, ruta, rol, cuerpo) {
    const r = await fetch(`${base}${ruta}`, {
        method: metodo,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(rol)}` },
        body: cuerpo === undefined ? undefined : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
    });
    let json = null;
    try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
    return { status: r.status, body: json };
}

before(async () => {
    const { manejarErrores } = require('../src/middleware/errores');
    const app = express();
    app.use(express.json());
    app.use('/api/insumos', require('../src/routes/insumos'));
    app.use('/api/vehiculos', require('../src/routes/vehiculos'));
    app.use('/api/rentabilidad', require('../src/routes/rentabilidad'));
    app.use('/api/ordenes-trabajo', require('../src/routes/ordenes'));
    app.use('/api/ordenes-trabajo', require('../src/routes/facturas'));
    app.use('/api/horometro', require('../src/routes/horometro').router);
    app.use('/api/maquinarias', require('../src/routes/maquinarias'));
    app.use('/api/clientes', require('../src/routes/clientes'));
    // ruta de prueba: un handler asincrono que lanza, como el que tumbaba el proceso
    const prueba = express.Router();
    prueba.get('/lanza', async () => { throw new Error('detalle interno secreto'); });
    prueba.get('/lanza-sincrono', () => { throw new Error('detalle interno secreto'); });
    app.use('/prueba', prueba);
    app.get('/vivo', (req, res) => res.json({ ok: true }));
    app.use(manejarErrores);
    await new Promise((resolve) => { servidor = app.listen(0, resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;
});

after(async () => {
    if (servidor) await new Promise((resolve) => servidor.close(resolve));
    await require('../src/config/db').end().catch(() => {});
});

const MAL_TIPADOS = [123, ['a'], { x: 1 }, true];

describe('campos mal tipados responden 400 y el proceso sigue vivo', () => {
    for (const valor of MAL_TIPADOS) {
        const etiqueta = JSON.stringify(valor);

        test(`POST /insumos/orden/:id con descripcion ${etiqueta}`, async () => {
            for (const rol of ['mecanico', 'administrativo']) {
                const r = await pedir('POST', '/api/insumos/orden/1', rol, { cantidad: 1, descripcion: valor });
                assert.equal(r.status, 400, rol);
                assert.match(r.body.error, /descripcion/);
            }
        });

        test(`PATCH /insumos/orden/:id/linea/:id con descripcion ${etiqueta}`, async () => {
            const r = await pedir('PATCH', '/api/insumos/orden/1/linea/1', 'administrativo', { descripcion: valor });
            assert.equal(r.status, 400);
        });

        test(`POST /vehiculos con patente ${etiqueta}`, async () => {
            const r = await pedir('POST', '/api/vehiculos', 'administrativo', { patente: valor });
            assert.equal(r.status, 400);
        });
    }

    test('POST /vehiculos con patente demasiado larga', async () => {
        const r = await pedir('POST', '/api/vehiculos', 'administrativo', { patente: 'X'.repeat(16) });
        assert.equal(r.status, 400);
    });

    test('GET /rentabilidad con desde o hasta que no son fechas', async () => {
        for (const q of ['desde=abc', 'hasta=abc', 'desde=2026-02-31x', 'desde[]=a', 'hasta[a]=b', 'desde=' + 'z'.repeat(100)]) {
            const r = await pedir('GET', `/api/rentabilidad?${q}`, 'gerente');
            assert.equal(r.status, 400, q);
        }
    });

    test('GET /rentabilidad/maquinaria/:id con hasta invalido', async () => {
        const r = await pedir('GET', '/api/rentabilidad/maquinaria/1?hasta=abc', 'gerente');
        assert.equal(r.status, 400);
    });

    test('el proceso sigue atendiendo despues de todo lo anterior', async () => {
        const r = await pedir('GET', '/vivo', 'gerente');
        assert.equal(r.status, 200);
    });
});

describe('topes de dinero, horas, largos e ids', () => {
    test('precio_unitario con tope: 1e300 y 11 digitos dan 400', async () => {
        for (const precio of [1e300, 99999999999, '99999999999']) {
            const r = await pedir('POST', '/api/insumos/orden/1', 'administrativo', { cantidad: 1, descripcion: 'x', precio_unitario: precio });
            assert.equal(r.status, 400, String(precio));
        }
    });

    test('horometro: Infinity (1e400), negativo, enorme o texto dan 400', async () => {
        for (const crudo of ['{"valor":1e400}', '{"valor":-1}', '{"valor":99999999999}', '{"valor":"abc"}', '{"valor":[5]}', '{"valor":{"a":1}}']) {
            const r = await pedir('POST', '/api/horometro/maquinaria/1', 'administrativo', crudo);
            assert.equal(r.status, 400, crudo);
        }
        const o = await pedir('POST', '/api/horometro/maquinaria/1', 'administrativo', { valor: 10, orden_trabajo_id: 'abc' });
        assert.equal(o.status, 400);
        const i = await pedir('PATCH', '/api/horometro/maquinaria/1/intervalo', 'administrativo', '{"intervalo_mantencion_horas":1e400}');
        assert.equal(i.status, 400);
        const k = await pedir('PATCH', '/api/vehiculos/mio', 'mecanico', '{"kilometraje":1e400}');
        assert.equal(k.status, 400);
    });

    test('ids no numericos en la URL dan 400, no 500', async () => {
        const casos = [
            ['GET', '/api/ordenes-trabajo/abc', 'administrativo'],
            ['GET', '/api/ordenes-trabajo/1e3', 'administrativo'],
            ['GET', '/api/ordenes-trabajo/99999999999', 'administrativo'],
            ['GET', '/api/maquinarias/abc', 'administrativo'],
            ['GET', '/api/horometro/maquinaria/abc', 'administrativo'],
            ['PATCH', '/api/vehiculos/abc', 'administrativo'],
            ['GET', '/api/rentabilidad/maquinaria/abc', 'gerente'],
        ];
        for (const [metodo, ruta, rol] of casos) {
            const r = await pedir(metodo, ruta, rol, metodo === 'GET' ? undefined : {});
            assert.equal(r.status, 400, ruta);
        }
    });

    test('checklist: mas de 100 elementos o ids invalidos dan 400', async () => {
        const muchos = Array.from({ length: 101 }, (_, i) => i + 1);
        assert.equal((await pedir('PUT', '/api/ordenes-trabajo/1/checklist', 'mecanico', { servicio_ids: muchos })).status, 400);
        assert.equal((await pedir('PUT', '/api/ordenes-trabajo/1/checklist', 'mecanico', { servicio_ids: ['a'] })).status, 400);
        assert.equal((await pedir('PUT', '/api/ordenes-trabajo/1/checklist', 'mecanico', { servicio_ids: [-1] })).status, 400);
    });

    test('tramos con fechas invalidas dan 400', async () => {
        const r = await pedir('POST', '/api/ordenes-trabajo/1/tramos', 'mecanico', { inicio: 'no es fecha' });
        assert.equal(r.status, 400);
        const r2 = await pedir('POST', '/api/ordenes-trabajo/1/tramos', 'mecanico', { inicio: { a: 1 } });
        assert.equal(r2.status, 400);
    });

    test('largos maximos de texto: columnas VARCHAR dan 400 y no 500', async () => {
        assert.equal((await pedir('POST', '/api/clientes', 'administrativo', { nombre: 'x'.repeat(151) })).status, 400);
        assert.equal((await pedir('POST', '/api/clientes', 'administrativo', { nombre: 'ok', rut: 'x'.repeat(21) })).status, 400);
        assert.equal((await pedir('POST', '/api/clientes', 'administrativo', { nombre: ['a'] })).status, 400);
        assert.equal((await pedir('POST', '/api/clientes', 'administrativo', { nombre: 'ok', ejecutivo_id: 'abc' })).status, 400);
        assert.equal((await pedir('POST', '/api/vehiculos', 'administrativo', { patente: 'AB1234', marca: 'm'.repeat(101) })).status, 400);
        assert.equal((await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: 1, motivo: 'x'.repeat(2001) })).status, 400);
        assert.equal((await pedir('PATCH', '/api/ordenes-trabajo/1/datos', 'mecanico', { folio_papel: 'x'.repeat(21) })).status, 400);
    });

    test('factura de OT: monto y fecha_emision invalidos dan 400 antes de subir nada', async () => {
        for (const [monto, fecha] of [['-5000'], ['12.5'], ['1e6'], ['abc'], ['NaN'], ['99999999999'], ['1000', '2026-02-31'], ['1000', 'ayer']]) {
            const form = new FormData();
            form.append('folio', '12345');
            form.append('monto', monto);
            if (fecha) form.append('fecha_emision', fecha);
            form.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'f.pdf');
            const r = await fetch(`${base}/api/ordenes-trabajo/1/factura`, {
                method: 'POST', headers: { Authorization: `Bearer ${token('administrativo')}` }, body: form,
            });
            assert.equal(r.status, 400, `${monto} ${fecha || ''}`);
        }
    });
});

describe('validadores puros', () => {
    const { montoEnteroONulo, validarPrecioUnitario } = require('../src/utils/auditoriaLinea');
    const { esDiaValido, validarCuerpo } = require('../src/utils/validacion');

    test('montoEnteroONulo acepta hasta 10 digitos', () => {
        assert.equal(montoEnteroONulo('9999999999'), 9999999999);
        assert.equal(montoEnteroONulo('10000000000'), null);
        assert.equal(montoEnteroONulo(1e300), null);
    });
    test('validarPrecioUnitario tiene tope superior', () => {
        assert.equal(validarPrecioUnitario(9999999999), null);
        assert.match(validarPrecioUnitario(10000000000), /precio_unitario/);
        assert.match(validarPrecioUnitario(1e300), /precio_unitario/);
    });
    test('esDiaValido rechaza fechas que no existen', () => {
        assert.equal(esDiaValido('2026-02-28'), true);
        assert.equal(esDiaValido('2026-02-31'), false);
        assert.equal(esDiaValido('2026-13-01'), false);
        assert.equal(esDiaValido(20260228), false);
    });
    test('validarCuerpo', () => {
        assert.equal(validarCuerpo({ a: 'x' }, { textos: { a: 5 } }), null);
        assert.match(validarCuerpo({ a: 'x'.repeat(6) }, { textos: { a: 5 } }), /a debe ser un texto/);
        assert.match(validarCuerpo({ a: 1 }, { textos: { a: 5 } }), /a debe ser un texto/);
        assert.equal(validarCuerpo({ id: 0 }, { ids: ['id'] }), null);
        assert.match(validarCuerpo({ id: 'abc' }, { ids: ['id'] }), /identificador/);
        assert.match(validarCuerpo({ n: 1e9 }, { numeros: { n: [0, 100] } }), /entre/);
    });
});

describe('manejador de errores final', () => {
    test('un handler asincrono que lanza responde 500 en JSON sin filtrar el detalle', async () => {
        const r = await pedir('GET', '/prueba/lanza', 'gerente');
        assert.equal(r.status, 500);
        assert.deepEqual(r.body, { error: 'Error interno del servidor' });
        assert.equal((await pedir('GET', '/vivo', 'gerente')).status, 200);
    });

    test('un handler sincrono que lanza tambien', async () => {
        const r = await pedir('GET', '/prueba/lanza-sincrono', 'gerente');
        assert.equal(r.status, 500);
        assert.doesNotMatch(JSON.stringify(r.body), /secreto/);
    });

    test('un JSON mal formado responde 400 en JSON', async () => {
        const r = await pedir('POST', '/api/vehiculos', 'administrativo', '{"patente":');
        assert.equal(r.status, 400);
        assert.ok(r.body.error);
    });

    test('con la base inalcanzable, las rutas que abren transaccion responden 500 y no tumban el proceso', async () => {
        const r = await pedir('POST', '/api/vehiculos', 'administrativo', { patente: 'AB1234' });
        assert.equal(r.status, 500);
        assert.doesNotMatch(JSON.stringify(r.body), /ECONNREFUSED|127\.0\.0\.1/);
        const r2 = await pedir('GET', '/api/insumos/mi-furgon', 'mecanico');
        assert.equal(r2.status, 500);
        assert.equal((await pedir('GET', '/vivo', 'gerente')).status, 200);
    });
});

describe('red de seguridad del proceso', () => {
    test('registrarRedDeSeguridad: unhandledRejection solo registra; uncaughtException registra y sale con codigo 1', () => {
        const { registrarRedDeSeguridad } = require('../src/middleware/errores');
        const registrados = {};
        const salidas = [];
        registrarRedDeSeguridad({
            on: (evento, fn) => { registrados[evento] = fn; },
            exit: (codigo) => { salidas.push(codigo); },
        });
        assert.equal(typeof registrados.unhandledRejection, 'function');
        assert.equal(typeof registrados.uncaughtException, 'function');
        const original = console.error;
        console.error = () => {};
        try {
            registrados.unhandledRejection(new Error('x'));
            assert.deepEqual(salidas, [], 'una promesa rechazada no debe terminar el proceso');
            registrados.uncaughtException(new Error('y'));
            assert.deepEqual(salidas, [1], 'una excepcion no atrapada reinicia el proceso (Railway lo levanta)');
        } finally {
            console.error = original;
        }
    });

    test('el pool tiene un oyente de error (un error en una conexion ociosa no mata el proceso)', () => {
        const pool = require('../src/config/db');
        assert.ok(pool.listenerCount('error') >= 1);
        const original = console.error;
        console.error = () => {};
        try { pool.emit('error', new Error('conexion ociosa caida')); } finally { console.error = original; }
    });
});
