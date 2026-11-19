// Anular una factura subida por error y el tipo de evento factura_anulada.
// Corren contra una base local; ver utils/entornoEscritura.js (GOMAQ_TEST_ESCRITURA=1 npm test).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { requiereBase } = require('./utils/http');
const {
    pool,
    datos,
    pedir,
    crearOt,
    MOTIVO_VALIDO,
    eventosTipo,
    cerrarOt,
    agregarLinea,
    rutaLinea,
    subirFactura,
    estadoValorizacion,
    esperarBloqueos,
    pendientesDeValorizar,
} = require('./utils/entornoEscritura');

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
