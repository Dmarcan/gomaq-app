// Cambios de lo facturable con motivo, bloqueo por factura y eventos en el historial.
// Corren contra una base local; ver utils/entornoEscritura.js (GOMAQ_TEST_ESCRITURA=1 npm test).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { requiereBase } = require('./utils/http');
const {
    pool,
    datos,
    pedir,
    purgarOrdenes,
    crearOt,
    crearInsumoConStock,
    stockBodega,
    MOTIVO_VALIDO,
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
} = require('./utils/entornoEscritura');

async function contarEventos(ot) {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM ordenes_eventos WHERE orden_trabajo_id = $1', [ot]);
    return r.rows[0].n;
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
        const { ot, d } = await otValorizada();
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

        // el gerente la vuelve a aprobar, con todos los repuestos ya decididos (la linea D del armado seguia por decidir)
        await pool.query("UPDATE movimientos_insumo SET facturable = 'no' WHERE id = $1", [d]);
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
