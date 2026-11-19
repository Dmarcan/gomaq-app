// Avisos sin proveedor y contratos para el dashboard, Ordenes y el portal.
// Corren contra una base local; ver utils/entornoEscritura.js (GOMAQ_TEST_ESCRITURA=1 npm test).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { requiereBase, tokenClienteDe } = require('./utils/http');
const {
    pool,
    datos,
    tokens,
    entorno,
    HABILITADO,
    pedir,
    pedirConToken,
    crearOt,
    afirmarClavesPortal,
    MOTIVO_VALIDO,
    crearEquipo,
    algunCliente,
    cerrarOt,
    facturarDirecto,
    agregarLinea,
    rutaLinea,
    otValorizada,
} = require('./utils/entornoEscritura');

describe('avisos sin proveedor no se encolan', () => {
    // Desde la migracion 046 solo se encola lo que tiene envio real (el correo de factura, ver utils/avisos.js).
    // Estas pruebas conservan el recorrido de cada accion (estados y respuestas) y comprueban que no deja filas.
    const TIPOS = ['ot_asignada', 'ot_reasignada', 'ot_disponible', 'ot_por_valorizar', 'factura_anulada', 'ajuste_inventario', 'asistencia_nueva'];
    const SIN_PROVEEDOR = [...TIPOS, 'mecanico_asignado', 'ot_finalizada', 'mantencion_proxima'];
    const MARCA = { telefono: '+56911110000', telefonoDos: '+56922220000' };
    let inicio;
    let respaldo;

    /** Avisos nuevos de un tipo desde `inicio`, opcionalmente de una OT. */
    async function avisos(tipo, ordenId = null) {
        const r = await pool.query(
            `SELECT canal, destinatario, payload FROM notificaciones_pendientes
             WHERE created_at >= $1 AND payload->>'tipo' = $2
               AND ($3::int IS NULL OR (payload->>'orden_trabajo_id')::int = $3)
             ORDER BY id`, [inicio, tipo, ordenId]);
        return r.rows;
    }

    // el correo no se toca (el login de las pruebas lo usa): solo el WhatsApp de cada mecanico
    async function contactos(telefonoMecanico, telefonoMecanicoDos) {
        await pool.query('UPDATE usuarios SET telefono_whatsapp = $1 WHERE id = $2', [telefonoMecanico, datos.mecanicoId]);
        await pool.query('UPDATE usuarios SET telefono_whatsapp = $1 WHERE id = $2', [telefonoMecanicoDos, datos.mecanicoDosId]);
    }

    before(async () => {
        if (!HABILITADO) return;
        inicio = new Date(Date.now() - 2000);
        const r = await pool.query(
            "SELECT id, email, telefono_whatsapp FROM usuarios WHERE id = ANY($1) OR email = 'admin@gomaq.test'",
            [[datos.mecanicoId, datos.mecanicoDosId]]);
        respaldo = r.rows;
    });

    after(async () => {
        if (!HABILITADO || !respaldo) return;
        for (const u of respaldo) {
            await pool.query('UPDATE usuarios SET telefono_whatsapp = $1 WHERE id = $2', [u.telefono_whatsapp, u.id]);
        }
        await pool.query(
            `DELETE FROM notificaciones_pendientes WHERE created_at >= $1 AND payload->>'tipo' = ANY($2)`, [inicio, SIN_PROVEEDOR]);
    });

    test('asignar y reasignar no encolan avisos (con WhatsApp ni con correo)', async (t) => {
        if (!requiereBase(t)) return;
        await contactos(MARCA.telefono, MARCA.telefonoDos);
        const ot = await crearOt('asignada', null);
        const asignar = (mecanicoId) => pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: mecanicoId });
        assert.equal((await asignar(datos.mecanicoId)).status, 200);
        assert.equal((await asignar(datos.mecanicoId)).status, 200, 'doble clic');
        assert.equal((await asignar(datos.mecanicoDosId)).status, 200, 'reasignacion');
        await contactos(null, null);
        assert.equal((await asignar(datos.mecanicoId)).status, 200, 'sin WhatsApp');
        assert.equal((await avisos('ot_asignada', ot)).length, 0);
        assert.equal((await avisos('ot_reasignada', ot)).length, 0);
        assert.equal((await avisos('mecanico_asignado', ot)).length, 0);
    });

    test('a un mecanico inactivo no se le asigna ni se le avisa', async (t) => {
        if (!requiereBase(t)) return;
        await contactos(MARCA.telefono, MARCA.telefonoDos);
        const ot = await crearOt('asignada', null);
        try {
            await pool.query("UPDATE usuarios SET estado_cuenta = 'rechazado' WHERE id = $1", [datos.mecanicoId]);
            const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId });
            assert.equal(r.status, 400);
            assert.equal((await avisos('ot_asignada', ot)).length, 0);
        } finally {
            await pool.query("UPDATE usuarios SET estado_cuenta = 'activo' WHERE id = $1", [datos.mecanicoId]);
        }
    });

    test('cerrar una OT no encola avisos, con o sin repuestos facturables; el reintento tampoco', async (t) => {
        if (!requiereBase(t)) return;
        await pool.query("UPDATE usuarios SET telefono_whatsapp = '+56933330000' WHERE email = 'admin@gomaq.test'");
        const ot = await crearOt('en_reparacion');
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        const uuid = crypto.randomUUID();
        const cerrar = () => pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { uuid, uuid_cliente: uuid, observacion_final: 'listo' });
        assert.equal((await cerrar()).status, 200);
        assert.equal((await cerrar()).status, 200, 'reintento');
        const sinRepuestos = await crearOt('en_reparacion');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${sinRepuestos}/finalizar`, 'mecanico', { observacion_final: 'sin repuestos' })).status, 200);
        for (const orden of [ot, sinRepuestos]) {
            assert.equal((await avisos('ot_por_valorizar', orden)).length, 0);
            assert.equal((await avisos('ot_finalizada', orden)).length, 0);
        }
    });

    test('cambiar las lineas de una OT valorizada y agregar una linea tardia no encolan avisos', async (t) => {
        if (!requiereBase(t)) return;
        await pool.query("UPDATE usuarios SET telefono_whatsapp = '+56933330000' WHERE email = 'admin@gomaq.test'");
        const { ot, a } = await otValorizada();
        const r = await pedir('PATCH', rutaLinea(ot, a), 'administrativo', { precio_unitario: 7777, ...MOTIVO_VALIDO });
        assert.equal(r.status, 200);
        assert.equal((await pedir('PATCH', rutaLinea(ot, a), 'administrativo', { precio_unitario: 8888, ...MOTIVO_VALIDO })).status, 200);
        const tardia = await crearOt();
        await cerrarOt(tardia, null);
        const nueva = await pedir('POST', `/api/insumos/orden/${tardia}`, 'administrativo',
            { cantidad: 1, descripcion: 'Repuesto tardio', precio_unitario: 1000, facturable: 'si', ...MOTIVO_VALIDO });
        assert.equal(nueva.status, 201);
        assert.equal((await avisos('ot_por_valorizar', ot)).length, 0);
        assert.equal((await avisos('ot_por_valorizar', tardia)).length, 0);
    });

    test('anular una factura no encola avisos; repetir con la misma Idempotency-Key tampoco', async (t) => {
        if (!requiereBase(t)) return;
        await pool.query("UPDATE usuarios SET telefono_whatsapp = '+56933330000' WHERE email = 'admin@gomaq.test'");
        const ot = await crearOt();
        await facturarDirecto(ot, 'T-5301');
        const factura = (await pool.query('SELECT id FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows[0];
        const llave = crypto.randomUUID();
        const anular = () => pedir('POST', `/api/ordenes-trabajo/${ot}/factura/${factura.id}/anular`, 'administrativo',
            { ...MOTIVO_VALIDO }, { 'Idempotency-Key': llave });
        assert.equal((await anular()).status, 200);
        assert.equal((await anular()).status, 200, 'repeticion');
        assert.equal((await avisos('factura_anulada', ot)).length, 0);
    });

    test('un conteo por perdida o merma no encola avisos', async (t) => {
        if (!requiereBase(t)) return;
        const ubic = await pool.query("INSERT INTO ubicaciones_stock (nombre, tipo) VALUES ('Aviso prueba 5C', 'bodega') RETURNING id");
        datos.ubicaciones.push(ubic.rows[0].id);
        const insumo = await pool.query("INSERT INTO insumos (nombre, unidad_medida) VALUES ('Insumo aviso 5C', 'un') RETURNING id");
        datos.insumos.push(insumo.rows[0].id);
        await pool.query('INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad) VALUES ($1, $2, 10)', [ubic.rows[0].id, insumo.rows[0].id]);
        const contar = (contada, esperada, motivo) => pedir('POST', '/api/insumos/ajuste', 'administrativo', {
            ubicacion_id: ubic.rows[0].id, insumo_id: insumo.rows[0].id, cantidad_contada: contada, cantidad_esperada: esperada,
            motivo_codigo: motivo, uuid_cliente: crypto.randomUUID(),
        });
        assert.equal((await contar(8, 10, 'diferencia_conteo')).status, 201);
        assert.equal((await contar(5, 8, 'perdida_robo')).status, 201);
        assert.equal((await contar(3, 5, 'danio_merma')).status, 201);
        assert.equal((await avisos('ajuste_inventario')).filter((x) => x.payload.insumo_nombre === 'Insumo aviso 5C').length, 0);
    });

    test('el contador de notificaciones en error del dashboard no cuenta los avisos internos', async (t) => {
        if (!requiereBase(t)) return;
        const { TIPOS_INTERNOS } = require('../src/utils/avisos');
        assert.deepEqual([...TIPOS_INTERNOS].sort(), [...TIPOS].sort());
        const cuenta = async () => Number((await pool.query(
            `SELECT COUNT(*) AS n FROM notificaciones_pendientes WHERE estado = 'error' AND COALESCE(payload->>'tipo', '') <> ALL($1::text[])`,
            [TIPOS_INTERNOS])).rows[0].n);
        const antes = await cuenta();
        const interno = await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload, estado, intentos)
             VALUES ('email', 'x@gomaq.test', '{"tipo":"ot_asignada"}', 'error', 5) RETURNING id`);
        const cliente = await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload, estado, intentos)
             VALUES ('email', 'y@gomaq.test', '{"tipo":"ot_finalizada"}', 'error', 5) RETURNING id`);
        try {
            assert.equal(await cuenta(), antes + 1, 'solo el aviso al cliente cuenta');
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = ANY($1)', [[interno.rows[0].id, cliente.rows[0].id]]);
        }
    });

    test('ninguna accion de este bloque dejo filas de avisos sin proveedor', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pool.query(
            `SELECT payload->>'tipo' AS tipo FROM notificaciones_pendientes WHERE created_at >= $1 AND payload->>'tipo' = ANY($2)`,
            [inicio, SIN_PROVEEDOR]);
        assert.deepEqual(r.rows, []);
    });
});

describe('contratos para el dashboard, Ordenes y el portal', () => {
    const tokenCliente = tokenClienteDe(987655);
    // el dashboard guarda los arriendos 30 s: las pruebas, que acaban de crear datos, lo vacian antes de leer
    const pendientes = async (rol = 'administrativo') => {
        require('../src/routes/dashboard').vaciarCacheArriendos();
        return pedir('GET', '/api/dashboard/pendientes', rol);
    };
    const total = async (ruta) => {
        const r = await pedir('GET', `${ruta}${ruta.includes('?') ? '&' : '?'}limit=1`, 'administrativo');
        assert.equal(r.status, 200, `${ruta} -> ${r.status}`);
        return r.body.total;
    };
    const otSinAsignar = async () => {
        const r = await pool.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo)
             SELECT id, cliente_id, 'pendiente', 'OT sin asignar de prueba' FROM maquinarias WHERE id = $1 RETURNING id`,
            [datos.maquinariaId]);
        datos.ordenes.push(r.rows[0].id);
        return r.rows[0].id;
    };

    test('GET /dashboard/pendientes: solo administrativo y gerente, con todos los numeros', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await pedir('GET', '/api/dashboard/pendientes', 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/dashboard/pendientes', 'cliente')).status, 403);
        const g = await pendientes('gerente');
        assert.equal(g.status, 200);
        const a = await pendientes('administrativo');
        assert.equal(a.status, 200);
        const claves = ['mantencion_vencida', 'mantencion_proxima', 'ot_sin_asignar', 'asistencias_por_atender', 'avisos_con_problemas',
            'por_facturar', 'arriendos_con_aviso', 'ot_por_valorizar', 'guias_sin_documento', 'descuadres', 'cuentas_por_aprobar'];
        for (const c of claves) {
            assert.ok(Number.isInteger(a.body[c]) && a.body[c] >= 0, `${c} debe ser un entero >= 0: ${a.body[c]}`);
        }
        assert.ok(!Number.isNaN(Date.parse(a.body.generado_en)));
    });

    test('cada numero de /dashboard/pendientes es el de la lista a la que lleva', async (t) => {
        if (!requiereBase(t)) return;
        // algo en cada lista, para que la igualdad no sea 0 = 0
        const equipo = await crearEquipo(null);
        const cliente = await algunCliente();
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-01-02T09:00:00-03:00', $2)`, [equipo.id, cliente]);
        const cerrado = await crearEquipo(null);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-01-02T09:00:00-03:00', $2)`, [cerrado.id, cliente]);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'recepcion', 'x', '2026-01-20T10:00:00-03:00', $2)`, [cerrado.id, cliente]);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', NULL, now(), $2)`, [(await crearEquipo(null)).id, cliente]);
        await otSinAsignar();
        const valorizar = await crearOt();
        await agregarLinea(valorizar, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(valorizar, null);
        const lista = await crearOt();
        await agregarLinea(lista, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(lista, 1000);

        const p = (await pendientes()).body;
        assert.ok(p.ot_sin_asignar >= 1 && p.por_facturar >= 2 && p.arriendos_con_aviso >= 1 && p.ot_por_valorizar >= 1);

        assert.equal(p.ot_sin_asignar, await total('/api/ordenes-trabajo?sin_asignar=1'));
        const fact = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body;
        assert.equal(p.por_facturar, fact.arriendos.length + fact.reparaciones_listas.length);
        assert.equal(p.ot_por_valorizar, fact.reparaciones_pendientes_valorizar.length);
        const enCurso = (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'administrativo')).body.arriendos;
        assert.equal(p.arriendos_con_aviso, enCurso.filter((x) => x.aviso === true).length);
        const alertas = (await pedir('GET', '/api/horometro/alertas', 'administrativo')).body.equipos;
        assert.equal(p.mantencion_vencida, alertas.filter((e) => e.vencida).length);
        assert.equal(p.mantencion_proxima, alertas.filter((e) => e.por_vencer && !e.vencida).length);
        const descuadres = (await pedir('GET', '/api/insumos/descuadres', 'administrativo')).body;
        assert.equal(p.descuadres, descuadres.length);
        const problemas = (await pedir('GET', '/api/notificaciones?problemas=1', 'administrativo')).body;
        assert.equal(p.avisos_con_problemas, problemas.total, 'el total de la lista es el numero del dashboard (sin el tope de 200)');
        assert.ok(problemas.items.length <= 200);
        // la lista real de cada pendiente simple, no el SQL del contador
        const solicitudes = await pedir('GET', '/api/solicitudes?estado=pendiente', 'administrativo');
        assert.equal(p.asistencias_por_atender, solicitudes.body.length);
        const guiasSin = await pedir('GET', '/api/maquinarias/guias/recientes?sin_documento=1', 'administrativo');
        assert.equal(p.guias_sin_documento, guiasSin.body.length);
        const cuentas = await pedir('GET', '/api/usuarios/solicitudes', 'administrativo');
        assert.equal(p.cuentas_por_aprobar, cuentas.body.length);
        // /resumen conserva sus atajos
        const resumen = (await pedir('GET', '/api/dashboard/resumen', 'administrativo')).body;
        assert.ok('pendientes_facturar' in resumen.atajos && 'notificaciones_error' in resumen.atajos);
    });

    test('sin asignar: sube al crear una OT sin mecanico y baja al asignarla', async (t) => {
        if (!requiereBase(t)) return;
        const antes = (await pendientes()).body.ot_sin_asignar;
        const ot = await otSinAsignar();
        assert.equal((await pendientes()).body.ot_sin_asignar, antes + 1);
        const lista = await pedir('GET', '/api/ordenes-trabajo?sin_asignar=1&limit=200', 'gerente');
        assert.ok(lista.body.items.some((o) => o.id === ot), 'la OT esta en la lista Sin asignar');
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId })).status, 200);
        assert.equal((await pendientes()).body.ot_sin_asignar, antes);
        const despues = await pedir('GET', '/api/ordenes-trabajo?sin_asignar=1&limit=200', 'gerente');
        assert.ok(!despues.body.items.some((o) => o.id === ot));
    });

    test('GET /ordenes-trabajo/resumen: permisos y conteos iguales a las listas', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await pedir('GET', '/api/ordenes-trabajo/resumen', 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/ordenes-trabajo/resumen', 'cliente')).status, 403);
        await otSinAsignar();
        await crearOt('en_terreno');
        await crearOt('asignada');
        const cerrada = await crearOt();
        await cerrarOt(cerrada, null);
        for (const rol of ['administrativo', 'gerente']) {
            const r = await pedir('GET', '/api/ordenes-trabajo/resumen', rol);
            assert.equal(r.status, 200, rol);
            assert.equal(r.body.todas, await total('/api/ordenes-trabajo'));
            assert.equal(r.body.sin_asignar, await total('/api/ordenes-trabajo?sin_asignar=1'));
            assert.equal(r.body.en_curso, await total('/api/ordenes-trabajo?estado=asignada,aceptada,en_camino,en_terreno,en_reparacion'));
            assert.equal(r.body.finalizadas, await total('/api/ordenes-trabajo?estado=finalizada'));
            assert.equal(r.body.por_estado.finalizada, r.body.finalizadas);
            assert.ok(r.body.sin_asignar >= 1 && r.body.en_curso >= 2 && r.body.finalizadas >= 1);
        }
    });

    test('GET /ordenes-trabajo: lista de estados, 400 si es desconocido, orden y nombre del mecanico', async (t) => {
        if (!requiereBase(t)) return;
        const abierta = await crearOt('en_terreno');
        const sin = await otSinAsignar();
        const dosEstados = await pedir('GET', '/api/ordenes-trabajo?estado=pendiente,en_terreno&limit=200', 'administrativo');
        assert.equal(dosEstados.status, 200);
        assert.ok(dosEstados.body.items.every((o) => ['pendiente', 'en_terreno'].includes(o.estado)));
        assert.ok(dosEstados.body.items.some((o) => o.id === abierta) && dosEstados.body.items.some((o) => o.id === sin));
        for (const malo of ['inventado', 'en_terreno,inventado', 'en_terreno,']) {
            assert.equal((await pedir('GET', `/api/ordenes-trabajo?estado=${malo}`, 'administrativo')).status, 400, malo);
        }
        const conMecanico = dosEstados.body.items.find((o) => o.id === abierta);
        assert.ok(conMecanico.mecanico_nombre, 'trae el nombre del mecanico');
        assert.equal(dosEstados.body.items.find((o) => o.id === sin).mecanico_nombre, null);
        const asc = (await pedir('GET', '/api/ordenes-trabajo?dir=asc&limit=200', 'administrativo')).body.items;
        const desc = (await pedir('GET', '/api/ordenes-trabajo?limit=200', 'administrativo')).body.items;
        const fechas = (lista) => lista.map((o) => new Date(o.fecha_creacion).getTime());
        assert.deepEqual(fechas(asc), [...fechas(asc)].sort((x, y) => x - y), 'ascendente');
        assert.deepEqual(fechas(desc), [...fechas(desc)].sort((x, y) => y - x), 'descendente por defecto');
        // la rama del mecanico no cambia: solo ve las suyas
        const mias = await pedir('GET', '/api/ordenes-trabajo?limit=200', 'mecanico');
        assert.ok(mias.body.items.every((o) => o.mecanico_id === datos.mecanicoId));
        const disponibles = await pedir('GET', '/api/ordenes-trabajo?sin_asignar=1&limit=200', 'mecanico');
        assert.ok(disponibles.body.items.some((o) => o.id === sin), 'el mecanico ve las sin asignar para tomarlas');
    });

    test('GET /notificaciones?problemas=1 lista lo que cuenta el dashboard y no los avisos internos en error', async (t) => {
        if (!requiereBase(t)) return;
        const interno = await pool.query(`INSERT INTO notificaciones_pendientes (canal, destinatario, payload, estado, intentos) VALUES ('email', 'x@gomaq.test', '{"tipo":"ot_asignada"}', 'error', 5) RETURNING id`);
        const cliente = await pool.query(`INSERT INTO notificaciones_pendientes (canal, destinatario, payload, estado, intentos) VALUES ('email', 'y@gomaq.test', '{"tipo":"ot_finalizada"}', 'error', 5) RETURNING id`);
        try {
            assert.equal((await pedir('GET', '/api/notificaciones?problemas=1', 'mecanico')).status, 403);
            const r = await pedir('GET', '/api/notificaciones?problemas=1', 'administrativo');
            assert.equal(r.status, 200);
            const ids = r.body.items.map((x) => x.id);
            assert.ok(ids.includes(cliente.rows[0].id), 'el aviso al cliente en error aparece');
            assert.ok(!ids.includes(interno.rows[0].id), 'el interno no');
            assert.ok(r.body.items.length <= 200 && r.body.total >= r.body.items.length);
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = ANY($1)', [[interno.rows[0].id, cliente.rows[0].id]]);
        }
    });

    test('un aviso pendiente con error y mas de 10 min cuenta como problema; sin error, reciente u otro estado no', async (t) => {
        if (!requiereBase(t)) return;
        const total = async () => (await pedir('GET', '/api/notificaciones?problemas=1', 'administrativo')).body.total;
        const pendientes = async () => (await pedir('GET', '/api/dashboard/pendientes', 'administrativo')).body.avisos_con_problemas;
        const antes = await total();
        assert.equal(await pendientes(), antes);
        const ids = [];
        const insertar = async (canal, tipo, estado, error, minutos, intentos = 0) => {
            // proximo_intento en el futuro: la fila no es "atrasada", solo el error la hace contar
            const r = await pool.query(
                `INSERT INTO notificaciones_pendientes (canal, destinatario, payload, estado, intentos, ultimo_error, created_at, proximo_intento)
                 VALUES ($1, 'z@gomaq.test', $2, $3, $4, $5, now() - ($6 || ' minutes')::interval, now() + interval '1 hour') RETURNING id`,
                [canal, JSON.stringify({ tipo }), estado, intentos, error, String(minutos)]);
            ids.push(r.rows[0].id);
            return r.rows[0].id;
        };
        try {
            const cuenta = await insertar('push', 'ot_asignada', 'pendiente', 'Credencial de FCM rechazada', 30);
            await insertar('push', 'ot_asignada', 'pendiente', null, 30);
            await insertar('push', 'ot_asignada', 'pendiente', 'Credencial de FCM rechazada', 2);
            await insertar('push', 'ot_asignada', 'cancelado', 'El aviso tiene mas de 6 horas', 30);
            await insertar('push', 'ot_asignada', 'enviado', 'nota', 30);
            await insertar('push', 'ot_asignada', 'error', 'token muerto', 30, 5);
            assert.equal(await total(), antes + 1, 'solo el pendiente viejo con error suma');
            assert.equal(await pendientes(), antes + 1, 'el numero del dashboard es el de la lista');
            const lista = (await pedir('GET', '/api/notificaciones?problemas=1', 'administrativo')).body.items;
            const fila = lista.find((x) => x.id === cuenta);
            assert.ok(fila, 'aparece en la lista de problemas');
            assert.equal(fila.ultimo_error, 'Credencial de FCM rechazada', 'la pantalla recibe el motivo');
            const resumen = (await pedir('GET', '/api/dashboard/resumen', 'administrativo')).body;
            assert.ok(Number.isInteger(resumen.atajos.notificaciones_pendientes_con_error) && resumen.atajos.notificaciones_pendientes_con_error >= 1);
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = ANY($1)', [ids]);
        }
    });

    describe('portal: GET /ordenes-trabajo/mias', () => {
        async function conVehiculo(usar) {
            const existente = await pool.query('SELECT id FROM vehiculos WHERE usuario_id = $1', [datos.mecanicoId]);
            let creado = null;
            if (existente.rows.length === 0) {
                creado = (await pool.query(
                    `INSERT INTO vehiculos (patente, marca, modelo, usuario_id) VALUES ($1, 'Ford', 'Transit', $2) RETURNING id, patente`,
                    [`T${crypto.randomUUID().slice(0, 6).toUpperCase()}`, datos.mecanicoId])).rows[0];
            }
            try {
                await pool.query('UPDATE vehiculos SET activo = true WHERE usuario_id = $1', [datos.mecanicoId]);
                const v = (await pool.query('SELECT patente, marca, modelo FROM vehiculos WHERE usuario_id = $1', [datos.mecanicoId])).rows[0];
                await usar(v);
            } finally {
                if (creado) await pool.query('DELETE FROM vehiculos WHERE id = $1', [creado.id]);
            }
        }

        test('una OT abierta trae las horas de cada paso, el tecnico y su vehiculo; sin RUT ni datos internos', async (t) => {
            if (!requiereBase(t)) return;
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            const ot = (await pool.query(
                `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo, aceptada_at, en_camino_at, llegada_at)
                 VALUES ($1, $2, $3, 'en_terreno', 'OT del portal', '2026-03-02T10:00:00Z', '2026-03-02T10:30:00Z', '2026-03-02T11:15:00Z') RETURNING id`,
                [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
            datos.ordenes.push(ot);
            // el evento mas antiguo no se aplico (llego atrasado): no cuenta como la asignacion
            await pool.query(
                `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen, aplicado)
                 VALUES ($1, 'asignacion', '2026-03-02T09:45:00Z', 'panel', true), ($1, 'asignacion', '2026-03-01T00:00:00Z', 'panel', false)`, [ot]);
            await conVehiculo(async (v) => {
                const r = await pedirConToken('/api/ordenes-trabajo/mias', tokenCliente(cliente));
                assert.equal(r.status, 200);
                const o = r.body.find((x) => x.id === ot);
                assert.ok(o, 'la OT esta en el historial');
                assert.equal(new Date(o.aceptada_at).toISOString(), '2026-03-02T10:00:00.000Z');
                assert.equal(new Date(o.en_camino_at).toISOString(), '2026-03-02T10:30:00.000Z');
                assert.equal(new Date(o.llegada_at).toISOString(), '2026-03-02T11:15:00.000Z');
                assert.equal(new Date(o.asignada_at).toISOString(), '2026-03-02T09:45:00.000Z', 'la asignacion aplicada, no el evento atrasado');
                assert.equal(o.vehiculo_patente, v.patente);
                assert.equal(o.vehiculo_marca, v.marca);
                assert.equal(o.vehiculo_modelo, v.modelo);
                assert.ok(o.mecanico_nombre);
                assert.equal(o.cobro, null, 'abierta: sin mensaje de cobro');
                afirmarClavesPortal(o);
            });
        });

        test('una OT en camino trae la hora estimada de llegada y nunca coordenadas', async (t) => {
            if (!requiereBase(t)) return;
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            const ot = (await pool.query(
                `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo,
                        destino_lat, destino_lng, destino_origen,
                        eta_segundos, eta_distancia_m, eta_calculada_at, eta_fuente, eta_origen_lat, eta_origen_lng, eta_consultas)
                 VALUES ($1, $2, $3, 'en_camino', 'OT con ETA', -38.7359, -72.5904, 'cliente',
                         600, 5000, '2026-03-02T10:00:00Z', 'aproximada', -38.70, -72.50, 3) RETURNING id`,
                [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
            datos.ordenes.push(ot);

            const r = await pedirConToken('/api/ordenes-trabajo/mias', tokenCliente(cliente));
            assert.equal(r.status, 200);
            const o = r.body.find((x) => x.id === ot);
            assert.ok(o, 'la OT esta en el historial');
            assert.equal(new Date(o.eta_llegada_at).toISOString(), '2026-03-02T10:10:00.000Z', 'calculada_at + segundos');
            assert.equal(new Date(o.eta_calculada_at).toISOString(), '2026-03-02T10:00:00.000Z');
            assert.equal(o.eta_aproximada, true);
            afirmarClavesPortal(o);

            // al llegar, la hora estimada deja de mostrarse al cliente
            await pool.query(`UPDATE ordenes_trabajo SET estado = 'en_terreno' WHERE id = $1`, [ot]);
            const despues = (await pedirConToken('/api/ordenes-trabajo/mias', tokenCliente(cliente))).body.find((x) => x.id === ot);
            assert.equal(despues.eta_llegada_at, null);
            assert.equal(despues.eta_aproximada, null);
        });

        test('ETA por rutas: el cupo diario se respeta aunque lleguen reservas simultaneas', async (t) => {
            if (!requiereBase(t)) return;
            const { reservarConsulta } = require('../src/services/rutasEta');
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            await pool.query('DELETE FROM uso_ors');
            const ids = [];
            for (let i = 0; i < 8; i++) {
                const ot = (await pool.query(
                    `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo)
                     VALUES ($1, $2, $3, 'en_camino', 'cupo ors') RETURNING id`, [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
                datos.ordenes.push(ot);
                ids.push(ot);
            }
            const r = await Promise.all(ids.map((id) => reservarConsulta(pool, id, { maxPorOt: 15, cupoDiario: 3 })));
            assert.equal(r.filter((x) => x.ok).length, 3, 'solo pasan las que caben en el cupo');
            assert.ok(r.filter((x) => !x.ok).every((x) => x.motivo === 'cupo_diario'));
            assert.equal((await pool.query('SELECT consultas FROM uso_ors')).rows[0].consultas, 3);
            // las rechazadas devuelven su reserva: no queda gastada una consulta que no se hizo
            const gastadas = (await pool.query('SELECT count(*)::int AS c FROM ordenes_trabajo WHERE id = ANY($1) AND eta_consultas > 0', [ids])).rows[0].c;
            assert.equal(gastadas, 3);
            await pool.query('DELETE FROM uso_ors');
        });

        test('ETA por rutas: guarda la ruta, no la pisa con la aproximada y si el servicio falla conserva la aproximada', async (t) => {
            if (!requiereBase(t)) return;
            const { mejorarEtaConRutas } = require('../src/services/rutasEta');
            const { guardarPosicion } = require('../src/utils/posicionMecanico');
            const { ErrorOrs } = require('../src/services/ors');
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            await pool.query('DELETE FROM uso_ors');
            const nuevaOt = async () => {
                const ot = (await pool.query(
                    `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo, destino_lat, destino_lng, destino_origen)
                     VALUES ($1, $2, $3, 'en_camino', 'ruta', -38.7359, -72.5904, 'cliente') RETURNING id`,
                    [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
                datos.ordenes.push(ot);
                return ot;
            };
            const leer = async (id) => (await pool.query('SELECT eta_fuente, eta_segundos, eta_consultas FROM ordenes_trabajo WHERE id = $1', [id])).rows[0];
            const origen = { latitud: -38.70, longitud: -72.50 };
            const silencio = { warn() {}, error() {} };
            const opciones = (llamar) => ({ llamar, hayLlave: () => true, log: silencio });

            // con ruta: queda la ETA del servicio, y una posicion nueva no la reemplaza por la aproximada
            const conRuta = await nuevaOt();
            const r = await mejorarEtaConRutas(pool, { ordenId: conRuta, usuarioId: datos.mecanicoId, origen },
                opciones(async () => ({ distancia_m: 5000, segundos: 600 })));
            assert.equal(r.guardada, true);
            assert.deepEqual(await leer(conRuta), { eta_fuente: 'ors', eta_segundos: 600, eta_consultas: 1 });
            await guardarPosicion(pool, { ordenId: conRuta, usuarioId: datos.mecanicoId, posicion: { ...origen, capturada_en: new Date().toISOString() } });
            assert.equal((await leer(conRuta)).eta_fuente, 'ors', 'la aproximada no pisa a la ruta real');

            // el servicio falla: no lanza, conserva la aproximada y la consulta cuenta
            const conFallo = await nuevaOt();
            await guardarPosicion(pool, { ordenId: conFallo, usuarioId: datos.mecanicoId, posicion: { ...origen, capturada_en: new Date().toISOString() } });
            const aprox = await leer(conFallo);
            assert.equal(aprox.eta_fuente, 'aproximada');
            const f = await mejorarEtaConRutas(pool, { ordenId: conFallo, usuarioId: datos.mecanicoId, origen },
                opciones(async () => { throw new ErrorOrs('timeout', 'sin respuesta'); }));
            assert.equal(f.motivo, 'ors_fallo');
            assert.deepEqual(await leer(conFallo), { ...aprox, eta_consultas: 1 });

            // sin llave no se llama a nadie ni se gasta cupo
            const sinLlave = await nuevaOt();
            const s = await mejorarEtaConRutas(pool, { ordenId: sinLlave, usuarioId: datos.mecanicoId, origen },
                { llamar: async () => assert.fail('no debia llamar'), hayLlave: () => false, log: silencio });
            assert.equal(s.motivo, 'sin_llave');
            assert.equal((await leer(sinLlave)).eta_consultas, 0);
            await pool.query('DELETE FROM uso_ors');
        });

        test('cuentas internas: crear desde el panel, iniciar sesion, y una cuenta desactivada pierde la sesion al instante', async (t) => {
            if (!requiereBase(t)) return;
            const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
            const correo = `qa.cuentas.${sufijo}@gomaq.test`;
            const creados = [];
            try {
                // el administrativo crea mecanicos y administrativos; solo un gerente crea otro gerente
                assert.equal((await pedir('POST', '/api/usuarios', 'administrativo', {
                    nombre: 'QA gerente', email: `qa.gerente.no.${sufijo}@gomaq.test`, rol: 'gerente', password: 'clave-de-prueba-1',
                })).status, 403);
                for (const rol of ['mecanico', 'administrativo', 'gerente']) {
                    const r = await pedir('POST', '/api/usuarios', rol === 'gerente' ? 'gerente' : 'administrativo', {
                        nombre: `QA ${rol}`,
                        email: rol === 'mecanico' ? correo.toUpperCase() : `qa.${rol}.${sufijo}@gomaq.test`,
                        rol,
                        password: 'clave-de-prueba-1',
                    });
                    assert.equal(r.status, 201, `${rol}: ${JSON.stringify(r.body)}`);
                    assert.equal(r.body.rol, rol);
                    assert.equal(r.body.estado_cuenta, 'activo');
                    assert.ok(!('password_hash' in r.body) && !('password' in r.body), 'nunca devuelve la clave');
                    creados.push(r.body.id);
                }
                const mecanicoNuevo = creados[0];
                // el correo se guardo en minusculas aunque se escribio en mayusculas
                assert.equal((await pool.query('SELECT email FROM usuarios WHERE id = $1', [mecanicoNuevo])).rows[0].email, correo);
                // repetir el correo (con otras mayusculas) es 409
                assert.equal((await pedir('POST', '/api/usuarios', 'gerente', { nombre: 'Otra', email: correo.replace('qa', 'QA'), rol: 'mecanico', password: 'clave-de-prueba-1' })).status, 409);
                // cliente y clave corta no se crean por esta ruta
                assert.equal((await pedir('POST', '/api/usuarios', 'administrativo', { nombre: 'Cli', email: `cli.${sufijo}@gomaq.test`, rol: 'cliente', password: 'clave-de-prueba-1' })).status, 400);
                assert.equal((await pedir('POST', '/api/usuarios', 'administrativo', { nombre: 'Corta', email: `corta.${sufijo}@gomaq.test`, rol: 'mecanico', password: '1234' })).status, 400);
                // el mecanico no puede crear cuentas ni desactivarlas
                assert.equal((await pedir('POST', '/api/usuarios', 'mecanico', { nombre: 'X', email: `x.${sufijo}@gomaq.test`, rol: 'gerente', password: 'clave-de-prueba-1' })).status, 403);
                assert.equal((await pedir('PATCH', `/api/usuarios/${mecanicoNuevo}/estado`, 'mecanico', { activo: false })).status, 403);

                // inicia sesion con el correo escrito de cualquier forma
                const login = await fetch(`${entorno.base}/api/auth/login`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: correo.toUpperCase(), password: 'clave-de-prueba-1' }),
                });
                assert.equal(login.status, 200);
                let { token } = await login.json();
                const conToken = (ruta) => fetch(`${entorno.base}${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
                assert.equal((await conToken('/api/ordenes-trabajo?limit=1')).status, 200, 'la sesion nueva funciona');

                // no se desactiva a si mismo
                const yo = (await pool.query(`SELECT id FROM usuarios WHERE email = 'administrativo@gomaq.test'`)).rows[0].id;
                assert.equal((await pedir('PATCH', `/api/usuarios/${yo}/estado`, 'administrativo', { activo: false })).status, 409);
                // activo debe ser booleano
                assert.equal((await pedir('PATCH', `/api/usuarios/${mecanicoNuevo}/estado`, 'administrativo', { activo: 'false' })).status, 400);

                // desactivada: el token que ya tenia deja de valer en la siguiente peticion, y no puede volver a entrar
                const baja = await pedir('PATCH', `/api/usuarios/${mecanicoNuevo}/estado`, 'administrativo', { activo: false });
                assert.equal(baja.status, 200);
                assert.equal(baja.body.estado_cuenta, 'rechazado');
                assert.equal((await conToken('/api/ordenes-trabajo?limit=1')).status, 401, 'la sesion vigente se corta');
                const relogin = await fetch(`${entorno.base}/api/auth/login`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: correo, password: 'clave-de-prueba-1' }),
                });
                assert.equal(relogin.status, 403);

                // reactivada: la sesion que tenia no revive (se cerro al desactivarla); entrando de nuevo, si
                assert.equal((await pedir('PATCH', `/api/usuarios/${mecanicoNuevo}/estado`, 'gerente', { activo: true })).status, 200);
                assert.equal((await conToken('/api/ordenes-trabajo?limit=1')).status, 401, 'reactivar no revive la sesion anterior');
                const reentrada = await fetch(`${entorno.base}/api/auth/login`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: correo, password: 'clave-de-prueba-1' }),
                });
                assert.equal(reentrada.status, 200);
                token = (await reentrada.json()).token;
                assert.equal((await conToken('/api/ordenes-trabajo?limit=1')).status, 200);

                // un cambio de rol rige de inmediato: el token sigue diciendo mecanico pero ahora es cliente
                await pool.query(`UPDATE usuarios SET rol = 'cliente' WHERE id = $1`, [mecanicoNuevo]);
                assert.equal((await conToken('/api/ordenes-trabajo?limit=1')).status, 403, 'manda el rol de la base, no el del token');

                // una cuenta de cliente no se desactiva por esta ruta (va por Solicitudes)
                assert.equal((await pedir('PATCH', `/api/usuarios/${mecanicoNuevo}/estado`, 'administrativo', { activo: false })).status, 404);

                // el listado trae el estado de cada cuenta
                const lista = await pedir('GET', '/api/usuarios', 'gerente');
                assert.ok(lista.body.every((u) => 'estado_cuenta' in u));
            } finally {
                if (creados.length) await pool.query('DELETE FROM usuarios WHERE id = ANY($1)', [creados]);
            }
        });

        test('restablecer la contraseña de otra cuenta: la clave nueva entra, la vieja no, y la sesion abierta se corta', async (t) => {
            if (!requiereBase(t)) return;
            const sufijo = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
            const correo = `qa.clave.${sufijo}@gomaq.test`;
            const creada = await pedir('POST', '/api/usuarios', 'administrativo', {
                nombre: 'QA clave', email: correo, rol: 'mecanico', password: 'clave-original-1',
            });
            assert.equal(creada.status, 201);
            const id = creada.body.id;
            const entrar = (password) => fetch(`${entorno.base}/api/auth/login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: correo, password }),
            });
            try {
                const sesion = await (await entrar('clave-original-1')).json();
                const conToken = (token) => fetch(`${entorno.base}/api/ordenes-trabajo?limit=1`, { headers: { Authorization: `Bearer ${token}` } });
                assert.equal((await conToken(sesion.token)).status, 200);

                // el mecanico no restablece claves; una clave corta o mal tipada se rechaza
                assert.equal((await pedir('POST', `/api/usuarios/${id}/password`, 'mecanico', { password: 'otra-clave-nueva' })).status, 403);
                assert.equal((await pedir('POST', `/api/usuarios/${id}/password`, 'administrativo', { password: '123' })).status, 400);
                assert.equal((await pedir('POST', `/api/usuarios/${id}/password`, 'administrativo', { password: 12345678 })).status, 400);
                assert.equal((await conToken(sesion.token)).status, 200, 'un intento rechazado no corta la sesion');

                // sin esperas: el corte no depende de la hora en segundos del token (claim pc, en milisegundos)
                const cambio = await pedir('POST', `/api/usuarios/${id}/password`, 'gerente', { password: 'clave-restablecida-2' });
                assert.equal(cambio.status, 200);
                assert.ok(!JSON.stringify(cambio.body).includes('clave-restablecida-2'), 'nunca devuelve la clave');
                assert.ok(!('password_hash' in cambio.body));

                assert.equal((await conToken(sesion.token)).status, 401, 'la sesion que ya tenia se corta');
                assert.equal((await entrar('clave-original-1')).status, 401, 'la clave vieja ya no sirve');
                const nueva = await entrar('clave-restablecida-2');
                assert.equal(nueva.status, 200, 'la clave nueva entra');
                assert.equal((await conToken((await nueva.json()).token)).status, 200, 'y su sesion funciona de inmediato');

                // las cuentas de cliente y las que no existen quedan fuera
                const cliente = (await pool.query(`SELECT id FROM usuarios WHERE rol = 'cliente' LIMIT 1`)).rows[0];
                if (cliente) assert.equal((await pedir('POST', `/api/usuarios/${cliente.id}/password`, 'administrativo', { password: 'clave-restablecida-2' })).status, 404);
                assert.equal((await pedir('POST', '/api/usuarios/99999999/password', 'administrativo', { password: 'clave-restablecida-2' })).status, 404);
            } finally {
                await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
            }
        });

        test('ETA ajustada y quieto desde: la hora de llegada sigue a la posicion, y un intento fallido espera', async (t) => {
            if (!requiereBase(t)) return;
            const { mejorarEtaConRutas } = require('../src/services/rutasEta');
            const { guardarPosicion } = require('../src/utils/posicionMecanico');
            const { ErrorOrs } = require('../src/services/ors');
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            await pool.query('DELETE FROM uso_ors');
            const ot = (await pool.query(
                `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo, destino_lat, destino_lng, destino_origen)
                 VALUES ($1, $2, $3, 'en_camino', 'eta ajustada', -38.7359, -72.5904, 'cliente') RETURNING id`,
                [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
            datos.ordenes.push(ot);
            const leerOt = async () => (await pool.query(
                `SELECT eta_segundos, eta_calculada_at, eta_fuente, eta_consultas, eta_intento_at,
                        eta_ajustada_llegada_at, eta_ajustada_at FROM ordenes_trabajo WHERE id = $1`, [ot])).rows[0];
            const silencio = { warn() {}, error() {} };
            const origen = { latitud: -38.70, longitud: -72.50 };
            const mitad = { latitud: -38.718, longitud: -72.545 };

            // 1) el servicio falla: el intento queda anotado y el siguiente espera (no gasta otra consulta)
            const falla = { llamar: async () => { throw new ErrorOrs('timeout', 'sin respuesta'); }, hayLlave: () => true, log: silencio };
            assert.equal((await mejorarEtaConRutas(pool, { ordenId: ot, usuarioId: datos.mecanicoId, origen }, falla)).motivo, 'ors_fallo');
            const tras = await mejorarEtaConRutas(pool, { ordenId: ot, usuarioId: datos.mecanicoId, origen }, falla);
            assert.equal(tras.consultada, false);
            assert.equal(tras.motivo, 'muy_reciente');
            assert.equal((await leerOt()).eta_consultas, 1);
            assert.ok((await leerOt()).eta_intento_at);

            // 2) pasado el minimo, una ruta buena se guarda y no hay ajuste todavia
            await pool.query(`UPDATE ordenes_trabajo SET eta_intento_at = now() - interval '10 minutes' WHERE id = $1`, [ot]);
            const buena = { llamar: async () => ({ distancia_m: 9000, segundos: 1200 }), hayLlave: () => true, log: silencio };
            assert.equal((await mejorarEtaConRutas(pool, { ordenId: ot, usuarioId: datos.mecanicoId, origen }, buena)).guardada, true);
            const conRuta = await leerOt();
            assert.equal(conRuta.eta_fuente, 'ors');
            assert.equal(conRuta.eta_ajustada_llegada_at, null);

            // 3) a mitad de camino quedan mas o menos la mitad de los segundos; eta_segundos y eta_calculada_at no cambian
            const hace2min = new Date(Date.now() - 120000);
            const hace1min = new Date(Date.now() - 60000);
            const ahora = new Date();
            await guardarPosicion(pool, { ordenId: ot, usuarioId: datos.mecanicoId, posicion: { ...origen, capturada_en: hace2min.toISOString() } });
            await guardarPosicion(pool, { ordenId: ot, usuarioId: datos.mecanicoId, posicion: { ...mitad, capturada_en: hace1min.toISOString() } });
            const r3 = await guardarPosicion(pool, { ordenId: ot, usuarioId: datos.mecanicoId, posicion: { ...mitad, capturada_en: ahora.toISOString() } });
            assert.equal(r3.eta.fuente, 'ors');
            const ajustada = await leerOt();
            assert.equal(ajustada.eta_segundos, 1200, 'eta_segundos no se toca');
            assert.equal(new Date(ajustada.eta_calculada_at).getTime(), new Date(conRuta.eta_calculada_at).getTime());
            const restante = (new Date(ajustada.eta_ajustada_llegada_at).getTime() - ahora.getTime()) / 1000;
            assert.ok(restante > 300 && restante < 900, `quedaban cerca de la mitad de 1200 s: ${restante}`);
            assert.equal(new Date(ajustada.eta_ajustada_at).getTime(), ahora.getTime());

            // 4) quieto desde: la ultima vez que se movio fue al pasar de `origen` a `mitad` (hace 1 min)
            const pos = (await pool.query('SELECT quieto_desde FROM posiciones_mecanico WHERE usuario_id = $1', [datos.mecanicoId])).rows[0];
            assert.equal(new Date(pos.quieto_desde).getTime(), hace1min.getTime());

            // 5) el portal del cliente ve la hora ajustada y cuando se actualizo, sin coordenadas
            const portal = (await pedirConToken('/api/ordenes-trabajo/mias', tokenCliente(cliente))).body.find((x) => x.id === ot);
            assert.equal(new Date(portal.eta_llegada_at).getTime(), new Date(ajustada.eta_ajustada_llegada_at).getTime());
            assert.equal(new Date(portal.eta_calculada_at).getTime(), ahora.getTime(), 'Actualizada hace X sigue a la posicion');
            assert.equal(portal.eta_aproximada, false, 'escalada desde la ruta real: no es aproximada');
            afirmarClavesPortal(portal);

            // el detalle de la OT (lo ve tambien el mecanico) no trae el estado interno de la ETA
            const detalle = await pedir('GET', `/api/ordenes-trabajo/${ot}`, 'administrativo');
            assert.equal(detalle.status, 200);
            for (const interno of ['eta_origen_lat', 'eta_origen_lng', 'eta_consultas', 'eta_intento_at', 'eta_ajustada_llegada_at', 'eta_ajustada_at']) {
                assert.ok(!(interno in detalle.body), `el detalle no debe traer ${interno}`);
            }

            // 6) al llegar una ruta nueva el ajuste se descarta (manda la ruta real)
            await pool.query(`UPDATE ordenes_trabajo SET eta_intento_at = now() - interval '10 minutes', eta_calculada_at = now() - interval '10 minutes' WHERE id = $1`, [ot]);
            const nueva = { llamar: async () => ({ distancia_m: 4000, segundos: 500 }), hayLlave: () => true, log: silencio };
            assert.equal((await mejorarEtaConRutas(pool, { ordenId: ot, usuarioId: datos.mecanicoId, origen: mitad }, { ...nueva, ahora: new Date() })).guardada, true);
            const despues = await leerOt();
            assert.equal(despues.eta_ajustada_llegada_at, null);
            assert.equal(despues.eta_ajustada_at, null);
            await pool.query('DELETE FROM uso_ors');
        });

        test('una OT finalizada no trae el vehiculo de hoy y dice si habra cobro', async (t) => {
            if (!requiereBase(t)) return;
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            const crear = async () => {
                const ot = (await pool.query(
                    `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo)
                     VALUES ($1, $2, $3, 'en_terreno', 'OT para el cobro') RETURNING id`, [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
                datos.ordenes.push(ot);
                return ot;
            };
            const sinLineas = await crear();
            await cerrarOt(sinLineas, null);
            const conCobro = await crear();
            await agregarLinea(conCobro, { facturable: 'si', precio_unitario: 1000 });
            await cerrarOt(conCobro, 1000);
            const porDefinir = await crear();
            await agregarLinea(porDefinir, { facturable: 'pendiente' });
            await cerrarOt(porDefinir, null);
            await conVehiculo(async () => {
                const r = await pedirConToken('/api/ordenes-trabajo/mias', tokenCliente(cliente));
                const por = Object.fromEntries(r.body.map((o) => [o.id, o]));
                assert.equal(por[sinLineas].cobro, 'sin_cobro');
                assert.equal(por[conCobro].cobro, 'con_cobro');
                assert.equal(por[porDefinir].cobro, 'por_definir');
                for (const id of [sinLineas, conCobro, porDefinir]) {
                    assert.equal(por[id].vehiculo_patente, null, 'finalizada: sin vehiculo');
                    assert.equal(por[id].vehiculo_marca, null);
                    assert.ok(!('valorizacion' in por[id]) && !('facturable' in por[id]));
                }
            });
        });

        test('sigue pidiendo una cuenta de cliente vinculada', async (t) => {
            if (!requiereBase(t)) return;
            assert.equal((await pedir('GET', '/api/ordenes-trabajo/mias', 'mecanico')).status, 403);
            assert.equal((await pedir('GET', '/api/ordenes-trabajo/mias', 'cliente')).status, 400, 'el token de prueba no tiene cliente_id');
        });
    });
});

describe('contratos del dashboard y el portal: casos de borde', () => {
    const tokenCliente = tokenClienteDe(987656);
    async function conToken(ruta, token) {
        const r = await fetch(`${entorno.base}${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
        let json = null;
        try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
        return { status: r.status, body: json, cabeceras: r.headers };
    }

    test('asignada_at es la ultima asignacion aplicada y no pasa de la aceptacion: A acepta, se reasigna a B', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const ot = (await pool.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo)
             VALUES ($1, $2, $3, 'asignada', 'OT reasignada') RETURNING id`, [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
        datos.ordenes.push(ot);
        const evento = (hora) => pool.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen, aplicado) VALUES ($1, 'asignacion', $2, 'panel', true)`, [ot, hora]);
        const leer = async () => (await conToken('/api/ordenes-trabajo/mias', tokenCliente(cliente))).body.find((o) => o.id === ot);
        // A recibe la OT a las 09:00 y la acepta a las 09:30
        await evento('2026-03-02T09:00:00Z');
        await pool.query(`UPDATE ordenes_trabajo SET estado = 'aceptada', aceptada_at = '2026-03-02T09:30:00Z' WHERE id = $1`, [ot]);
        assert.equal(new Date((await leer()).asignada_at).toISOString(), '2026-03-02T09:00:00.000Z');
        // se reasigna a B a las 10:00: los pasos del viaje se borran y la ultima asignacion es la de B
        await evento('2026-03-02T10:00:00Z');
        await pool.query(`UPDATE ordenes_trabajo SET estado = 'asignada', aceptada_at = NULL WHERE id = $1`, [ot]);
        assert.equal(new Date((await leer()).asignada_at).toISOString(), '2026-03-02T10:00:00.000Z', 'se ve la hora de B');
        // B acepta a las 10:20: una reasignacion posterior a la aceptacion no mueve la linea de tiempo hacia atras
        await pool.query(`UPDATE ordenes_trabajo SET estado = 'aceptada', aceptada_at = '2026-03-02T10:20:00Z' WHERE id = $1`, [ot]);
        await evento('2026-03-02T11:00:00Z');
        const o = await leer();
        assert.equal(new Date(o.asignada_at).toISOString(), '2026-03-02T10:00:00.000Z');
        assert.ok(new Date(o.asignada_at) <= new Date(o.aceptada_at), 'la asignacion nunca es posterior a la aceptacion');
    });

    test('/mias: un cliente no ve las ordenes de otro y la respuesta no se guarda en caches', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = (await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 2')).rows;
        if (clientes.length < 2) return t.skip('la semilla no tiene dos clientes');
        const [a, b] = clientes.map((c) => c.id);
        const equipo = await crearEquipo(null);
        const crear = async (cliente) => {
            const ot = (await pool.query(
                `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, estado, motivo)
                 VALUES ($1, $2, $3, 'en_terreno', 'OT de un cliente') RETURNING id`, [equipo.id, cliente, datos.mecanicoId])).rows[0].id;
            datos.ordenes.push(ot);
            return ot;
        };
        const deA = await crear(a);
        const deB = await crear(b);
        const rA = await conToken('/api/ordenes-trabajo/mias', tokenCliente(a));
        assert.equal(rA.status, 200);
        const idsA = rA.body.map((o) => o.id);
        assert.ok(idsA.includes(deA) && !idsA.includes(deB), 'A solo ve la suya');
        const idsB = (await conToken('/api/ordenes-trabajo/mias', tokenCliente(b))).body.map((o) => o.id);
        assert.ok(idsB.includes(deB) && !idsB.includes(deA), 'B solo ve la suya');
        assert.equal(rA.cabeceras.get('cache-control'), 'no-store');
    });

    test('/dashboard/pendientes no se guarda en caches y /resumen trae todos los estados con 0', async (t) => {
        if (!requiereBase(t)) return;
        const r = await fetch(`${entorno.base}/api/dashboard/pendientes`, { headers: { Authorization: `Bearer ${tokens.administrativo}` } });
        assert.equal(r.headers.get('cache-control'), 'no-store');
        const { ESTADOS } = require('../src/utils/estadosOt');
        const resumen = (await pedir('GET', '/api/ordenes-trabajo/resumen', 'administrativo')).body;
        assert.deepEqual(Object.keys(resumen.por_estado).sort(), [...ESTADOS].sort());
        assert.ok(Object.values(resumen.por_estado).every((n) => Number.isInteger(n) && n >= 0));
        assert.equal(Object.values(resumen.por_estado).reduce((x, y) => x + y, 0), resumen.todas);
    });

    test('el cache de arriendos del dashboard dura 30 s y se puede vaciar', async (t) => {
        if (!requiereBase(t)) return;
        const dashboard = require('../src/routes/dashboard');
        dashboard.vaciarCacheArriendos();
        const equipo = await crearEquipo(null);
        const cliente = await algunCliente();
        const antes = (await pedir('GET', '/api/dashboard/pendientes', 'administrativo')).body.arriendos_con_aviso;
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-01-02T09:00:00-03:00', $2)`, [equipo.id, cliente]);
        // dentro de los 30 s el numero no cambia...
        assert.equal((await pedir('GET', '/api/dashboard/pendientes', 'administrativo')).body.arriendos_con_aviso, antes);
        // ...y al vaciar el cache ve el arriendo nuevo
        dashboard.vaciarCacheArriendos();
        assert.equal((await pedir('GET', '/api/dashboard/pendientes', 'administrativo')).body.arriendos_con_aviso, antes + 1);
    });

    test('paginacion de /ordenes-trabajo con fechas repetidas: ninguna fila se repite ni se pierde, en los dos sentidos', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const ids = [];
        // cinco ordenes con exactamente la misma fecha de creacion
        for (let i = 0; i < 5; i++) {
            const ot = (await pool.query(
                `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo, fecha_creacion)
                 VALUES ($1, $2, 'pendiente', 'OT con fecha repetida', '2030-01-01T00:00:00Z') RETURNING id`, [equipo.id, cliente])).rows[0].id;
            datos.ordenes.push(ot);
            ids.push(ot);
        }
        for (const dir of ['asc', 'desc']) {
            const vistos = [];
            // paginas de 2 sobre el filtro Sin asignar, que incluye estas cinco
            for (let offset = 0; ; offset += 2) {
                const r = await pedir('GET', `/api/ordenes-trabajo?sin_asignar=1&dir=${dir}&limit=2&offset=${offset}`, 'administrativo');
                assert.equal(r.status, 200);
                vistos.push(...r.body.items.map((o) => o.id));
                if (!r.body.hay_mas) break;
            }
            assert.equal(new Set(vistos).size, vistos.length, `${dir}: sin repetidos`);
            const total = (await pedir('GET', '/api/ordenes-trabajo?sin_asignar=1&limit=1', 'administrativo')).body.total;
            assert.equal(vistos.length, total, `${dir}: ninguna perdida`);
            for (const id of ids) assert.ok(vistos.includes(id), `${dir}: aparece la orden ${id}`);
            const propias = vistos.filter((id) => ids.includes(id));
            const esperado = [...ids].sort((x, y) => (dir === 'asc' ? x - y : y - x));
            assert.deepEqual(propias, esperado, `${dir}: las de fecha repetida salen por id`);
        }
    });

    test('GET /solicitudes?estado=: filtra por estado y rechaza uno desconocido', async (t) => {
        if (!requiereBase(t)) return;
        const todas = await pedir('GET', '/api/solicitudes', 'administrativo');
        const pendientes = await pedir('GET', '/api/solicitudes?estado=pendiente', 'administrativo');
        assert.equal(pendientes.status, 200);
        assert.ok(pendientes.body.every((x) => x.estado === 'pendiente'));
        assert.ok(pendientes.body.length <= todas.body.length);
        assert.equal((await pedir('GET', '/api/solicitudes?estado=inventado', 'administrativo')).status, 400);
        assert.equal((await pedir('GET', '/api/solicitudes?estado=pendiente', 'mecanico')).status, 403);
    });
});
