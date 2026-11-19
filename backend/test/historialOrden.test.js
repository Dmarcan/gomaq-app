// Historial de la orden (ordenes_eventos): un evento por cada cambio, candado de solo insercion y endpoint de historial.
// Corren contra una base local; ver utils/entornoEscritura.js (GOMAQ_TEST_ESCRITURA=1 npm test).

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { requiereBase } = require('./utils/http');
const {
    pool,
    datos,
    pedir,
    purgarOrdenes,
    crearOt,
    crearEquipo,
    algunCliente,
    eventosDe,
} = require('./utils/entornoEscritura');

describe('historial de la orden: un evento por cada cambio', () => {
    test('crear una OT desde el panel deja el evento de creacion con quien la creo', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: datos.maquinariaId, motivo: 'prueba de historial' });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        const eventos = await eventosDe(r.body.id);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'creacion');
        assert.equal(eventos[0].origen, 'panel');
        assert.equal(eventos[0].rol, 'administrativo');
        assert.equal(eventos[0].estado_nuevo, 'pendiente');
        assert.ok(eventos[0].usuario_id);
        assert.equal(eventos[0].aplicado, true);
        assert.equal(eventos[0].hora_dudosa, false);
    });

    test('una creacion que falla no deja evento ni OT a medias', async (t) => {
        if (!requiereBase(t)) return;
        // solo se mira lo que esta prueba habria creado, reconocible por su motivo: no depende de
        // que otras pruebas o procesos escriban a la vez
        const marcador = `creacion-fallida-${crypto.randomUUID()}`;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', {
            // un cliente que no existe rompe el INSERT (clave foranea) despues de empezar la transaccion
            maquinaria_id: datos.maquinariaId, cliente_id: 99999999, motivo: marcador,
        });
        assert.equal(r.status, 500);
        const ots = await pool.query('SELECT id FROM ordenes_trabajo WHERE motivo = $1', [marcador]);
        assert.equal(ots.rows.length, 0);
        const eventos = await pool.query(
            `SELECT count(*)::int AS n FROM ordenes_eventos e JOIN ordenes_trabajo o ON o.id = e.orden_trabajo_id WHERE o.motivo = $1`,
            [marcador]
        );
        assert.equal(eventos.rows[0].n, 0);
    });

    test('la OT que el mecanico abre en terreno deja su evento, y el reintento no lo duplica', async (t) => {
        if (!requiereBase(t)) return;
        const uuid = crypto.randomUUID();
        const cuerpo = { maquinaria_id: datos.maquinariaId, uuid_cliente: uuid };
        const primera = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', cuerpo);
        assert.equal(primera.status, 201);
        datos.ordenes.push(primera.body.id);
        const segunda = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', cuerpo);
        assert.equal(segunda.status, 200);
        const eventos = await eventosDe(primera.body.id);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'creacion');
        assert.equal(eventos[0].origen, 'terreno');
        assert.equal(eventos[0].estado_nuevo, 'en_terreno');
        assert.equal(eventos[0].uuid_cliente, uuid);
        assert.equal(eventos[0].detalle.mecanico_id, datos.mecanicoId);
    });

    test('convertir una solicitud en OT deja el evento de creacion', async (t) => {
        if (!requiereBase(t)) return;
        const clienteId = await algunCliente();
        if (!clienteId) return t.skip('la base no tiene clientes');
        const equipo = await crearEquipo(clienteId);
        const sol = await pool.query(
            `INSERT INTO solicitudes (cliente_id, maquinaria_id, descripcion) VALUES ($1, $2, 'solicitud de prueba') RETURNING id`,
            [clienteId, equipo.id]
        );
        datos.solicitudes.push(sol.rows[0].id);
        const r = await pedir('PATCH', `/api/solicitudes/${sol.rows[0].id}/convertir`, 'administrativo');
        assert.equal(r.status, 200);
        datos.ordenes.push(r.body.orden_trabajo.id);
        const eventos = await eventosDe(r.body.orden_trabajo.id);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'creacion');
        assert.equal(eventos[0].detalle.solicitud_id, sol.rows[0].id);
        // convertirla otra vez se rechaza y no agrega nada
        assert.equal((await pedir('PATCH', `/api/solicitudes/${sol.rows[0].id}/convertir`, 'administrativo')).status, 400);
        assert.equal((await eventosDe(r.body.orden_trabajo.id)).length, 1);
    });

    test('asignar deja el evento con el tecnico anterior y el nuevo; asignar al mismo no repite', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente', null);
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId });
        assert.equal(r.status, 200);
        let eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'asignacion');
        assert.equal(eventos[0].estado_anterior, 'pendiente');
        assert.equal(eventos[0].estado_nuevo, 'asignada');
        assert.equal(eventos[0].detalle.mecanico_anterior_id, null);
        assert.equal(eventos[0].detalle.mecanico_nuevo_id, datos.mecanicoId);
        assert.equal(eventos[0].origen, 'panel');

        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId });
        assert.equal((await eventosDe(ot)).length, 1, 'el doble clic no deja otro evento');

        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoDosId });
        eventos = await eventosDe(ot);
        assert.equal(eventos.length, 2);
        assert.equal(eventos[1].detalle.mecanico_anterior_id, datos.mecanicoId);
        assert.equal(eventos[1].detalle.mecanico_nuevo_id, datos.mecanicoDosId);
    });

    test('tomar una orden deja el evento de toma, y el reintento del mismo mecanico no lo repite', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente', null);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico')).status, 200);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanico')).status, 200);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/tomar`, 'mecanicoDos')).status, 409);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'toma');
        assert.equal(eventos[0].origen, 'terreno');
        assert.equal(eventos[0].estado_nuevo, 'asignada');
        assert.equal(eventos[0].detalle.mecanico_nuevo_id, datos.mecanicoId);
    });

    test('cada cambio de estado del diagnostico deja su evento, con el uuid de la tarea (body.uuid)', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        const uuid = crypto.randomUUID();
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', uuid });
        assert.equal(r.status, 200);
        const reintento = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', uuid });
        assert.equal(reintento.status, 200);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1, 'el reintento con el mismo uuid no duplica ni da 500');
        assert.equal(eventos[0].tipo, 'cambio_estado');
        assert.equal(eventos[0].estado_anterior, 'asignada');
        assert.equal(eventos[0].estado_nuevo, 'aceptada');
        assert.equal(eventos[0].aplicado, true);
        assert.equal(eventos[0].uuid_cliente, uuid);
        assert.equal(eventos[0].origen, 'terreno');

        const siguiente = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_camino', uuid_cliente: crypto.randomUUID() });
        assert.equal(siguiente.status, 200);
        assert.equal((await eventosDe(ot)).length, 2);
    });

    test('un cambio de estado atrasado se registra con aplicado = false y no mueve la OT', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', uuid: crypto.randomUUID() });
        assert.equal(r.status, 200);
        assert.equal(r.body.estado, 'en_terreno');
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].aplicado, false);
        assert.equal(eventos[0].estado_anterior, 'en_terreno');
        assert.equal(eventos[0].estado_nuevo, 'aceptada');
    });

    test('un cambio rechazado, o un diagnostico sin estado, no deja evento', async (t) => {
        if (!requiereBase(t)) return;
        const cerrada = await crearOt('finalizada');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${cerrada}/diagnostico`, 'mecanico', { estado: 'en_terreno' })).status, 409);
        const ajena = await crearOt('en_terreno', datos.mecanicoDosId);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ajena}/diagnostico`, 'mecanico', { estado: 'en_reparacion' })).status, 403);
        const sinEstado = await crearOt('en_terreno');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${sinEstado}/diagnostico`, 'mecanico', { diagnostico: 'solo texto' })).status, 200);
        assert.equal((await eventosDe(cerrada)).length, 0);
        assert.equal((await eventosDe(ajena)).length, 0);
        assert.equal((await eventosDe(sinEstado)).length, 0);
    });

    test('un uuid malformado no rompe el cambio: se registra sin idempotencia', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', uuid: 'no-es-un-uuid' });
        assert.equal(r.status, 200);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].uuid_cliente, null);
    });

    test('la hora del telefono en el futuro o antes de crear la OT marca el evento como dudoso', async (t) => {
        if (!requiereBase(t)) return;
        const futura = await crearOt('asignada');
        const manana = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        await pedir('PATCH', `/api/ordenes-trabajo/${futura}/diagnostico`, 'mecanico', { estado: 'aceptada', ocurrio_en: manana });
        const evFutura = (await eventosDe(futura))[0];
        assert.equal(evFutura.hora_dudosa, true);
        assert.equal(new Date(evFutura.ocurrio_en).toISOString(), manana, 'el evento guarda la hora tal como vino');

        const antigua = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '1 hour' WHERE id = $1", [antigua]);
        await pedir('PATCH', `/api/ordenes-trabajo/${antigua}/diagnostico`, 'mecanico', {
            estado: 'aceptada', ocurrio_en: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
        });
        assert.equal((await eventosDe(antigua))[0].hora_dudosa, true);

        const normal = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '2 hours' WHERE id = $1", [normal]);
        await pedir('PATCH', `/api/ordenes-trabajo/${normal}/diagnostico`, 'mecanico', {
            estado: 'aceptada', ocurrio_en: new Date(Date.now() - 3600 * 1000).toISOString(),
        });
        assert.equal((await eventosDe(normal))[0].hora_dudosa, false);
    });

    test('finalizar deja el evento de cierre; el reintento de un cierre ya aplicado no deja otro', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_reparacion');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { sin_persona: true });
        assert.equal(r.status, 200);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { sin_persona: true })).status, 200);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 1);
        assert.equal(eventos[0].tipo, 'cierre');
        assert.equal(eventos[0].estado_anterior, 'en_reparacion');
        assert.equal(eventos[0].estado_nuevo, 'finalizada');
        assert.equal(eventos[0].origen, 'terreno');
        assert.equal(new Date(eventos[0].ocurrio_en).getTime(), new Date(r.body.fecha_cierre).getTime());
    });

    test('una orden pendiente no se cierra y no deja evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('pendiente');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { sin_persona: true })).status, 409);
        assert.equal((await eventosDe(ot)).length, 0);
    });

    test('valorizar deja el evento con el monto anterior y el nuevo', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 15000 })).status, 200);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 20000 })).status, 200);
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 2);
        assert.equal(eventos[0].tipo, 'valorizacion');
        assert.equal(eventos[0].rol, 'gerente');
        assert.equal(eventos[0].origen, 'panel');
        assert.equal(eventos[0].detalle.valorizacion_anterior, null);
        assert.equal(eventos[0].detalle.valorizacion_nueva, 15000);
        assert.equal(eventos[1].detalle.valorizacion_anterior, 15000);
        assert.equal(eventos[1].detalle.valorizacion_nueva, 20000);
    });

    test('una valorizacion rechazada no deja evento', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 100 })).status, 409);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: -5 })).status, 400);
        assert.equal((await pedir('PATCH', '/api/ordenes-trabajo/99999999/valorizacion', 'gerente', { valorizacion: 100 })).status, 404);
        assert.equal((await eventosDe(ot)).length, 0);
    });
});

describe('historial de la orden: el candado de solo insercion', () => {
    test('el trigger rechaza UPDATE, DELETE y TRUNCATE, y la clave foranea impide borrar la OT', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 1 });
        await assert.rejects(
            pool.query("UPDATE ordenes_eventos SET rol = 'x' WHERE orden_trabajo_id = $1", [ot]),
            /solo insercion/
        );
        await assert.rejects(pool.query('DELETE FROM ordenes_eventos WHERE orden_trabajo_id = $1', [ot]), /solo insercion/);
        await assert.rejects(pool.query('TRUNCATE ordenes_eventos'), /solo insercion/);
        await assert.rejects(pool.query('DELETE FROM ordenes_trabajo WHERE id = $1', [ot]), { code: '23503' });
        assert.equal((await eventosDe(ot)).length, 1);
    });

    test('con la via de purga activa se puede modificar y borrar, y vale solo dentro de la transaccion', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 1 });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL gomaq.purga = 'on'");
            const upd = await client.query("UPDATE ordenes_eventos SET rol = 'x' WHERE orden_trabajo_id = $1", [ot]);
            assert.equal(upd.rowCount, 1);
            await client.query('ROLLBACK');
            // fuera de la transaccion la purga ya no esta activa
            await assert.rejects(client.query("UPDATE ordenes_eventos SET rol = 'x' WHERE orden_trabajo_id = $1", [ot]), /solo insercion/);
        } finally {
            client.release();
        }
        await purgarOrdenes([ot]);
        assert.equal((await eventosDe(ot)).length, 0);
        assert.equal((await pool.query('SELECT 1 FROM ordenes_trabajo WHERE id = $1', [ot])).rows.length, 0);
    });

    test('un evento con el mismo uuid y tipo no se inserta dos veces; sin uuid si se repite; tipo y origen se validan', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        const uuid = crypto.randomUUID();
        const sql = `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen, uuid_cliente)
                     VALUES ($1, $2, now(), 'sistema', $3) ON CONFLICT DO NOTHING`;
        await pool.query(sql, [ot, 'cambio_estado', uuid]);
        await pool.query(sql, [ot, 'cambio_estado', uuid]);
        await pool.query(sql, [ot, 'cierre', uuid]);
        await pool.query(sql, [ot, 'cambio_estado', null]);
        await pool.query(sql, [ot, 'cambio_estado', null]);
        assert.equal((await eventosDe(ot)).length, 4);
        await assert.rejects(pool.query("INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen) VALUES ($1, 'inventado', now(), 'sistema')", [ot]), { code: '23514' });
        await assert.rejects(pool.query("INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen) VALUES ($1, 'cierre', now(), 'otro')", [ot]), { code: '23514' });
    });
});

describe('historial de la orden: carga inicial de la migracion', () => {
    test('reconstruye los eventos de una OT existente desde sus fechas', async (t) => {
        if (!requiereBase(t)) return;
        const fs = require('node:fs');
        const path = require('node:path');
        const sql = fs.readFileSync(path.join(__dirname, '../../db/migrations/020_ordenes_eventos.sql'), 'utf8');
        const carga = sql.slice(sql.indexOf('-- Carga inicial'));
        assert.ok(carga.includes('INSERT INTO ordenes_eventos'), 'no se encontro la carga inicial en la migracion');

        const ot = await crearOt('finalizada');
        await pool.query(
            `UPDATE ordenes_trabajo SET fecha_creacion = '2026-01-01 08:00+00', aceptada_at = '2026-01-01 09:00+00',
                    en_camino_at = '2026-01-01 09:30+00', llegada_at = '2026-01-01 10:00+00', fecha_cierre = '2026-01-01 12:00+00'
             WHERE id = $1`,
            [ot]
        );
        // un APK antiguo salta de asignada a en_camino: aceptada_at queda nulo
        const saltada = await crearOt('en_camino');
        await pool.query(
            "UPDATE ordenes_trabajo SET fecha_creacion = '2026-01-02 08:00+00', en_camino_at = '2026-01-02 09:30+00' WHERE id = $1",
            [saltada]
        );
        const client = await pool.connect();
        try {
            // se corre dentro de una transaccion que se deshace: la carga toca todas las OT de la base
            await client.query('BEGIN');
            await client.query(carga);
            const r = await client.query(
                'SELECT tipo, estado_anterior, estado_nuevo, origen, usuario_id, ocurrio_en FROM ordenes_eventos WHERE orden_trabajo_id = $1 ORDER BY ocurrio_en, id',
                [ot]
            );
            const s = await client.query(
                `SELECT tipo, estado_anterior, estado_nuevo FROM ordenes_eventos WHERE orden_trabajo_id = $1 AND tipo = 'cambio_estado'`,
                [saltada]
            );
            await client.query('ROLLBACK');
            assert.deepEqual(s.rows, [{ tipo: 'cambio_estado', estado_anterior: null, estado_nuevo: 'en_camino' }],
                'sin aceptada_at no se inventa el estado anterior');
            assert.equal(r.rows[2].estado_anterior, 'aceptada');
            assert.deepEqual(r.rows.map((e) => [e.tipo, e.estado_nuevo]), [
                ['creacion', null], ['cambio_estado', 'aceptada'], ['cambio_estado', 'en_camino'],
                ['cambio_estado', 'en_terreno'], ['cierre', 'finalizada'],
            ]);
            assert.ok(r.rows.every((e) => e.origen === 'migracion' && e.usuario_id === null));
            assert.equal(r.rows[4].ocurrio_en.toISOString(), '2026-01-01T12:00:00.000Z');
        } finally {
            client.release();
        }
        assert.equal((await eventosDe(ot)).length, 0, 'la prueba no deja eventos');
    });
});

describe('historial de la orden: endpoint GET /:id/historial', () => {
    test('devuelve los eventos en el orden en que llegaron al servidor, con el nombre de quien los hizo', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '3 hours' WHERE id = $1", [ot]);
        const haceUnaHora = new Date(Date.now() - 3600 * 1000).toISOString();
        const haceDosHoras = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        // llega primero lo que ocurrio despues: el historial ordena por orden de escritura (id), no por ocurrio_en
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno', ocurrio_en: haceUnaHora });
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'aceptada', ocurrio_en: haceDosHoras });

        for (const rol of ['administrativo', 'gerente']) {
            const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, rol);
            assert.equal(r.status, 200);
            assert.equal(r.body.length, 2);
            assert.deepEqual(r.body.map((e) => e.estado_nuevo), ['en_terreno', 'aceptada']);
            assert.equal(r.body[1].aplicado, false, 'la aceptada llego atrasada y no movio nada');
            assert.equal(r.body[0].usuario_nombre, 'Mecanico Prueba');
            assert.ok(r.body.every((e) => e.sincronizado_tarde === true), 'ocurrieron hace horas y llegaron ahora');
        }
    });

    test('un evento registrado al momento no figura como sincronizado tarde', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 10 });
        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'administrativo');
        assert.equal(r.body.length, 1);
        assert.equal(r.body[0].sincronizado_tarde, false);
        assert.equal(r.body[0].usuario_nombre, 'Admin Prueba');
    });

    test('un id invalido responde 400 y una OT inexistente 404', async (t) => {
        if (!requiereBase(t)) return;
        for (const id of ['abc', '0', '-3', '1.5', '1e3', '99999999999999']) {
            const r = await pedir('GET', `/api/ordenes-trabajo/${id}/historial`, 'administrativo');
            assert.equal(r.status, 400, `id ${id}`);
        }
        assert.equal((await pedir('GET', '/api/ordenes-trabajo/99999999/historial', 'administrativo')).status, 404);
    });

    test('el mecanico y el cliente no ven el historial', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno');
        assert.equal((await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'mecanico')).status, 403);
        assert.equal((await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'cliente')).status, 403);
    });
});

describe('historial de la orden: OT creada en terreno sin senal y hora dudosa', () => {
    /** Abre una OT como lo hace la app al sincronizar: nace ahora, aunque el mecanico la creo antes. */
    async function abrirEnTerreno() {
        const r = await pedir('POST', '/api/ordenes-trabajo/en-terreno', 'mecanico', {
            maquinaria_id: datos.maquinariaId, uuid_cliente: crypto.randomUUID(),
        });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        return r.body.id;
    }

    test('los eventos anteriores a la fecha de creacion de una OT sincronizada no son dudosos; la creacion va primero y el resto por llegada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await abrirEnTerreno();
        const haceUnaHora = new Date(Date.now() - 3600 * 1000).toISOString();
        const haceMediaHora = new Date(Date.now() - 1800 * 1000).toISOString();
        for (const [estado, ocurrio_en] of [['en_reparacion', haceMediaHora], ['en_terreno', haceUnaHora]]) {
            const p = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado, ocurrio_en, uuid: crypto.randomUUID() });
            assert.equal(p.status, 200);
        }
        const eventos = await eventosDe(ot);
        assert.equal(eventos.length, 3);
        assert.ok(eventos.every((e) => e.hora_dudosa === false), 'ninguno es dudoso');

        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'administrativo');
        assert.equal(r.status, 200);
        assert.equal(r.body[0].tipo, 'creacion', 'la creacion va primero aunque sea la mas reciente');
        assert.deepEqual(r.body.slice(1).map((e) => e.estado_nuevo), ['en_reparacion', 'en_terreno'], 'el resto, por orden de escritura');
    });

    test('una OT que no nacio por sincronizacion sigue marcando dudoso lo anterior a su creacion', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '1 hour' WHERE id = $1", [ot]);
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', {
            estado: 'aceptada', ocurrio_en: new Date(Date.now() - 5 * 3600 * 1000).toISOString(),
        });
        assert.equal((await eventosDe(ot))[0].hora_dudosa, true);
    });

    test('una hora en el futuro es dudosa (con 2 minutos de margen) y no altera el orden de llegada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await abrirEnTerreno();
        const manana = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_reparacion', ocurrio_en: manana, uuid: crypto.randomUUID() });
        // sin hora del telefono: la del servidor, que es posterior a la llegada del primero
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_terreno', uuid: crypto.randomUUID() });
        const eventos = await eventosDe(ot);
        assert.equal(eventos[1].hora_dudosa, true);
        assert.equal(eventos[2].hora_dudosa, false);

        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'gerente');
        assert.deepEqual(r.body.map((e) => e.tipo === 'creacion' ? 'creacion' : e.estado_nuevo), ['creacion', 'en_reparacion', 'en_terreno'],
            'el orden es el de llegada aunque la hora del primero este en el futuro');

        // un reloj adelantado un minuto cae dentro del margen
        const unMinuto = new Date(Date.now() + 60 * 1000).toISOString();
        await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado: 'en_reparacion', ocurrio_en: unMinuto, uuid: crypto.randomUUID() });
        assert.equal((await eventosDe(ot))[3].hora_dudosa, false);
    });

    test('con el reloj del telefono atrasado y horas fuera de orden, la cadena de estados sale coherente y en orden de llegada', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('asignada');
        await pool.query("UPDATE ordenes_trabajo SET fecha_creacion = now() - interval '5 hours' WHERE id = $1", [ot]);
        const hace = (min) => new Date(Date.now() - min * 60 * 1000).toISOString();
        // el telefono va una hora atrasado y sus horas ni siquiera siguen el orden de los pasos
        const pasos = [['aceptada', hace(110)], ['en_camino', hace(120)], ['en_terreno', hace(115)]];
        for (const [estado, ocurrio_en] of pasos) {
            const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/diagnostico`, 'mecanico', { estado, ocurrio_en, uuid: crypto.randomUUID() });
            assert.equal(r.status, 200);
        }
        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'administrativo');
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.map((e) => [e.estado_anterior, e.estado_nuevo]), [
            ['asignada', 'aceptada'], ['aceptada', 'en_camino'], ['en_camino', 'en_terreno'],
        ], 'cada "de X a Y" parte de donde termino el anterior');
        assert.ok(r.body.every((e) => e.aplicado === true && e.hora_dudosa === false));
    });

    test('los eventos con la hora del servidor (creacion y cierre) no pasan por la hora dudosa', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: datos.maquinariaId });
        datos.ordenes.push(r.body.id);
        const ev = (await eventosDe(r.body.id))[0];
        assert.equal(ev.hora_dudosa, false);
        assert.equal(new Date(ev.ocurrio_en).getTime(), new Date(r.body.fecha_creacion).getTime());
    });
});

describe('historial de la orden: orden y sincronizacion tardia con datos insertados a mano', () => {
    test('un evento reconstruido por la migracion no figura como sincronizado tarde', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('finalizada');
        // como la carga inicial de la migracion: hora historica y registrado_en = ahora
        await pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, registrado_en, origen)
             VALUES ($1, 'cierre', now() - interval '90 days', now(), 'migracion')`,
            [ot]
        );
        await pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, registrado_en, origen)
             VALUES ($1, 'valorizacion', now() - interval '90 days', now(), 'panel')`,
            [ot]
        );
        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'administrativo');
        assert.equal(r.status, 200);
        assert.equal(r.body.find((e) => e.origen === 'migracion').sincronizado_tarde, false);
        assert.equal(r.body.find((e) => e.origen === 'panel').sincronizado_tarde, true, 'el resto sigue la regla de los 10 minutos');
        // la limpieza de la OT (hook after) usa la via de purga
    });

    test('la creacion va primero aunque otro evento tenga un id menor', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt('en_terreno');
        await pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, estado_nuevo, ocurrio_en, origen)
             VALUES ($1, 'cambio_estado', 'en_terreno', now(), 'terreno')`,
            [ot]
        );
        await pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, estado_nuevo, ocurrio_en, origen)
             VALUES ($1, 'creacion', 'en_terreno', now(), 'terreno')`,
            [ot]
        );
        const eventos = await eventosDe(ot);
        assert.equal(eventos[0].tipo, 'cambio_estado', 'el cambio tiene el id menor');
        const r = await pedir('GET', `/api/ordenes-trabajo/${ot}/historial`, 'gerente');
        assert.deepEqual(r.body.map((e) => e.tipo), ['creacion', 'cambio_estado']);
    });
});
