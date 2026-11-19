// Reintentos de la cola offline, anulacion de lineas, horometro, despacho, viaje del mecanico, ciclo de vida de la OT, cliente de la orden, ficha, costos y alta de equipos.
// Corren contra una base local; ver utils/entornoEscritura.js (GOMAQ_TEST_ESCRITURA=1 npm test).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { requiereBase } = require('./utils/http');
const {
    pool,
    datos,
    tokens,
    entorno,
    pedir,
    crearOt,
    crearInsumoConStock,
    crearFurgonDePrueba,
    stockBodega,
    MOTIVO_VALIDO,
    crearEquipo,
    algunCliente,
    eventosDe,
} = require('./utils/entornoEscritura');

describe('reintentos de la cola offline', () => {
    test('una linea de repuesto reintentada se registra y descuenta una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const insumo = await crearInsumoConStock(10);
        const uuid = crypto.randomUUID();
        const cuerpo = { insumo_id: insumo, cantidad: 3, facturable: 'si', uuid_cliente: uuid };

        const primera = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', cuerpo);
        const segunda = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', cuerpo);

        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200, 'el reintento responde la linea existente');
        assert.equal(segunda.body.id, primera.body.id);
        const lineas = await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(lineas.rows.length, 1);
        assert.equal(await stockBodega(insumo), 7, 'el stock se descuenta una sola vez');
    });

    test('dos reintentos simultaneos tampoco duplican', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const insumo = await crearInsumoConStock(10);
        const cuerpo = { insumo_id: insumo, cantidad: 2, uuid_cliente: crypto.randomUUID() };

        const respuestas = await Promise.all([1, 2, 3].map(() =>
            pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', cuerpo)));

        assert.ok(respuestas.every((r) => r.status === 200 || r.status === 201));
        const lineas = await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(lineas.rows.length, 1);
        assert.equal(await stockBodega(insumo), 8);
    });

    test('una carga de furgon reintentada descuenta la bodega una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const destino = await crearFurgonDePrueba();
        const cuerpo = { insumo_id: insumo, cantidad: 4, ubicacion_destino_id: destino, uuid_cliente: crypto.randomUUID() };

        const primera = await pedir('POST', '/api/insumos/transferencia', 'administrativo', cuerpo);
        const segunda = await pedir('POST', '/api/insumos/transferencia', 'administrativo', cuerpo);

        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200, 'el reintento responde lo ya hecho');
        assert.equal(segunda.body.ya_registrada, true);
        assert.equal(await stockBodega(insumo), 6, 'la bodega se descuenta una sola vez');
        const movimientos = await pool.query(
            'SELECT id FROM movimientos_insumo WHERE insumo_id = $1 AND ubicacion_destino_id = $2', [insumo, destino]);
        assert.equal(movimientos.rows.length, 1);
    });

    test('tres cargas de furgon simultaneas con el mismo uuid no duplican', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(10);
        const destino = await crearFurgonDePrueba();
        const cuerpo = { insumo_id: insumo, cantidad: 2, ubicacion_destino_id: destino, uuid_cliente: crypto.randomUUID() };

        const respuestas = await Promise.all([1, 2, 3].map(() =>
            pedir('POST', '/api/insumos/transferencia', 'administrativo', cuerpo)));

        assert.ok(respuestas.every((r) => r.status === 200 || r.status === 201), JSON.stringify(respuestas.map((r) => r.status)));
        assert.equal(await stockBodega(insumo), 8);
    });

    test('una carga de furgon con uuid malformado se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(5);
        const r = await pedir('POST', '/api/insumos/transferencia', 'administrativo',
            { insumo_id: insumo, cantidad: 1, ubicacion_destino_id: await crearFurgonDePrueba(), uuid_cliente: 'no-es-un-uuid' });
        assert.equal(r.status, 400);
    });

    test('el catalogo de insumos trae el stock de bodega', async (t) => {
        if (!requiereBase(t)) return;
        const insumo = await crearInsumoConStock(7);
        const r = await pedir('GET', '/api/insumos', 'mecanico');
        assert.equal(r.status, 200);
        const fila = r.body.find((i) => i.id === insumo);
        assert.equal(fila.stock_bodega, 7);
        assert.equal(fila.stock_furgon, 0);
    });

    test('rechaza un uuid_cliente malformado', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const r = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', {
            descripcion: 'Filtro', cantidad: 1, uuid_cliente: 'no-es-un-uuid',
        });
        assert.equal(r.status, 400);
    });

    test('un tramo reintentado se registra una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const cuerpo = { inicio: new Date().toISOString(), uuid_cliente: crypto.randomUUID() };
        const primera = await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', cuerpo);
        const segunda = await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        const tramos = await pool.query('SELECT id FROM tramos_trabajo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(tramos.rows.length, 1);
    });

    test('cerrar un tramo abierto lo completa en vez de crear otro', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const inicio = new Date(Date.now() - 3600 * 1000).toISOString();
        await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', { inicio, uuid_cliente: crypto.randomUUID() });
        const termino = new Date().toISOString();
        const uuidCierre = crypto.randomUUID();
        const cierre = await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', {
            inicio, termino, uuid_cliente: uuidCierre,
        });
        assert.equal(cierre.status, 200);
        // reintento del mismo cierre (se perdio la respuesta): tampoco debe crear otro tramo
        const reintento = await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', {
            inicio, termino, uuid_cliente: uuidCierre,
        });
        assert.equal(reintento.status, 200);
        const tramos = await pool.query('SELECT termino FROM tramos_trabajo WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(tramos.rows.length, 1, 'un solo tramo, ya cerrado');
        assert.ok(tramos.rows[0].termino);
    });

    test('una lectura de horometro reintentada se registra una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const cuerpo = { valor: 1234, orden_trabajo_id: ot, uuid_cliente: crypto.randomUUID() };
        const ruta = `/api/horometro/maquinaria/${datos.maquinariaId}`;
        const primera = await pedir('POST', ruta, 'mecanico', cuerpo);
        const segunda = await pedir('POST', ruta, 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        assert.equal(segunda.body.ya_registrada, true);
        const lecturas = await pool.query('SELECT id FROM lecturas_horometro WHERE orden_trabajo_id = $1', [ot]);
        assert.equal(lecturas.rows.length, 1);
    });

    test('una OT en terreno reintentada devuelve la misma orden', async (t) => {
        if (!requiereBase(t)) return;
        const cuerpo = { maquinaria_id: datos.maquinariaId, uuid_cliente: crypto.randomUUID() };
        const primera = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', cuerpo);
        datos.ordenes.push(primera.body.id);
        const segunda = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        assert.equal(segunda.body.id, primera.body.id);
        assert.ok(primera.body.llegada_at, 'una OT abierta en terreno ya tiene su hora de llegada');
    });
});

describe('anulacion de lineas de repuesto', () => {
    test('anular devuelve el stock, deja la linea tachada y es idempotente', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const insumo = await crearInsumoConStock(10);
        const linea = await pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', {
            insumo_id: insumo, cantidad: 4, facturable: 'si',
        });
        assert.equal(await stockBodega(insumo), 6);

        const ruta = `/api/insumos/orden/${ot}/linea/${linea.body.id}/anular`;
        const anulada = await pedir('POST', ruta, 'administrativo');
        assert.equal(anulada.status, 200);
        assert.ok(anulada.body.anulada_at, 'queda la fecha de anulacion');
        assert.equal(anulada.body.orden_facturable, false, 'sin lineas vigentes la OT no se cobra');
        assert.equal(await stockBodega(insumo), 10);

        const otraVez = await pedir('POST', ruta, 'administrativo');
        assert.equal(otraVez.status, 200);
        assert.equal(await stockBodega(insumo), 10, 'anular dos veces no devuelve el stock dos veces');
    });

    test('el mecanico no anula lineas de una OT ajena', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno', datos.mecanicoDosId);
        const linea = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanicoDos', { descripcion: 'Correa', cantidad: 1 });
        const r = await pedir('POST', `/api/insumos/orden/${ot}/linea/${linea.body.id}/anular`, 'mecanico');
        assert.equal(r.status, 403);
    });

    test('el mecanico no anula lineas de una OT finalizada, el administrativo si', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const linea = await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Correa', cantidad: 1 });
        await pool.query("UPDATE ordenes_trabajo SET estado = 'finalizada' WHERE id = $1", [ot]);
        const ruta = `/api/insumos/orden/${ot}/linea/${linea.body.id}/anular`;
        assert.equal((await pedir('POST', ruta, 'mecanico')).status, 409);
        // cerrada la OT, el panel anula solo con motivo
        assert.equal((await pedir('POST', ruta, 'administrativo')).status, 400);
        assert.equal((await pedir('POST', ruta, 'administrativo', MOTIVO_VALIDO)).status, 200);
    });
});

describe('horometro de cualquier equipo', () => {
    test('el mecanico registra la lectura de un equipo que no es de ninguna orden suya', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'mecanico',
            { valor: 321, uuid_cliente: crypto.randomUUID() });
        assert.equal(r.status, 201);
        assert.equal(r.body.lectura.origen, 'movil');
        assert.equal(r.body.lectura.orden_trabajo_id, null);
    });

    test('un reintento de la lectura sin orden no la duplica', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const cuerpo = { valor: 100, uuid_cliente: crypto.randomUUID() };
        const primera = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'mecanico', cuerpo);
        const segunda = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        assert.equal(segunda.status, 200);
        const filas = await pool.query('SELECT id FROM lecturas_horometro WHERE maquinaria_id = $1', [equipo.id]);
        assert.equal(filas.rows.length, 1);
    });

    test('el mecanico puede reiniciar el contador de un equipo sin tener una orden', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'mecanico',
            { valor: 500, reiniciar_contador: true });
        assert.equal(r.status, 201);
        assert.equal(r.body.contador_reiniciado, true);
    });
});

describe('despacho sin documento', () => {
    test('un despacho sin PDF asigna el equipo al cliente y queda marcado como sin documento', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const cliente = await algunCliente();

        const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo',
            { tipo: 'despacho', cliente_id: cliente, sin_documento: true });

        assert.equal(r.status, 201);
        assert.equal(r.body.archivo_url, null);
        assert.equal(r.body.falta_documento, true);
        assert.ok(r.body.registrada_por, 'queda quien la registro');
        const maq = await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [equipo.id]);
        assert.equal(maq.rows[0].cliente_id, cliente, 'el equipo queda arrendado al cliente');
    });

    test('sin PDF y sin pedirlo expresamente se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo',
            { tipo: 'despacho', cliente_id: await algunCliente() });
        assert.equal(r.status, 400);
    });

    test('el mecanico no puede despachar sin documento', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'mecanico',
            { tipo: 'despacho', cliente_id: await algunCliente(), sin_documento: true });
        assert.equal(r.status, 403);
    });

    test('una recepcion sin documento libera el equipo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(cliente);
        const r = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo',
            { tipo: 'recepcion', sin_documento: true });
        assert.equal(r.status, 201);
        const maq = await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [equipo.id]);
        assert.equal(maq.rows[0].cliente_id, null);
    });

    test('las guias sin documento se listan completas, sin tope', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const creada = await pedir('POST', `/api/maquinarias/${equipo.id}/guias`, 'administrativo',
            { tipo: 'despacho', cliente_id: await algunCliente(), sin_documento: true });
        assert.equal(creada.status, 201);

        const lista = await pedir('GET', '/api/maquinarias/guias/recientes?sin_documento=1', 'administrativo');
        assert.equal(lista.status, 200);
        const fila = lista.body.find((g) => g.id === creada.body.id);
        assert.ok(fila, 'aparece entre las que faltan');
        assert.equal(fila.falta_documento, true);
        assert.equal(fila.url, null);
    });

    test('adjuntar un documento a una guia que ya lo tiene, o que no existe, se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const g = await pool.query(
            `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha) VALUES ($1, 'despacho', 'guias/ya-tiene.pdf', now()) RETURNING id`,
            [equipo.id]
        );
        const enviar = (id) => {
            // un formulario por envio: el cuerpo se consume al enviarlo
            const formulario = new FormData();
            formulario.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'g.pdf');
            return fetch(`${entorno.base}/api/maquinarias/guias/${id}/archivo`, {
                method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario,
            });
        };
        assert.equal((await enviar(g.rows[0].id)).status, 409);
        assert.equal((await enviar(999999999)).status, 404);
    });
});

describe('viaje del mecanico y ordenes sin asignar', () => {
    async function estadoDe(ot) {
        const r = await pool.query('SELECT estado, aceptada_at, en_camino_at, llegada_at FROM ordenes_trabajo WHERE id = $1', [ot]);
        return r.rows[0];
    }

    test('aceptar, salir y llegar fijan el estado y su hora, una sola vez', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');

        const aceptada = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada' });
        assert.equal(aceptada.status, 200);
        const primeraHora = (await estadoDe(ot)).aceptada_at;
        assert.ok(primeraHora, 'queda la hora de aceptacion');

        const camino = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_camino' });
        assert.equal(camino.status, 200);
        const llegada = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno' });
        assert.equal(llegada.status, 200);

        // reintentos atrasados de la cola: no retroceden el estado ni pisan las horas
        const reintento = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada' });
        assert.equal(reintento.status, 200);
        const fila = await estadoDe(ot);
        assert.equal(fila.estado, 'en_terreno');
        assert.equal(fila.aceptada_at.getTime(), primeraHora.getTime());
        assert.ok(fila.en_camino_at && fila.llegada_at);
    });

    test('la hora del toque en el telefono se respeta y nunca queda en el futuro', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '1 day' WHERE id = $1", [ot]);
        const hace2h = new Date(Date.now() - 2 * 3600 * 1000);
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', ocurrio_en: hace2h.toISOString() });
        const fila = await estadoDe(ot);
        assert.ok(Math.abs(fila.aceptada_at.getTime() - hace2h.getTime()) < 1000);

        const ot2 = await crearOt('asignada');
        const manana = new Date(Date.now() + 24 * 3600 * 1000);
        await pedir('PATCH', `/api/ordenes-trabajo/${ot2}/diagnostico`, 'mecanico', { estado: 'en_camino', ocurrio_en: manana.toISOString() });
        assert.ok((await estadoDe(ot2)).en_camino_at.getTime() <= Date.now() + 1000);
    });

    test('un APK anterior puede pasar de asignada directo a en_terreno', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno' });
        assert.equal(r.status, 200);
        assert.equal((await estadoDe(ot)).estado, 'en_terreno');
    });

    test('reasignar una OT del viaje a otro tecnico la deja asignada y borra las horas del anterior', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada' });
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_camino' });
        const antes = await estadoDe(ot);
        assert.ok(antes.aceptada_at && antes.en_camino_at);

        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoDosId });
        assert.equal(r.status, 200);
        const fila = await estadoDe(ot);
        assert.equal(fila.estado, 'asignada');
        assert.equal(fila.aceptada_at, null);
        assert.equal(fila.en_camino_at, null);
    });

    test('asignar otra vez al mismo tecnico una OT en camino no la hace retroceder', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_camino' });
        const antes = await estadoDe(ot);

        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId });
        assert.equal(r.status, 200);
        const fila = await estadoDe(ot);
        assert.equal(fila.estado, 'en_camino');
        assert.equal(fila.en_camino_at.getTime(), antes.en_camino_at.getTime());
    });

    test('la hora del telefono no puede quedar antes de que existiera la orden', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        const antiguo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', ocurrio_en: antiguo.toISOString() });
        const creada = (await pool.query('SELECT fecha_creacion FROM ordenes_trabajo WHERE id = $1', [ot])).rows[0].fecha_creacion;
        assert.ok((await estadoDe(ot)).aceptada_at.getTime() >= creada.getTime());
    });

    test('un id no numerico al tomar una orden responde 400', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('PATCH', '/api/ordenes-trabajo/abc/tomar', 'mecanico');
        assert.equal(r.status, 400);
    });

    test('el mecanico ve las ordenes sin asignar y las puede tomar', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente', null);

        const lista = await pedir('GET', '/api/ordenes-trabajo?sin_asignar=1', 'mecanico');
        assert.equal(lista.status, 200);
        assert.ok(lista.body.items.some((o) => o.id === ot), 'aparece entre las sin asignar');
        const suyas = await pedir('GET', '/api/ordenes-trabajo', 'mecanico');
        assert.ok(!suyas.body.items.some((o) => o.id === ot), 'no aparece en sus ordenes mientras no la tome');

        const tomada = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico');
        assert.equal(tomada.status, 200);
        assert.equal(tomada.body.estado, 'asignada');
        assert.equal(tomada.body.mecanico_id, datos.mecanicoId);

        const reintento = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico');
        assert.equal(reintento.status, 200, 'reintentar la propia toma responde bien');
        const otro = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanicoDos');
        assert.equal(otro.status, 409, 'otro mecanico ya no puede tomarla');
    });

    test('dos mecanicos tomando la misma orden a la vez: solo uno la logra', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente', null);
        const [a, b] = await Promise.all([
            pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico'),
            pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanicoDos'),
        ]);
        assert.deepEqual([a.status, b.status].sort(), [200, 409]);
        const r = await pool.query('SELECT mecanico_id FROM ordenes_trabajo WHERE id = $1', [ot]);
        assert.ok([datos.mecanicoId, datos.mecanicoDosId].includes(r.rows[0].mecanico_id));
    });

    test('no se puede tomar una orden que ya tiene mecanico ni una inexistente', async (t) => {
        if (!requiereBase(t)) return;
        const asignada = await crearOt('asignada', datos.mecanicoDosId);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${asignada}/tomar`, 'mecanico')).status, 409);
        assert.equal((await pedir('PATCH', '/api/ordenes-trabajo/999999999/tomar', 'mecanico')).status, 404);
    });
});

describe('ciclo de vida de la OT', () => {
    const avisosDe = async (ot, tipo) => (await pool.query(
        `SELECT id FROM notificaciones_pendientes
         WHERE (payload->>'orden_trabajo_id')::int = $1 AND payload->>'tipo' = $2`,
        [ot, tipo]
    )).rows.length;

    test('cerrar dos veces no cambia la fecha de cierre ni repite el aviso al cliente', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        const cuerpo = { persona_recibe: 'Juan Perez' };
        const primera = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', cuerpo);
        const segunda = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', cuerpo);
        assert.equal(primera.status, 200);
        assert.equal(segunda.status, 200, 'el reintento responde bien');
        assert.equal(segunda.body.fecha_cierre, primera.body.fecha_cierre);
        const cliente = await pool.query('SELECT cliente_id FROM ordenes_trabajo WHERE id = $1', [ot]);
        if (cliente.rows[0].cliente_id) {
            assert.ok(await avisosDe(ot, 'ot_finalizada') <= 1, 'a lo mas un aviso de cierre');
        }
    });

    test('una OT finalizada no se reasigna ni se reabre', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        const asignar = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoDosId });
        assert.equal(asignar.status, 409);
        const reabrir = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno' });
        assert.equal(reabrir.status, 409);
        const estado = await pool.query('SELECT estado, mecanico_id FROM ordenes_trabajo WHERE id = $1', [ot]);
        assert.equal(estado.rows[0].estado, 'finalizada');
        assert.equal(estado.rows[0].mecanico_id, datos.mecanicoId);
    });

    test('reasignar una OT en curso cambia el tecnico sin hacerla retroceder', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoDosId });
        assert.equal(r.status, 200);
        assert.equal(r.body.estado, 'en_reparacion');
        assert.equal(r.body.mecanico_id, datos.mecanicoDosId);
    });

    test('el mecanico no agrega repuestos, tramos ni fotos a una OT cerrada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        assert.equal((await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Filtro', cantidad: 1 })).status, 409);
        assert.equal((await pedir('POST', `/api/ordenes-trabajo/${ot}/tramos`, 'mecanico', { inicio: new Date().toISOString() })).status, 409);
        assert.equal((await pedir('POST', `/api/ordenes-trabajo/${ot}/evidencia/confirmar`, 'mecanico', { path: `ot-${ot}/x.jpg` })).status, 409);
    });

    test('la evidencia de otra orden se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/evidencia/confirmar`, 'mecanico', { path: `ot-${ot + 1}/ajena.jpg` });
        assert.equal(r.status, 400);
    });

    test('solo se valoriza una OT finalizada, y no aparece antes en la cola del gerente', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Bomba', cantidad: 1, facturable: 'si' });
        const enCurso = await pedir('GET', '/api/facturacion/pendientes', 'gerente');
        assert.ok(!enCurso.body.reparaciones_pendientes_valorizar.some((o) => o.id === ot), 'en curso no se valoriza');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 1000 })).status, 409);

        await pool.query("UPDATE ordenes_trabajo SET estado = 'finalizada' WHERE id = $1", [ot]);
        const cerrada = await pedir('GET', '/api/facturacion/pendientes', 'gerente');
        assert.ok(cerrada.body.reparaciones_pendientes_valorizar.some((o) => o.id === ot));
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 0 })).status, 200);
    });

    test('no se aprueba la valorizacion con repuestos sin decidir; decididos o anulados dejan de bloquear', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Filtro', cantidad: 1, facturable: 'pendiente' });
        await pedir('POST', `/api/insumos/orden/${ot}`, 'mecanico', { descripcion: 'Sello', cantidad: 1, facturable: 'pendiente' });
        await pool.query("UPDATE ordenes_trabajo SET estado = 'finalizada' WHERE id = $1", [ot]);

        const bloqueada = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 5000 });
        assert.equal(bloqueada.status, 409, JSON.stringify(bloqueada.body));
        assert.equal(bloqueada.body.codigo, 'repuestos_sin_decidir');
        assert.equal(bloqueada.body.repuestos_sin_decidir, 2);
        const sinCambio = await pool.query('SELECT valorizacion FROM ordenes_trabajo WHERE id = $1', [ot]);
        assert.equal(sinCambio.rows[0].valorizacion, null, 'no quedo ningun monto aprobado');
        assert.equal((await eventosDe(ot)).filter((e) => e.tipo === 'valorizacion').length, 0, 'ni su evento');

        // una linea anulada no cuenta; otra decidida tampoco
        const lineas = (await pool.query('SELECT id FROM movimientos_insumo WHERE orden_trabajo_id = $1 ORDER BY id', [ot])).rows;
        await pool.query('UPDATE movimientos_insumo SET anulada_at = now() WHERE id = $1', [lineas[0].id]);
        const unaFalta = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 5000 });
        assert.equal(unaFalta.status, 409);
        assert.equal(unaFalta.body.repuestos_sin_decidir, 1);
        await pool.query("UPDATE movimientos_insumo SET facturable = 'no' WHERE id = $1", [lineas[1].id]);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 5000 })).status, 200);
    });
});

describe('cliente de la orden de trabajo', () => {
    test('una orden nueva toma el cliente que tiene el equipo, sin que se lo pidan', async (t) => {
        if (!requiereBase(t)) return;
        const clienteId = await algunCliente();
        if (!clienteId) return t.skip('la base no tiene clientes');
        const equipo = await crearEquipo(clienteId);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, motivo: 'prueba' });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.equal(r.body.cliente_id, clienteId);
    });

    test('un equipo sin cliente da una orden sin cliente: es mantencion interna', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, motivo: 'prueba' });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.equal(r.body.cliente_id, null);
    });

    test('un cliente explicito de la llamada se respeta', async (t) => {
        if (!requiereBase(t)) return;
        const clienteId = await algunCliente();
        if (!clienteId) return t.skip('la base no tiene clientes');
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, cliente_id: clienteId });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.equal(r.body.cliente_id, clienteId);
    });

    test('la orden conserva su cliente aunque el equipo se devuelva despues', async (t) => {
        if (!requiereBase(t)) return;
        const clienteId = await algunCliente();
        if (!clienteId) return t.skip('la base no tiene clientes');
        const equipo = await crearEquipo(clienteId);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, motivo: 'prueba' });
        datos.ordenes.push(r.body.id);
        // la guia de recepcion deja el equipo sin cliente
        await pool.query('UPDATE maquinarias SET cliente_id = NULL WHERE id = $1', [equipo.id]);
        const guardada = await pool.query('SELECT cliente_id FROM ordenes_trabajo WHERE id = $1', [r.body.id]);
        assert.equal(guardada.rows[0].cliente_id, clienteId);
    });

    test('un equipo que no existe se informa como tal, no como error del servidor', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: 999999999, motivo: 'prueba' });
        assert.equal(r.status, 404);
    });

    test('sin equipo se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { motivo: 'prueba' });
        assert.equal(r.status, 400);
    });
});

describe('ficha del cliente', () => {
    test('edita correo y telefono sin tocar la cuenta de portal, y valida lo que llega', async (t) => {
        if (!requiereBase(t)) return;
        const nombre = `Ficha ${crypto.randomUUID().slice(0, 6)}`;
        const id = (await pool.query("INSERT INTO clientes (nombre) VALUES ($1) RETURNING id", [nombre])).rows[0].id;
        const cuenta = (await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, cliente_id)
             VALUES ('Cuenta ficha', $1, 'x', 'cliente', $2) RETURNING id, email`,
            [`ficha-${crypto.randomUUID().slice(0, 6)}@portal.test`, id]
        )).rows[0];
        const ok = await pedir('PATCH', `/api/clientes/${id}`, 'administrativo', { email: ' Contacto@Empresa.CL ', telefono: '+56 9 1111 2222' });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.email, 'contacto@empresa.cl');
        assert.equal(ok.body.telefono, '+56 9 1111 2222');
        assert.equal(ok.body.nombre, nombre, 'lo que no viene no cambia');
        const despues = (await pool.query('SELECT email FROM usuarios WHERE id = $1', [cuenta.id])).rows[0];
        assert.equal(despues.email, cuenta.email, 'el correo de inicio de sesion no cambia');
        // vaciar el correo lo deja en null
        const vacio = await pedir('PATCH', `/api/clientes/${id}`, 'administrativo', { email: '' });
        assert.equal(vacio.status, 200);
        assert.equal(vacio.body.email, null);
        // invalidos
        for (const cuerpo of [{ email: 'no-es-correo' }, { nombre: '' }, { rut: '1-1' }, {}]) {
            assert.equal((await pedir('PATCH', `/api/clientes/${id}`, 'administrativo', cuerpo)).status, 400, JSON.stringify(cuerpo));
        }
        assert.equal((await pedir('PATCH', '/api/clientes/999999999', 'administrativo', { telefono: '1' })).status, 404);
        assert.equal((await pedir('PATCH', `/api/clientes/${id}`, 'mecanico', { telefono: '1' })).status, 403);
        assert.equal((await pedir('PATCH', `/api/clientes/${id}`, 'cliente', { telefono: '1' })).status, 403);
        // el listado indica si el cliente tiene cuenta de portal
        const lista = await pedir('GET', '/api/clientes', 'administrativo');
        assert.equal(lista.body.find((c) => c.id === id).tiene_cuenta, true);
    });
});

describe('costos por equipo', () => {
    /** Un equipo con todo lo que entra a las cuentas: repuestos, factura, arriendo y horometro. */
    async function equipoConMovimiento() {
        const clienteId = await algunCliente();
        const equipo = await crearEquipo(clienteId);
        const ot = await crearOt('finalizada', datos.mecanicoId, equipo.id);

        // gasto: 3 x $1.000, mas una linea anulada que NO debe contar
        await pool.query(
            `INSERT INTO movimientos_insumo (orden_trabajo_id, cantidad, tipo, precio_unitario, descripcion)
             VALUES ($1, 3, 'salida', 1000, 'repuesto de prueba')`,
            [ot]
        );
        await pool.query(
            `INSERT INTO movimientos_insumo (orden_trabajo_id, cantidad, tipo, precio_unitario, descripcion, anulada_at)
             VALUES ($1, 5, 'salida', 9999, 'linea anulada de prueba', now())`,
            [ot]
        );
        // ingreso: una factura de arriendo directa al equipo
        await pool.query(`INSERT INTO facturas (folio, archivo_url, monto, maquinaria_id) VALUES ('T-COSTOS', 'x', 10000, $1)`, [equipo.id]);

        // arriendo del dia 40 al 35 hacia atras (6 dias con el despacho de la manana), y un
        // despacho fallido que no debe sumar nada
        // hora de Santiago de hace `dias` dias, sin depender de la zona del proceso (el CI corre en UTC)
        const { diaSantiago, horaSantiago, sumarDias } = require('../src/utils/diasArriendo');
        const hace = (dias, hora) => {
            const dia = sumarDias(diaSantiago(new Date()), -dias);
            for (const offset of ['-03:00', '-04:00']) {
                const d = new Date(`${dia}T${String(hora).padStart(2, '0')}:00:00${offset}`);
                if (horaSantiago(d) === hora && diaSantiago(d) === dia) return d;
            }
            throw new Error(`hora no representable en Santiago: ${dia} ${hora}`);
        };
        const guia = (tipo, fecha, fallido = false) =>
            pool.query(
                `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, fallido, cliente_id) VALUES ($1, $2, 'x', $3, $4, $5)`,
                [equipo.id, tipo, fecha, fallido, clienteId]
            );
        await guia('despacho', hace(40, 9));
        await guia('recepcion', hace(35, 14));
        await guia('despacho', hace(20, 9), true);
        await guia('recepcion', hace(15, 9), true);

        // horometro: 100 h hace 60 dias y 160 h hace 10 dias = 60 h de uso
        await pool.query(
            `INSERT INTO lecturas_horometro (maquinaria_id, valor, origen, fecha) VALUES ($1, 100, 'panel', $2), ($1, 160, 'panel', $3)`,
            [equipo.id, hace(60, 10), hace(10, 10)]
        );
        return equipo;
    }

    const buscar = async (equipo, extra = '') => {
        const r = await pedir('GET', `/api/rentabilidad?q=${equipo.codigo}${extra}`, 'administrativo');
        assert.equal(r.status, 200);
        return r.body;
    };

    test('calcula gasto, ingreso, margen y las medidas de la industria de un equipo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await equipoConMovimiento();
        const { items } = await buscar(equipo);
        assert.equal(items.length, 1);
        const e = items[0];
        assert.equal(e.gasto, 3000, 'la linea anulada no cuenta como gasto');
        assert.equal(e.ingreso, 10000);
        assert.equal(e.margen, 7000);
        assert.equal(e.resultado, 'con_ganancia');
        assert.equal(e.gasto_sobre_ingreso, 30);
        assert.equal(e.horas_uso, 60);
        assert.equal(e.gasto_por_hora, 50);
        assert.equal(e.dias_arrendado, 6, 'las guias fallidas no suman dias');
    });

    test('el traslado cobrado en una factura no cuenta como ingreso del equipo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await equipoConMovimiento();
        // factura de 100.000 con 20.000 de traslado: suma 80.000 de arriendo, mas los 10.000 de la otra factura
        await pool.query(
            `INSERT INTO facturas (folio, archivo_url, monto, monto_traslado, maquinaria_id) VALUES ('T-TRASLADO', 'x', 100000, 20000, $1)`,
            [equipo.id]
        );
        const { items } = await buscar(equipo);
        assert.equal(items[0].ingreso, 90000);
        // la base no admite un traslado mayor que el monto
        await assert.rejects(
            pool.query(`INSERT INTO facturas (folio, archivo_url, monto, monto_traslado, maquinaria_id) VALUES ('T-TRASLADO-MAL', 'x', 1000, 2000, $1)`, [equipo.id]),
            /facturas_monto_traslado_chk/
        );
    });

    test('un equipo sin movimiento queda sin datos en vez de inventarlos', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const { items } = await buscar(equipo);
        const e = items[0];
        assert.equal(e.resultado, 'sin_movimiento');
        assert.equal(e.gasto_sobre_ingreso, null);
        assert.equal(e.gasto_por_hora, null);
        assert.equal(e.horas_uso, null);
        assert.equal(e.dias_arrendado, 0);
    });

    test('el filtro por resultado deja solo los equipos de esa clase', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await equipoConMovimiento();
        const gana = await buscar(equipo, '&resultado=con_ganancia');
        assert.equal(gana.items.length, 1);
        const pierde = await buscar(equipo, '&resultado=a_perdida');
        assert.equal(pierde.items.length, 0);
    });

    test('el resumen de arriba no cambia al buscar un equipo', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await equipoConMovimiento();
        const todos = (await pedir('GET', '/api/rentabilidad?limit=1', 'administrativo')).body;
        const uno = await buscar(equipo);
        assert.deepEqual(uno.resumen, todos.resumen);
        assert.ok(todos.resumen.gasto_total >= 3000);
        assert.ok(todos.resumen.ingreso_total >= 10000);
    });

    test('ordenar por una columna deja los vacios al final, en los dos sentidos', async (t) => {
        if (!requiereBase(t)) return;
        await equipoConMovimiento();
        for (const dir of ['asc', 'desc']) {
            const r = await pedir('GET', `/api/rentabilidad?orden=hora&dir=${dir}`, 'administrativo');
            const valores = r.body.items.map((e) => e.gasto_por_hora);
            const primerVacio = valores.indexOf(null);
            if (primerVacio !== -1) assert.ok(valores.slice(primerVacio).every((v) => v === null), `${dir}: un valor aparecio despues de un vacio`);
            const conValor = valores.filter((v) => v !== null);
            const esperado = [...conValor].sort((a, b) => (dir === 'asc' ? a - b : b - a));
            assert.deepEqual(conValor, esperado);
        }
    });

    test('un orden inventado no rompe la consulta', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', `/api/rentabilidad?orden=${encodeURIComponent("x'; DROP TABLE maquinarias; --")}`, 'administrativo');
        assert.equal(r.status, 200);
    });

    test('el mecanico no ve los costos', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', '/api/rentabilidad', 'mecanico');
        assert.equal(r.status, 403);
    });
});

describe('alta de equipos', () => {
    test('repetir un codigo se informa como un choque que se puede corregir, no como un error del servidor', async (t) => {
        if (!requiereBase(t)) return;
        const codigo = `ZZ-${crypto.randomUUID().slice(0, 8)}`;
        const primero = await pedir('POST', '/api/maquinarias', 'administrativo', { codigo, tipo: 'Equipo de prueba' });
        assert.equal(primero.status, 201);
        datos.equipos.push(primero.body.id);
        const repetido = await pedir('POST', '/api/maquinarias', 'administrativo', { codigo, tipo: 'Otro' });
        assert.equal(repetido.status, 409);
        assert.match(repetido.body.error, new RegExp(codigo));
    });

    test('sin codigo o sin tipo se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await pedir('POST', '/api/maquinarias', 'administrativo', { tipo: 'X' })).status, 400);
        assert.equal((await pedir('POST', '/api/maquinarias', 'administrativo', { codigo: 'ZZ-SINTIPO' })).status, 400);
    });

    test('solo el administrativo da de alta equipos', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/maquinarias', 'mecanico', { codigo: 'ZZ-NOPUEDE', tipo: 'X' });
        assert.equal(r.status, 403);
    });
});
