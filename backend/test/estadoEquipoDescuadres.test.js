// Estado del equipo derivado de las ordenes y descuadres de inventario.
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
    crearInsumoConStock,
    crearFurgonDePrueba,
    stockBodega,
    crearEquipo,
    algunCliente,
    eventosTipo,
} = require('./utils/entornoEscritura');

describe('estado del equipo derivado de las ordenes, cierre con estado y origen comercial', () => {
    const estadoDe = async (equipoId) => (await pool.query('SELECT estado, estado_origen FROM maquinarias WHERE id = $1', [equipoId])).rows[0];
    const diagnostico = (ot, cuerpo, rol = 'mecanico') => pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, rol, cuerpo);
    const finalizar = (ot, cuerpo = {}, rol = 'mecanico') => pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, rol, { sin_persona: true, ...cuerpo });
    const fijarEstado = (equipoId, estado, origen) =>
        pool.query('UPDATE maquinarias SET estado = $2, estado_origen = $3 WHERE id = $1', [equipoId, estado, origen]);
    /** OT asignada al mecanico sobre un equipo propio de la prueba. */
    const otDeEquipo = async (equipoId, estado = 'asignada') => crearOt(estado, datos.mecanicoId, equipoId);

    test('llegar a terreno por diagnostico deja el equipo en mantencion por la orden', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: null });
        assert.equal((await diagnostico(ot, { estado: 'aceptada' })).status, 200);
        assert.equal((await estadoDe(equipo.id)).estado, 'operativa', 'aceptar no toca el equipo');
        assert.equal((await diagnostico(ot, { estado: 'en_terreno' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'en_mantencion', estado_origen: 'ot' });
    });

    test('pasar de terreno a reparacion no repite la entrada: un operativa puesto a mano se respeta', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        assert.equal((await diagnostico(ot, { estado: 'en_terreno' })).status, 200);
        await fijarEstado(equipo.id, 'operativa', 'panel');
        assert.equal((await diagnostico(ot, { estado: 'en_reparacion' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'panel' });
        assert.equal((await diagnostico(ot, { estado: 'en_terreno' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'panel' });
    });

    test('un en_mantencion o fuera_de_servicio puestos a mano no se tocan al llegar a terreno', async (t) => {
        if (!requiereBase(t)) return;
        for (const estado of ['en_mantencion', 'fuera_de_servicio']) {
            const equipo = await crearEquipo(null);
            await fijarEstado(equipo.id, estado, 'panel');
            const ot = await otDeEquipo(equipo.id);
            assert.equal((await diagnostico(ot, { estado: 'en_terreno' })).status, 200);
            assert.deepEqual(await estadoDe(equipo.id), { estado, estado_origen: 'panel' });
        }
    });

    test('una OT creada en terreno (/en-terreno) deja el equipo en mantencion', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', { maquinaria_id: equipo.id, uuid_cliente: crypto.randomUUID() });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'en_mantencion', estado_origen: 'ot' });
    });

    test('cierre sin estado_equipo (APK antiguo): vuelve a operativa si la mantencion la puso la orden', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        assert.equal((await finalizar(ot)).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'ot' });
    });

    test('cierre sin estado_equipo nunca pisa un fuera_de_servicio ni un en_mantencion del panel', async (t) => {
        if (!requiereBase(t)) return;
        for (const estado of ['fuera_de_servicio', 'en_mantencion']) {
            const equipo = await crearEquipo(null);
            const ot = await otDeEquipo(equipo.id);
            await diagnostico(ot, { estado: 'en_terreno' });
            await fijarEstado(equipo.id, estado, 'panel');
            assert.equal((await finalizar(ot)).status, 200);
            assert.deepEqual(await estadoDe(equipo.id), { estado, estado_origen: 'panel' });
        }
    });

    test('cierre con estado_equipo = operativa deja el equipo operativo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        assert.equal((await finalizar(ot, { estado_equipo: 'operativa' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'mecanico' });
    });

    test('cierre con estado_equipo = operativa no levanta un en_mantencion puesto a mano', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        await fijarEstado(equipo.id, 'en_mantencion', 'panel');
        assert.equal((await finalizar(ot, { estado_equipo: 'operativa' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'en_mantencion', estado_origen: 'panel' });
    });

    test('cierre con fuera_de_servicio se aplica siempre, aunque el panel haya puesto otro estado o haya otra OT abierta', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        const otra = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        await diagnostico(otra, { estado: 'en_terreno' });
        await fijarEstado(equipo.id, 'operativa', 'panel');
        assert.equal((await finalizar(ot, { estado_equipo: 'fuera_de_servicio' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'fuera_de_servicio', estado_origen: 'mecanico' });
    });

    test('dos OT del mismo equipo: la primera en cerrarse lo deja en mantencion y la segunda operativo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const a = await otDeEquipo(equipo.id);
        const b = await otDeEquipo(equipo.id);
        await diagnostico(a, { estado: 'en_terreno' });
        await diagnostico(b, { estado: 'en_reparacion' });
        assert.equal((await estadoDe(equipo.id)).estado, 'en_mantencion');
        assert.equal((await finalizar(a, { estado_equipo: 'operativa' })).status, 200);
        assert.equal((await estadoDe(equipo.id)).estado, 'en_mantencion', 'queda otra OT abierta');
        assert.equal((await finalizar(b, { estado_equipo: 'operativa' })).status, 200);
        assert.equal((await estadoDe(equipo.id)).estado, 'operativa');
    });

    test('dos cierres simultaneos del mismo equipo no lo dejan pegado en mantencion', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 5; vuelta++) {
            const equipo = await crearEquipo(null);
            const a = await otDeEquipo(equipo.id);
            const b = await otDeEquipo(equipo.id);
            await diagnostico(a, { estado: 'en_terreno' });
            await diagnostico(b, { estado: 'en_terreno' });
            const [ra, rb] = await Promise.all([
                finalizar(a, { estado_equipo: 'operativa' }),
                finalizar(b, { estado_equipo: 'operativa' }),
            ]);
            assert.deepEqual([ra.status, rb.status], [200, 200]);
            assert.equal((await estadoDe(equipo.id)).estado, 'operativa', `vuelta ${vuelta}`);
        }
    });

    test('el cierre deja el estado del equipo en el historial y el reintento no lo repite ni cambia nada', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        const uuid = crypto.randomUUID();
        const primera = await finalizar(ot, { estado_equipo: 'fuera_de_servicio', uuid });
        assert.equal(primera.status, 200);
        // el panel recibe el equipo de vuelta y lo deja operativo a mano; el reintento no lo pisa
        await fijarEstado(equipo.id, 'operativa', 'panel');
        const segunda = await finalizar(ot, { estado_equipo: 'fuera_de_servicio', uuid });
        assert.equal(segunda.status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'panel' });
        const cierres = await eventosTipo(ot, 'cierre');
        assert.equal(cierres.length, 1);
        assert.deepEqual(
            [cierres[0].detalle.estado_equipo_pedido, cierres[0].detalle.estado_equipo_anterior, cierres[0].detalle.estado_equipo_nuevo],
            ['fuera_de_servicio', 'en_mantencion', 'fuera_de_servicio']);
    });

    test('estado_equipo invalido da 400 y la OT sigue abierta', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const ot = await otDeEquipo(equipo.id);
        await diagnostico(ot, { estado: 'en_terreno' });
        for (const invalido of ['en_mantencion', 'OPERATIVA', 'roto', 1, true]) {
            const r = await finalizar(ot, { estado_equipo: invalido });
            assert.equal(r.status, 400, JSON.stringify(invalido));
        }
        assert.equal((await pool.query('SELECT estado FROM ordenes_trabajo WHERE id = $1', [ot])).rows[0].estado, 'en_terreno');
        assert.equal((await estadoDe(equipo.id)).estado, 'en_mantencion');
    });

    test('ocurrio_en del cierre: se respeta, no puede ser futuro ni anterior a la creacion', async (t) => {
        if (!requiereBase(t)) return;
        const cerrarCon = async (ocurrio) => {
            const equipo = await crearEquipo(null);
            const ot = await otDeEquipo(equipo.id);
            await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '1 day' WHERE id = $1", [ot]);
            await diagnostico(ot, { estado: 'en_terreno' });
            const r = await finalizar(ot, { ocurrio_en: ocurrio });
            assert.equal(r.status, 200);
            const fila = (await pool.query('SELECT fecha_cierre, fecha_creacion FROM ordenes_trabajo WHERE id = $1', [ot])).rows[0];
            return { fila, evento: (await eventosTipo(ot, 'cierre'))[0] };
        };
        const hace = new Date(Date.now() - 60 * 1000);
        const valido = await cerrarCon(hace.toISOString());
        assert.ok(Math.abs(new Date(valido.fila.fecha_cierre) - hace) < 1000, 'usa la hora del telefono');
        assert.ok(valido.evento.ocurrio_en);
        const futuro = await cerrarCon(new Date(Date.now() + 3600 * 1000).toISOString());
        assert.ok(new Date(futuro.fila.fecha_cierre) <= Date.now() + 2000, 'nunca en el futuro (la hora pedida era 1 h adelante)');
        const antiguo = await cerrarCon('2001-01-01T00:00:00Z');
        assert.ok(new Date(antiguo.fila.fecha_cierre) >= new Date(antiguo.fila.fecha_creacion), 'no antes de la creacion');
        const basura = await cerrarCon('no-es-fecha');
        assert.ok(Math.abs(new Date(basura.fila.fecha_cierre) - new Date()) < 5000, 'invalida: hora del servidor');
    });

    test('PATCH /maquinarias/:id/estado deja quien lo fijo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        assert.equal((await pedir('PATCH', `/api/maquinarias/${equipo.id}/estado`, 'administrativo', { estado: 'fuera_de_servicio' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'fuera_de_servicio', estado_origen: 'panel' });
        assert.equal((await pedir('PATCH', `/api/maquinarias/${equipo.id}/estado`, 'mecanico', { estado: 'operativa' })).status, 200);
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: 'mecanico' });
    });

    test('origen de la OT: externo si el cliente tiene ejecutivo, directo si no, en las tres rutas', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        if (!cliente) return t.skip('la base no tiene clientes');
        // siempre un ejecutivo propio: no depende de la semilla y se borra al final
        const ejecutivo = (await pool.query(
            'INSERT INTO ejecutivos (nombre) VALUES ($1) RETURNING id', [`Ejecutivo prueba ${crypto.randomUUID()}`])).rows[0];
        const original = (await pool.query('SELECT ejecutivo_id FROM clientes WHERE id = $1', [cliente])).rows[0].ejecutivo_id;
        const origenDe = async (ot) => (await pool.query('SELECT origen FROM ordenes_trabajo WHERE id = $1', [ot])).rows[0].origen;
        try {
            for (const [ejecutivoId, esperado] of [[ejecutivo.id, 'externo'], [null, 'directo']]) {
                await pool.query('UPDATE clientes SET ejecutivo_id = $2 WHERE id = $1', [cliente, ejecutivoId]);
                // panel: POST /, aunque el body diga otra cosa
                const eq1 = await crearEquipo(cliente);
                const panel = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: eq1.id, origen: ejecutivoId ? 'directo' : 'externo' });
                assert.equal(panel.status, 201);
                datos.ordenes.push(panel.body.id);
                assert.equal(await origenDe(panel.body.id), esperado, 'panel');
                // terreno: /en-terreno
                const eq2 = await crearEquipo(cliente);
                const terreno = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', { maquinaria_id: eq2.id, uuid_cliente: crypto.randomUUID() });
                assert.equal(terreno.status, 201);
                datos.ordenes.push(terreno.body.id);
                assert.equal(await origenDe(terreno.body.id), esperado, 'terreno');
            }
        } finally {
            await pool.query('UPDATE clientes SET ejecutivo_id = $2 WHERE id = $1', [cliente, original]);
            await pool.query('DELETE FROM ejecutivos WHERE id = $1', [ejecutivo.id]);
        }
    });

    test('un equipo sin cliente da una OT de origen directo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.equal(r.body.origen, 'directo');
    });

    test('la migracion 024 rellena el estado de los equipos con una orden abierta y se puede repetir', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        await otDeEquipo(equipo.id, 'en_terreno');
        // un equipo con orden abierta que sigue operativo (como estaba antes de la migracion)
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'operativa', estado_origen: null });
        const sql = require('fs').readFileSync(require('path').join(__dirname, '../../db/migrations/024_estado_equipo_origen.sql'), 'utf8');
        for (let i = 0; i < 2; i++) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('COMMIT');
            } finally {
                client.release();
            }
        }
        assert.deepEqual(await estadoDe(equipo.id), { estado: 'en_mantencion', estado_origen: 'ot' });
    });
});

describe('descuadres de inventario, conteo y traspaso', () => {
    const { randomUUID } = require('node:crypto');

    const stockEn = async (ubicacionId, insumoId) => {
        const r = await pool.query('SELECT cantidad FROM stock_ubicacion WHERE ubicacion_id = $1 AND insumo_id = $2', [ubicacionId, insumoId]);
        return r.rows[0] ? Number(r.rows[0].cantidad) : 0;
    };
    const stockActual = async (insumoId) => Number((await pool.query('SELECT stock_actual FROM insumos WHERE id = $1', [insumoId])).rows[0].stock_actual);
    const sumaUbicaciones = async (insumoId) =>
        Number((await pool.query('SELECT COALESCE(SUM(cantidad), 0) AS s FROM stock_ubicacion WHERE insumo_id = $1', [insumoId])).rows[0].s);
    const bodegaId = async () => (await pool.query("SELECT id FROM ubicaciones_stock WHERE tipo = 'bodega' ORDER BY id LIMIT 1")).rows[0].id;
    /** Deja una existencia negativa por la via real: un consumo de un repuesto que el furgon no tenia. */
    const dejarNegativo = async (ubicacionId, insumoId, cantidad) => {
        await pool.query(
            `INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad) VALUES ($1, $2, $3)
             ON CONFLICT (ubicacion_id, insumo_id) DO UPDATE SET cantidad = EXCLUDED.cantidad`, [ubicacionId, insumoId, -cantidad]);
        await pool.query(
            `INSERT INTO movimientos_insumo (insumo_id, cantidad, tipo, ubicacion_origen_id, descripcion)
             VALUES ($1, $2, 'salida', $3, 'consumo sin stock de prueba')`, [insumoId, cantidad, ubicacionId]);
        await pool.query('UPDATE insumos SET stock_actual = (SELECT COALESCE(SUM(cantidad), 0) FROM stock_ubicacion WHERE insumo_id = $1) WHERE id = $1', [insumoId]);
    };
    const descuadres = async (rol = 'administrativo') => (await pedir('GET', '/api/insumos/descuadres', rol)).body;
    const filaDe = (lista, ubicacionId, insumoId) => lista.find((f) => f.ubicacion_id === ubicacionId && f.insumo_id === insumoId);
    const ajustar = (cuerpo, rol = 'administrativo') => pedir('POST', '/api/insumos/ajuste', rol, cuerpo);

    test('los negativos se calculan por ubicacion y traen su origen', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgonA = await crearFurgonDePrueba();
        const furgonB = await crearFurgonDePrueba();
        await dejarNegativo(furgonA, insumo, 3);
        const lista = await descuadres();
        const fila = filaDe(lista, furgonA, insumo);
        assert.ok(fila, 'el furgon A en -3 aparece');
        assert.equal(fila.cantidad, -3);
        assert.equal(fila.ubicacion_tipo, 'furgon');
        assert.ok(fila.negativo_desde, 'dice desde cuando');
        assert.ok(fila.ultimo_movimiento_at);
        assert.equal(fila.sin_origen, false);
        assert.ok(Number.isInteger(fila.dias) && fila.dias >= 0);
        assert.equal(filaDe(lista, furgonB, insumo), undefined, 'el furgon B no aparece');
        assert.equal(filaDe(lista, await bodegaId(), insumo), undefined, 'la bodega no aparece');
        assert.equal((await descuadres('gerente')).length, lista.length, 'el gerente tambien lo ve');
        assert.equal((await pedir('GET', '/api/insumos/descuadres', 'mecanico')).status, 403);
    });

    test('el mismo insumo negativo en dos furgones da dos filas', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const a = await crearFurgonDePrueba();
        const b = await crearFurgonDePrueba();
        await dejarNegativo(a, insumo, 2);
        await dejarNegativo(b, insumo, 5);
        const lista = (await descuadres()).filter((f) => f.insumo_id === insumo);
        assert.equal(lista.length, 2);
        assert.equal(lista[0].ubicacion_id, b, 'ordenadas por la mas negativa primero');
    });

    test('un negativo sin movimientos que lo expliquen queda como sin origen', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await pool.query('INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad) VALUES ($1, $2, -4)', [furgon, insumo]);
        const fila = filaDe(await descuadres(), furgon, insumo);
        assert.equal(fila.sin_origen, true);
        assert.equal(fila.negativo_desde, null);
        assert.equal(fila.dias, null);
    });

    test('traspasar desde bodega deja el furgon en 0, lo saca de la lista y mantiene el total', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const r = await pedir('POST', '/api/insumos/transferencia', 'administrativo', {
            insumo_id: insumo, cantidad: 3, ubicacion_destino_id: furgon, motivo_codigo: 'traspaso_no_registrado', uuid_cliente: randomUUID(),
        });
        assert.equal(r.status, 201);
        assert.equal(await stockEn(furgon, insumo), 0);
        assert.equal(filaDe(await descuadres(), furgon, insumo), undefined);
        assert.equal(await stockActual(insumo), await sumaUbicaciones(insumo));
        const mov = await pool.query(
            `SELECT motivo_codigo FROM movimientos_insumo WHERE insumo_id = $1 AND ubicacion_destino_id = $2 AND tipo = 'salida'`, [insumo, furgon]);
        assert.equal(mov.rows[0].motivo_codigo, 'traspaso_no_registrado');
    });

    test('traspaso: si la bodega no alcanza responde 400 sin cambios', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(2);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 5);
        const r = await pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 5, ubicacion_destino_id: furgon });
        assert.equal(r.status, 400);
        assert.equal(await stockEn(furgon, insumo), -5);
        assert.equal(await stockBodega(insumo), 2);
    });

    test('traspaso: el destino debe existir, estar activo y ser un furgon; el motivo debe ser de la lista', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(5);
        const bodega = await bodegaId();
        const inactivo = await crearFurgonDePrueba();
        await pool.query('UPDATE ubicaciones_stock SET activa = false WHERE id = $1', [inactivo]);
        const activo = await crearFurgonDePrueba();
        for (const destino of [99999999, inactivo, bodega]) {
            const r = await pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: destino });
            assert.equal(r.status, 400, `destino ${destino}`);
        }
        const motivoMalo = await pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: activo, motivo_codigo: 'inventado' });
        assert.equal(motivoMalo.status, 400);
        assert.equal(await stockBodega(insumo), 5, 'nada cambio');
        const bien = await pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: activo });
        assert.equal(bien.status, 201);
    });

    test('conteo: contar 1 sobre -3 genera un ajuste de +4 con su motivo y saca el caso de la lista', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const r = await ajustar({
            ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: -3,
            motivo_codigo: 'diferencia_conteo', nota: 'conteo de prueba', uuid_cliente: randomUUID(),
        });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.delta, 4);
        assert.equal(await stockEn(furgon, insumo), 1);
        assert.equal(await stockActual(insumo), await sumaUbicaciones(insumo));
        assert.equal(filaDe(await descuadres(), furgon, insumo), undefined);
        const mov = (await pool.query(`SELECT * FROM movimientos_insumo WHERE id = $1`, [r.body.movimiento_id])).rows[0];
        assert.equal(mov.tipo, 'ajuste');
        assert.equal(Number(mov.cantidad), 4);
        assert.equal(mov.ubicacion_destino_id, furgon);
        assert.equal(mov.ubicacion_origen_id, null);
        assert.equal(mov.motivo_codigo, 'diferencia_conteo');
        assert.equal(mov.descripcion, 'conteo de prueba');
    });

    test('conteo menor que el sistema resta, y contar lo mismo no genera movimiento', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const bodega = await bodegaId();
        const antes = await stockEn(bodega, insumo);
        const igual = await ajustar({ ubicacion_id: bodega, insumo_id: insumo, cantidad_contada: antes, cantidad_esperada: antes, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() });
        assert.equal(igual.status, 200);
        assert.equal(igual.body.sin_cambios, true);
        const cero = (await pool.query('SELECT cantidad, tipo, motivo_codigo FROM movimientos_insumo WHERE id = $1', [igual.body.movimiento_id])).rows[0];
        assert.equal(Number(cero.cantidad), 0, 'queda constancia del conteo, con cantidad 0');
        assert.equal(cero.tipo, 'ajuste');
        assert.equal(await stockEn(bodega, insumo), antes, 'y no mueve stock');
        const menos = await ajustar({ ubicacion_id: bodega, insumo_id: insumo, cantidad_contada: antes - 2, cantidad_esperada: antes, motivo_codigo: 'perdida_robo', uuid_cliente: randomUUID() });
        assert.equal(menos.status, 201);
        assert.equal(menos.body.delta, -2);
        assert.equal(await stockEn(bodega, insumo), antes - 2);
        const mov = (await pool.query('SELECT ubicacion_origen_id, ubicacion_destino_id FROM movimientos_insumo WHERE id = $1', [menos.body.movimiento_id])).rows[0];
        assert.equal(mov.ubicacion_origen_id, bodega);
        assert.equal(mov.ubicacion_destino_id, null);
    });

    test('conteo con la cantidad esperada desactualizada da 409 y no cambia nada', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const r = await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: -2, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() });
        assert.equal(r.status, 409);
        assert.equal(await stockEn(furgon, insumo), -3);
        assert.equal((await pool.query("SELECT 1 FROM movimientos_insumo WHERE insumo_id = $1 AND tipo = 'ajuste'", [insumo])).rows.length, 0);
    });

    test('conteo: validaciones, roles y ubicaciones', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        const inactivo = await crearFurgonDePrueba();
        await pool.query('UPDATE ubicaciones_stock SET activa = false WHERE id = $1', [inactivo]);
        const valido = { ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 2, cantidad_esperada: 0, motivo_codigo: 'compra_no_ingresada' };
        const casos = [
            [{ ...valido }, 400, 'sin uuid_cliente'],
            [{ ...valido, uuid_cliente: 'no-es-uuid' }, 400, 'uuid invalido'],
            [{ ...valido, uuid_cliente: randomUUID(), motivo_codigo: 'inventado' }, 400, 'motivo fuera de la lista'],
            [{ ...valido, uuid_cliente: randomUUID(), motivo_codigo: undefined }, 400, 'sin motivo'],
            [{ ...valido, uuid_cliente: randomUUID(), cantidad_contada: -1 }, 400, 'contada negativa'],
            [{ ...valido, uuid_cliente: randomUUID(), cantidad_contada: 'abc' }, 400, 'contada no numerica'],
            [{ ...valido, uuid_cliente: randomUUID(), cantidad_esperada: undefined }, 400, 'sin esperada'],
            [{ ...valido, uuid_cliente: randomUUID(), ubicacion_id: inactivo }, 400, 'ubicacion inactiva'],
            [{ ...valido, uuid_cliente: randomUUID(), ubicacion_id: 99999999 }, 400, 'ubicacion inexistente'],
            [{ ...valido, uuid_cliente: randomUUID(), insumo_id: 99999999 }, 404, 'insumo inexistente'],
            [{ ...valido, uuid_cliente: randomUUID(), nota: 'x'.repeat(501) }, 400, 'nota larga'],
        ];
        for (const [cuerpo, estado, nombre] of casos) {
            assert.equal((await ajustar(cuerpo)).status, estado, nombre);
        }
        assert.equal(await stockEn(furgon, insumo), 0, 'ningun rechazo cambio el stock');
        assert.equal((await ajustar({ ...valido, uuid_cliente: randomUUID() }, 'mecanico')).status, 403);
        assert.equal((await ajustar({ ...valido, uuid_cliente: randomUUID() }, 'gerente')).status, 403, 'el gerente solo lee');
        assert.equal((await ajustar({ ...valido, uuid_cliente: randomUUID() }, 'cliente')).status, 403);
        assert.equal((await ajustar({ ...valido, uuid_cliente: randomUUID() })).status, 201);
    });

    test('conteo idempotente: el mismo uuid dos veces deja un solo movimiento y no da 409', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const cuerpo = { ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: -3, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() };
        const primera = await ajustar(cuerpo);
        assert.equal(primera.status, 201);
        // el reintento llega con la misma cantidad esperada, que ya no coincide con el stock: debe responder 200
        const segunda = await ajustar(cuerpo);
        assert.equal(segunda.status, 200);
        assert.equal(segunda.body.ya_registrada, true);
        assert.equal(segunda.body.movimiento_id, primera.body.movimiento_id);
        assert.equal(await stockEn(furgon, insumo), 1);
        assert.equal((await pool.query("SELECT 1 FROM movimientos_insumo WHERE insumo_id = $1 AND tipo = 'ajuste'", [insumo])).rows.length, 1);
    });

    test('conteo idempotente con dos llamadas simultaneas: un solo movimiento', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 3; vuelta++) {
            const insumo = await crearInsumoConStock(10);
            const furgon = await crearFurgonDePrueba();
            await dejarNegativo(furgon, insumo, 3);
            const cuerpo = { ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: -3, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() };
            const [a, b] = await Promise.all([ajustar(cuerpo), ajustar(cuerpo)]);
            const estados = [a.status, b.status].sort();
            assert.ok(estados[0] === 200 || estados[0] === 201, JSON.stringify([a.body, b.body]));
            assert.ok(estados.every((e) => e === 200 || e === 201), JSON.stringify([a.status, b.status, a.body, b.body]));
            assert.equal((await pool.query("SELECT 1 FROM movimientos_insumo WHERE insumo_id = $1 AND tipo = 'ajuste'", [insumo])).rows.length, 1);
            assert.equal(await stockEn(furgon, insumo), 1);
        }
    });

    test('un uuid ya usado por otro movimiento no se acepta como conteo propio', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        const uuid = randomUUID();
        // el mecanico necesita un furgon activo (vehiculo activo + ubicacion activa); si la semilla no lo trae, se crea
        let vehiculoCreado = null;
        let ubicacionCreada = null;
        let vehiculoOriginal = null;
        let ubicacionOriginal = null;
        try {
            let vehiculo = (await pool.query('SELECT id, activo FROM vehiculos WHERE usuario_id = $1', [datos.mecanicoId])).rows[0];
            if (!vehiculo) {
                vehiculo = (await pool.query(
                    `INSERT INTO vehiculos (patente, marca, modelo, usuario_id) VALUES ($1, 'Ford', 'Transit', $2) RETURNING id, activo`,
                    [`T${crypto.randomUUID().slice(0, 6).toUpperCase()}`, datos.mecanicoId])).rows[0];
                vehiculoCreado = vehiculo.id;
            } else if (!vehiculo.activo) {
                vehiculoOriginal = vehiculo.id;
                await pool.query('UPDATE vehiculos SET activo = true WHERE id = $1', [vehiculo.id]);
            }
            const ubicacion = (await pool.query('SELECT id, activa FROM ubicaciones_stock WHERE vehiculo_id = $1', [vehiculo.id])).rows[0];
            if (!ubicacion) {
                ubicacionCreada = (await pool.query(
                    `INSERT INTO ubicaciones_stock (nombre, tipo, vehiculo_id) VALUES ($1, 'furgon', $2) RETURNING id`,
                    [`Furgon mecanico de prueba ${crypto.randomUUID()}`, vehiculo.id])).rows[0].id;
            } else if (!ubicacion.activa) {
                ubicacionOriginal = ubicacion.id;
                await pool.query('UPDATE ubicaciones_stock SET activa = true WHERE id = $1', [ubicacion.id]);
            }
            // la transferencia del mecanico toma el uuid (el stock sale de la bodega, que tiene 10)
            const tr = await pedir('POST', '/api/insumos/transferencia', 'mecanico', { insumo_id: insumo, cantidad: 1, uuid_cliente: uuid });
            assert.equal(tr.status, 201, JSON.stringify(tr.body));
            const r = await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: 0, motivo_codigo: 'diferencia_conteo', uuid_cliente: uuid });
            assert.equal(r.status, 409);
            assert.equal(await stockEn(furgon, insumo), 0);
        } finally {
            // los movimientos y el stock del insumo apuntan a la ubicacion: salen antes de borrarla
            if (ubicacionCreada) {
                await pool.query('DELETE FROM movimientos_insumo WHERE insumo_id = $1', [insumo]);
                await pool.query('DELETE FROM stock_ubicacion WHERE ubicacion_id = $1', [ubicacionCreada]);
                await pool.query('DELETE FROM ubicaciones_stock WHERE id = $1', [ubicacionCreada]);
            }
            if (ubicacionOriginal) await pool.query('UPDATE ubicaciones_stock SET activa = false WHERE id = $1', [ubicacionOriginal]);
            if (vehiculoCreado) await pool.query('DELETE FROM vehiculos WHERE id = $1', [vehiculoCreado]);
            if (vehiculoOriginal) await pool.query('UPDATE vehiculos SET activo = false WHERE id = $1', [vehiculoOriginal]);
        }
    });

    test('concurrencia: movimientos en paralelo sobre dos ubicaciones del mismo insumo dejan stock_actual igual a la suma', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 3; vuelta++) {
            const insumo = await crearInsumoConStock(100);
            const a = await crearFurgonDePrueba();
            const b = await crearFurgonDePrueba();
            const trabajos = [];
            for (let i = 0; i < 4; i++) {
                trabajos.push(pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: i % 2 ? a : b }));
                trabajos.push(ajustar({ ubicacion_id: i % 2 ? a : b, insumo_id: insumo, cantidad_contada: 0, cantidad_esperada: 0, motivo_codigo: 'error_registro', uuid_cliente: randomUUID() }));
            }
            const resultados = await Promise.all(trabajos);
            for (const r of resultados) assert.ok([200, 201, 409].includes(r.status), `estado inesperado ${r.status} ${JSON.stringify(r.body)}`);
            assert.equal(await stockActual(insumo), await sumaUbicaciones(insumo), 'stock_actual es la suma de las ubicaciones');
        }
    });

    test('un conteo en paralelo con un consumo del mismo furgon termina coherente', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const ot = await crearOt();
        const cuerpoConteo = { ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: -3, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() };
        const [conteo] = await Promise.all([
            ajustar(cuerpoConteo),
            pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { insumo_id: insumo, cantidad: 1, descripcion: 'consumo de prueba' }),
        ]);
        assert.ok([201, 409].includes(conteo.status), String(conteo.status));
        assert.equal(await stockActual(insumo), await sumaUbicaciones(insumo));
    });

    test('ver movimientos: filtros por ubicacion e insumo, y el ajuste trae su motivo', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const otro = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 2);
        await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 0, cantidad_esperada: -2, motivo_codigo: 'danio_merma', uuid_cliente: randomUUID() });
        const filas = (await pedir('GET', `/api/insumos/movimientos?ubicacion_id=${furgon}&insumo_id=${insumo}`, 'administrativo')).body;
        const lista = Array.isArray(filas) ? filas : filas.items || filas.datos || filas.data;
        assert.ok(Array.isArray(lista), JSON.stringify(filas).slice(0, 200));
        assert.equal(lista.length, 2, 'el consumo sin stock y el ajuste');
        assert.ok(lista.every((m) => m.insumo_id === insumo));
        assert.ok(lista.some((m) => m.tipo === 'ajuste' && m.motivo_codigo === 'danio_merma'));
        const soloOtro = (await pedir('GET', `/api/insumos/movimientos?insumo_id=${otro}&ubicacion_id=${furgon}`, 'gerente')).body;
        assert.equal((Array.isArray(soloOtro) ? soloOtro : soloOtro.items || soloOtro.datos || soloOtro.data).length, 0);
        assert.equal((await pedir('GET', '/api/insumos/movimientos?insumo_id=abc', 'administrativo')).status, 400);
        assert.equal((await pedir('GET', '/api/insumos/movimientos', 'mecanico')).status, 403);
    });

    test('la lista de motivos sale del servidor, solo para administrativo y gerente', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', '/api/insumos/motivos-ajuste', 'gerente');
        assert.equal(r.status, 200);
        assert.equal(r.body.length, 5, 'solo los motivos validos para un conteo');
        assert.ok(!r.body.some((m) => m.codigo === 'traspaso_no_registrado'));
        assert.ok(r.body.every((m) => m.codigo && m.nombre));
        assert.equal((await pedir('GET', '/api/insumos/motivos-ajuste', 'mecanico')).status, 403);
    });

    test('el conteo no acepta traspaso_no_registrado: no crea stock de la nada', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const r = await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 0, cantidad_esperada: -3, motivo_codigo: 'traspaso_no_registrado', uuid_cliente: randomUUID() });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /traspaso/);
        assert.equal(await stockEn(furgon, insumo), -3);
        assert.equal(await stockBodega(insumo), 10, 'la bodega no se toco');
    });

    test('el conteo rechaza cantidades con formato raro o que desbordan la columna', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        const base = { ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: 0, motivo_codigo: 'diferencia_conteo' };
        for (const [campo, valor] of [['cantidad_contada', true], ['cantidad_contada', [5]], ['cantidad_contada', '0x10'], ['cantidad_contada', 1e12],
            ['cantidad_contada', '10000000000'], ['cantidad_esperada', true], ['cantidad_esperada', [0]], ['cantidad_esperada', '1e3']]) {
            const r = await ajustar({ ...base, [campo]: valor, uuid_cliente: randomUUID() });
            assert.equal(r.status, 400, `${campo}=${JSON.stringify(valor)}`);
        }
        assert.equal(await stockEn(furgon, insumo), 0);
        assert.equal((await ajustar({ ...base, cantidad_contada: '2.50', uuid_cliente: randomUUID() })).status, 201, 'un decimal como texto si');
    });

    test('el reintento de un conteo con delta 0 es idempotente y deja un solo registro', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const bodega = await bodegaId();
        const actual = await stockEn(bodega, insumo);
        const cuerpo = { ubicacion_id: bodega, insumo_id: insumo, cantidad_contada: actual, cantidad_esperada: actual, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() };
        const a = await ajustar(cuerpo);
        const b = await ajustar(cuerpo);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.equal(b.body.ya_registrada, true);
        assert.equal((await pool.query("SELECT 1 FROM movimientos_insumo WHERE insumo_id = $1 AND tipo = 'ajuste'", [insumo])).rows.length, 1);
    });

    test('un uuid ya usado en otro insumo o en otra ubicacion no se acepta como el mismo conteo', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const otro = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        const otroFurgon = await crearFurgonDePrueba();
        const uuid = randomUUID();
        const primero = await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: 0, motivo_codigo: 'compra_no_ingresada', uuid_cliente: uuid });
        assert.equal(primero.status, 201);
        const otroInsumo = await ajustar({ ubicacion_id: furgon, insumo_id: otro, cantidad_contada: 1, cantidad_esperada: 0, motivo_codigo: 'compra_no_ingresada', uuid_cliente: uuid });
        assert.equal(otroInsumo.status, 409);
        const otraUbicacion = await ajustar({ ubicacion_id: otroFurgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: 0, motivo_codigo: 'compra_no_ingresada', uuid_cliente: uuid });
        assert.equal(otraUbicacion.status, 409);
        assert.equal(await stockEn(otroFurgon, insumo), 0);
        assert.equal(await stockEn(furgon, otro), 0);
        assert.equal((await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 1, cantidad_esperada: 0, motivo_codigo: 'compra_no_ingresada', uuid_cliente: uuid })).status, 200, 'el mismo conteo si');
    });

    test('transferencia: dos reintentos simultaneos con el mismo uuid dan 200 ya_registrada, no 400', async (t) => {
        if (!requiereBase(t)) return;
        for (let vuelta = 0; vuelta < 3; vuelta++) {
            // la bodega alcanza justo para UNA carga: si el segundo reintento validara contra la bodega ya descontada daria 400
            const insumo = await crearInsumoConStock(3);
            const furgon = await crearFurgonDePrueba();
            const cuerpo = { insumo_id: insumo, cantidad: 3, ubicacion_destino_id: furgon, uuid_cliente: randomUUID() };
            const [a, b] = await Promise.all([
                pedir('POST', '/api/insumos/transferencia', 'administrativo', cuerpo),
                pedir('POST', '/api/insumos/transferencia', 'administrativo', cuerpo),
            ]);
            assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.body, b.body]));
            assert.equal(await stockEn(furgon, insumo), 3);
            assert.equal(await stockBodega(insumo), 0);
            assert.equal((await pool.query("SELECT 1 FROM movimientos_insumo WHERE insumo_id = $1 AND tipo = 'salida' AND ubicacion_destino_id = $2", [insumo, furgon])).rows.length, 1);
        }
    });

    test('transferencia: ubicacion_destino_id con formato raro da 400', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(5);
        for (const destino of ['abc', '1; DROP TABLE x', -1, 0.5, true, [1], {}, '0']) {
            const r = await pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: destino });
            assert.equal(r.status, 400, JSON.stringify(destino));
        }
        assert.equal(await stockBodega(insumo), 5);
    });

    test('los movimientos de un conteo y de una transferencia llevan la hora real, en orden', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const furgon = await crearFurgonDePrueba();
        await pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 2, ubicacion_destino_id: furgon });
        await ajustar({ ubicacion_id: furgon, insumo_id: insumo, cantidad_contada: 5, cantidad_esperada: 2, motivo_codigo: 'diferencia_conteo', uuid_cliente: randomUUID() });
        const r = await pool.query('SELECT tipo, created_at FROM movimientos_insumo WHERE insumo_id = $1 AND ubicacion_destino_id = $2 ORDER BY id', [insumo, furgon]);
        assert.equal(r.rows.length, 2);
        assert.ok(r.rows[0].created_at < r.rows[1].created_at, 'el conteo es posterior a la transferencia');
    });

    test('/descuadres responde coherente aunque se muevan existencias al mismo tiempo', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(50);
        const furgon = await crearFurgonDePrueba();
        await dejarNegativo(furgon, insumo, 3);
        const trabajos = [];
        for (let i = 0; i < 4; i++) {
            trabajos.push(pedir('GET', '/api/insumos/descuadres', 'administrativo'));
            trabajos.push(pedir('POST', '/api/insumos/transferencia', 'administrativo', { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: furgon }));
        }
        const resultados = await Promise.all(trabajos);
        for (const r of resultados.filter((x) => Array.isArray(x.body))) {
            assert.equal(r.status, 200);
            const fila = filaDe(r.body, furgon, insumo);
            if (fila) assert.ok(fila.negativo_desde || fila.sin_origen, 'cada caso trae su fecha o su aviso');
        }
    });
});
