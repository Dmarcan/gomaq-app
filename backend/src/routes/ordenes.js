const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { verificarDuenoOrden, contactoCliente, MENSAJE_OT_CERRADA } = require('../utils/ordenes');
const { estadoTrasAsignar, evaluarCambioEstado, evaluarCierre } = require('../utils/estadosOt');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { parsearPaginacion, parsearBusqueda, envolver } = require('../utils/paginacion');
const { leerUuidCliente, buscarPorUuid, esUuidDuplicado } = require('../utils/idempotencia');
const { rutaPerteneceAOrden } = require('../utils/rutaArchivo');
const {
    dejarEvento, leerUuidTarea, sincronizadoTarde, decidirEventoDiagnostico, decidirEventoAsignacion, esMismoTecnico,
} = require('../utils/eventosOt');

const router = express.Router();

// Los seis tipos del talonario. Los marca el mecanico en terreno, que es quien sabe de que
// se trato la visita; el administrativo no lo fija al crear la OT.
const TIPOS_SERVICIO = [
    'preventivo', 'reparacion', 'garantia_full_mantencion',
    'correctivo', 'bateria_cargador', 'administrativo',
];

// POST /api/ordenes-trabajo - crear OT
router.post('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { maquinaria_id, cliente_id, origen, motivo } = req.body;
    if (!maquinaria_id) {
        return res.status(400).json({ error: 'maquinaria_id es requerido' });
    }
    let client = null;
    try {
        client = await pool.connect();
        // El cliente de la orden es quien tiene el equipo AHORA, y la base ya lo sabe: no hay que
        // preguntarlo. Se copia a la orden (no se deriva despues) porque maquinarias.cliente_id
        // se pone en NULL al recibir el equipo de vuelta, y la orden tiene que seguir diciendo
        // de quien era. Es lo mismo que hace la OT que abre el mecanico en terreno. Un
        // cliente_id explicito se respeta, para quien llame a la API con otro criterio.
        const equipo = await client.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [maquinaria_id]);
        if (equipo.rows.length === 0) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }
        // facturable nace en false y ya no lo decide nadie a mano: se deriva de las lineas
        // de repuesto de la OT (ver utils/facturableOt.js), como en el talonario de papel.
        // La OT y su evento de creacion van en la misma transaccion (historial, migracion 020).
        await client.query('BEGIN');
        const result = await client.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, origen, motivo)
             VALUES ($1, $2, COALESCE($3::origen_orden, 'directo'), $4)
             RETURNING *`,
            [maquinaria_id, cliente_id || equipo.rows[0].cliente_id || null, origen || null, motivo || null]
        );
        const orden = result.rows[0];
        await dejarEvento(client, {
            ordenId: orden.id, tipo: 'creacion', origen: 'panel', estadoNuevo: orden.estado,
            usuario: req.user,
            detalle: { maquinaria_id: orden.maquinaria_id, cliente_id: orden.cliente_id },
        });
        await client.query('COMMIT');
        res.status(201).json(orden);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al crear orden de trabajo' });
    } finally {
        if (client) client.release();
    }
});

// POST /api/ordenes-trabajo/en-terreno - el mecanico abre una OT para un segundo equipo.
//
// Entrevista el jefe de taller, punto 1: "voy por este equipo pero veo otro... si yo le puse el repuesto
// al otro equipo, ese repuesto queda en el aire". Se resuelve forzando una OT por equipo
// intervenido, en vez de dejar que una linea apunte a una maquina distinta a la de su orden:
// asi el costo por equipo queda bien atribuido sin casos especiales.
//
// Nace ya asignada a quien la crea y en 'en_terreno', para que pueda cargarle repuestos de
// inmediato sin pasar por el administrativo.
router.post('/en-terreno', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { maquinaria_id, motivo } = req.body;
    if (!maquinaria_id) {
        return res.status(400).json({ error: 'maquinaria_id es requerido' });
    }
    const { valido: uuidValido, uuid } = leerUuidCliente(req.body);
    if (!uuidValido) {
        return res.status(400).json({ error: 'uuid_cliente no es un UUID valido' });
    }
    // Reintento de una OT que ya se creo: devolverla, o el movil remapearia sus fotos y
    // repuestos a una segunda OT y la primera quedaria huerfana en el servidor.
    const devolverExistente = (existente) => {
        if (existente.mecanico_id !== req.user.id) {
            return res.status(409).json({ error: 'uuid_cliente ya usado por otra orden' });
        }
        return res.status(200).json(existente);
    };
    let client = null;
    try {
        client = await pool.connect();
        const yaCreada = await buscarPorUuid(client, 'ordenes_trabajo', uuid);
        if (yaCreada) return devolverExistente(yaCreada);

        const maquinaria = await client.query('SELECT id, cliente_id FROM maquinarias WHERE id = $1', [maquinaria_id]);
        if (maquinaria.rows.length === 0) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }
        // la OT y su evento de creacion van en la misma transaccion (historial, migracion 020)
        await client.query('BEGIN');
        const result = await client.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, origen, motivo, estado, uuid_cliente, llegada_at)
             VALUES ($1, $2, $3, 'directo', $4, 'en_terreno', $5, now())
             RETURNING *`,
            [maquinaria_id, maquinaria.rows[0].cliente_id, req.user.id, motivo || 'Equipo intervenido durante otra visita', uuid]
        );
        const orden = result.rows[0];
        await dejarEvento(client, {
            ordenId: orden.id, tipo: 'creacion', origen: 'terreno', estadoNuevo: orden.estado,
            usuario: req.user, uuidCliente: uuid,
            detalle: { maquinaria_id: orden.maquinaria_id, cliente_id: orden.cliente_id, mecanico_id: orden.mecanico_id },
        });
        await client.query('COMMIT');
        res.status(201).json(orden);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (esUuidDuplicado(err)) {
            // otro reintento gano la carrera: se devuelve su OT. Si esta consulta tambien falla, el
            // error no puede quedar sin manejar (Express 4 no captura el rechazo): cae al 500 de abajo.
            try {
                const existente = await buscarPorUuid(client, 'ordenes_trabajo', uuid);
                if (existente) return devolverExistente(existente);
            } catch (errBusqueda) {
                console.error(errBusqueda);
            }
        }
        console.error(err);
        res.status(500).json({ error: 'Error al crear la orden de trabajo en terreno' });
    } finally {
        // sin pasar el error a release(): un fallo de consulta (como el choque del uuid) no daña la
        // conexion, y pg ya descarta por si solo los clientes cuyo socket se cayo
        if (client) client.release();
    }
});

// GET /api/ordenes-trabajo - listar (mecanico solo ve las suyas)
router.get('/', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const { limit, offset } = parsearPaginacion(req.query);
    const q = parsearBusqueda(req.query);
    try {
        const condiciones = [];
        const params = [];
        if (req.user.rol === 'mecanico' && req.query.sin_asignar === '1') {
            // ordenes creadas por la oficina o por un cliente que todavia no tienen mecanico: el
            // mecanico las ve para poder tomarlas (PATCH /:id/tomar)
            condiciones.push(`(ot.mecanico_id IS NULL AND ot.estado = 'pendiente')`);
        } else if (req.user.rol === 'mecanico') {
            params.push(req.user.id);
            condiciones.push(`ot.mecanico_id = $${params.length}`);
        }
        if (q) {
            params.push(`%${q}%`);
            condiciones.push(`(m.codigo ILIKE $${params.length} OR c.nombre ILIKE $${params.length}
                               OR ot.motivo ILIKE $${params.length})`);
        }
        if (req.query.estado) {
            params.push(req.query.estado);
            condiciones.push(`ot.estado = $${params.length}::estado_orden`);
        }
        const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

        const base = `FROM ordenes_trabajo ot
                      JOIN maquinarias m ON m.id = ot.maquinaria_id
                      LEFT JOIN clientes c ON c.id = ot.cliente_id
                      ${where}`;
        const total = await pool.query(`SELECT COUNT(*)::int AS n ${base}`, params);

        let sql = `SELECT ot.*, m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre
                   ${base} ORDER BY ot.fecha_creacion DESC`;
        const paramsPagina = [...params];
        if (limit !== null) {
            paramsPagina.push(limit, offset);
            sql += ` LIMIT $${paramsPagina.length - 1} OFFSET $${paramsPagina.length}`;
        }
        const result = await pool.query(sql, paramsPagina);
        res.json(envolver(result.rows, total.rows[0].n, { limit, offset }));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar órdenes de trabajo' });
    }
});

// GET /api/ordenes-trabajo/mias - portal cliente: su historial de OT con facturas vinculadas
router.get('/mias', verifyToken, requireRole('cliente'), async (req, res) => {
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Tu cuenta no está vinculada a ninguna empresa. Pide a GOMAQ que la vincule' });
    }
    try {
        const result = await pool.query(
            `SELECT ot.id, ot.estado, ot.motivo, ot.diagnostico, ot.fecha_creacion, ot.fecha_cierre,
                    m.codigo AS maquinaria_codigo, m.tipo AS maquinaria_tipo,
                    f.id AS factura_id, f.folio AS factura_folio, f.archivo_url AS factura_url,
                    u.nombre AS mecanico_nombre
             FROM ordenes_trabajo ot
             JOIN maquinarias m ON m.id = ot.maquinaria_id
             LEFT JOIN facturas f ON f.orden_trabajo_id = ot.id
             -- el portal muestra quien atiende cada orden abierta, no solo las que nacieron de
             -- una asistencia pedida por el cliente
             LEFT JOIN usuarios u ON u.id = ot.mecanico_id
             WHERE ot.cliente_id = $1
             ORDER BY ot.fecha_creacion DESC`,
            [req.user.cliente_id]
        );

        // factura_url guarda la ruta dentro del bucket privado, no una URL directa;
        // se reemplaza por una URL firmada temporal (1h) antes de responder
        const conUrlFirmada = await Promise.all(result.rows.map(async (fila) => {
            if (!fila.factura_url) return fila;
            const { data, error } = await supabase.storage
                .from(BUCKET_DOCUMENTOS)
                .createSignedUrl(fila.factura_url, 3600);
            return { ...fila, factura_url: error ? null : data.signedUrl };
        }));

        res.json(conUrlFirmada);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar tu historial' });
    }
});

// GET /api/ordenes-trabajo/:id - detalle
router.get('/:id', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT ot.*, m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre
             FROM ordenes_trabajo ot
             JOIN maquinarias m ON m.id = ot.maquinaria_id
             LEFT JOIN clientes c ON c.id = ot.cliente_id
             WHERE ot.id = $1`,
            [req.params.id]
        );
        const orden = result.rows[0];
        if (!orden) {
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        if (req.user.rol === 'mecanico' && orden.mecanico_id !== req.user.id) {
            return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
        }

        // el resto del talonario: sistemas intervenidos y tramos de trabajo
        const [servicios, tramos] = await Promise.all([
            pool.query('SELECT servicio_id FROM ot_servicios WHERE orden_trabajo_id = $1', [orden.id]),
            pool.query('SELECT * FROM tramos_trabajo WHERE orden_trabajo_id = $1 ORDER BY inicio', [orden.id]),
        ]);

        res.json({
            ...orden,
            servicio_ids: servicios.rows.map((s) => s.servicio_id),
            tramos: tramos.rows,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar orden de trabajo' });
    }
});

/**
 * Avisa al cliente quien va a intervenir su equipo. HU-07 promete avisar "quien llega a reparar su
 * equipo Y CON QUE VEHICULO": el vehiculo y el RUT permiten que porteria reconozca el furgon y
 * valide al tecnico al ingresar a la planta. Lo usan /asignar (la oficina elige al mecanico) y
 * /tomar (el mecanico la toma). Si no hay forma de contactar al cliente no encola nada.
 */
async function encolarAvisoAsignacion(client, orden, mecanico) {
    const contacto = await contactoCliente(client, orden.cliente_id);
    if (!contacto) return;
    const vehiculo = await client.query(
        'SELECT marca, modelo, patente FROM vehiculos WHERE usuario_id = $1 AND activo = true',
        [mecanico.id]
    );
    await client.query(
        `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ($1, $2, $3)`,
        [contacto.canal, contacto.destinatario, JSON.stringify({
            tipo: 'mecanico_asignado',
            orden_trabajo_id: orden.id,
            maquinaria_codigo: orden.maquinaria_codigo,
            mecanico_nombre: mecanico.nombre,
            mecanico_rut: mecanico.rut,
            vehiculo: vehiculo.rows[0] || null,
        })]
    );
}

// PATCH /api/ordenes-trabajo/:id/tomar - el mecanico toma una orden que nadie tiene asignada.
//
// Atomico: el UPDATE solo prospera si la orden sigue pendiente y sin mecanico, asi que dos
// mecanicos tomando la misma a la vez no pueden quedar los dos. El perdedor recibe 409. Un
// reintento del mismo mecanico (la respuesta se perdio) responde bien con la orden ya suya.
router.patch('/:id/tomar', verifyToken, requireRole('mecanico'), async (req, res) => {
    if (!Number.isInteger(Number(req.params.id))) return res.status(400).json({ error: 'Id de orden inválido' });
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const tomada = await client.query(
            `UPDATE ordenes_trabajo SET mecanico_id = $1, estado = 'asignada'
             WHERE id = $2 AND mecanico_id IS NULL AND estado = 'pendiente'
             RETURNING *, (SELECT codigo FROM maquinarias WHERE id = ordenes_trabajo.maquinaria_id) AS maquinaria_codigo`,
            [req.user.id, req.params.id]
        );
        if (tomada.rows.length === 0) {
            await client.query('ROLLBACK');
            const actual = await client.query('SELECT * FROM ordenes_trabajo WHERE id = $1', [req.params.id]);
            if (actual.rows.length === 0) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
            if (actual.rows[0].mecanico_id === req.user.id) return res.json(actual.rows[0]);
            return res.status(409).json({ error: 'Otro técnico ya tomó esta orden o ya no está disponible' });
        }
        const mecanico = await client.query('SELECT id, nombre, rut FROM usuarios WHERE id = $1', [req.user.id]);
        await encolarAvisoAsignacion(client, tomada.rows[0], mecanico.rows[0]);
        await dejarEvento(client, {
            ordenId: tomada.rows[0].id, tipo: 'toma', origen: 'terreno',
            estadoAnterior: 'pendiente', estadoNuevo: 'asignada', usuario: req.user,
            detalle: { mecanico_anterior_id: null, mecanico_nuevo_id: req.user.id },
        });
        await client.query('COMMIT');
        res.json(tomada.rows[0]);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al tomar la orden' });
    } finally {
        if (client) client.release();
    }
});

// PATCH /api/ordenes-trabajo/:id/asignar - asignar mecanico
// Patron Outbox (informe 6.4.2): la misma transaccion que asigna el mecanico
// inserta la notificacion pendiente (HU-07) para que nunca queden desincronizadas
router.patch('/:id/asignar', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { mecanico_id } = req.body;
    if (!mecanico_id) {
        return res.status(400).json({ error: 'mecanico_id es requerido' });
    }
    let client = null;
    try {
        client = await pool.connect();
        const mecanico = await client.query('SELECT id, nombre, rut FROM usuarios WHERE id = $1 AND rol = $2', [mecanico_id, 'mecanico']);
        if (mecanico.rows.length === 0) {
            return res.status(400).json({ error: 'El usuario elegido no es un mecánico' });
        }

        await client.query('BEGIN');

        const actual = await client.query(
            'SELECT estado, mecanico_id FROM ordenes_trabajo WHERE id = $1 FOR UPDATE',
            [req.params.id]
        );
        if (actual.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        // asignar al mismo tecnico otra vez (doble clic) no debe mandarle un segundo aviso al cliente
        const mismoTecnico = esMismoTecnico(actual.rows[0].mecanico_id, mecanico_id);
        // una OT finalizada no vuelve a "asignada"; una en curso cambia de tecnico sin retroceder
        const nuevoEstado = estadoTrasAsignar(actual.rows[0].estado, mismoTecnico);
        if (!nuevoEstado) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'La orden ya está finalizada y no se puede reasignar' });
        }
        // la regla de que pasa con el viaje y con el historial vive en utils/eventosOt.js; si el viaje
        // lo hizo otro tecnico, sus horas de aceptado y en camino no son del nuevo (reinicioViaje)
        const decision = decidirEventoAsignacion({
            estadoActual: actual.rows[0].estado, estadoNuevo: nuevoEstado,
            mecanicoAnteriorId: actual.rows[0].mecanico_id, mecanicoNuevoId: mecanico_id,
        });

        const otResult = await client.query(
            `UPDATE ordenes_trabajo SET mecanico_id = $1, estado = $2,
                    aceptada_at = CASE WHEN $4 THEN NULL ELSE aceptada_at END,
                    en_camino_at = CASE WHEN $4 THEN NULL ELSE en_camino_at END
             WHERE id = $3
             RETURNING *, (SELECT codigo FROM maquinarias WHERE id = ordenes_trabajo.maquinaria_id) AS maquinaria_codigo`,
            [mecanico_id, nuevoEstado, req.params.id, decision.reinicioViaje]
        );
        const orden = otResult.rows[0];
        // un doble clic (mismo tecnico, mismo estado) no cambia nada y no deja evento
        if (decision.registrar) {
            await dejarEvento(client, {
                ordenId: orden.id, tipo: 'asignacion', origen: 'panel',
                estadoAnterior: actual.rows[0].estado, estadoNuevo: nuevoEstado, usuario: req.user,
                detalle: {
                    mecanico_anterior_id: actual.rows[0].mecanico_id,
                    mecanico_nuevo_id: Number(mecanico_id),
                    mecanico_nuevo_nombre: mecanico.rows[0].nombre,
                    reasignacion: decision.reasignacion,
                    reinicio_viaje: decision.reinicioViaje,
                },
            });
        }
        if (mismoTecnico) {
            await client.query('COMMIT');
            return res.json(orden);
        }

        await encolarAvisoAsignacion(client, orden, mecanico.rows[0]);

        await client.query('COMMIT');
        res.json(orden);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al asignar mecánico' });
    } finally {
        if (client) client.release();
    }
});

// PATCH /api/ordenes-trabajo/:id/diagnostico - mecanico registra diagnostico y avanza estado
router.patch('/:id/diagnostico', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { diagnostico, estado, ocurrio_en } = req.body;
    const estadosValidos = ['aceptada', 'en_camino', 'en_terreno', 'en_reparacion'];
    if (estado && !estadosValidos.includes(estado)) {
        return res.status(400).json({ error: `estado debe ser uno de: ${estadosValidos.join(', ')}` });
    }
    // hora real del toque en el telefono (la cola offline puede enviarlo mucho despues). Opcional;
    // si falta o es invalida se usa la del servidor, y nunca queda en el futuro.
    const momento = ocurrio_en && !Number.isNaN(Date.parse(ocurrio_en)) ? new Date(ocurrio_en).toISOString() : null;
    // uuid de la tarea de la cola de terreno: hoy llega como `uuid` (el servidor esperaba
    // `uuid_cliente`, que el APK no manda); se aceptan los dos nombres
    const uuidTarea = leerUuidTarea(req.body.uuid_cliente) || leerUuidTarea(req.body.uuid);
    let client = null;
    try {
        client = await pool.connect();
        // el estado se lee bloqueando la fila: el evento del historial tiene que decir de que
        // estado se partio, y eso no puede cambiar entre la lectura y el UPDATE
        await client.query('BEGIN');
        const check = await verificarDuenoOrden(req.params.id, req.user.id, { db: client, bloquear: true });
        if (!check.existe) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        if (!check.esDueno) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
        }
        if (!check.editable) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: MENSAJE_OT_CERRADA });
        }
        const cambio = estado ? evaluarCambioEstado(check.estado, estado) : 'sin_cambio';
        if (cambio === 'rechazar') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `La orden no puede pasar de ${check.estado} a ${estado}` });
        }
        // un cambio que ya estaba aplicado (reintento) o llego atrasado no toca el estado ni sus horas
        const nuevoEstado = cambio === 'cambiar' ? estado : null;

        // la condicion sobre el estado cubre que la OT se cierre entre la verificacion y el UPDATE.
        // Cada hora se fija una sola vez (COALESCE): la primera vez que la OT llega a ese estado.
        const result = await client.query(
            `UPDATE ordenes_trabajo
             SET diagnostico = COALESCE($1, diagnostico),
                 estado = COALESCE($2::estado_orden, estado),
                 aceptada_at = CASE WHEN $4::text = 'aceptada'
                                    THEN COALESCE(aceptada_at, GREATEST(LEAST(COALESCE($5::timestamptz, now()), now()), fecha_creacion)) ELSE aceptada_at END,
                 en_camino_at = CASE WHEN $4::text = 'en_camino'
                                     THEN COALESCE(en_camino_at, GREATEST(LEAST(COALESCE($5::timestamptz, now()), now()), fecha_creacion)) ELSE en_camino_at END,
                 llegada_at = CASE WHEN $4::text = 'en_terreno'
                                   THEN COALESCE(llegada_at, GREATEST(LEAST(COALESCE($5::timestamptz, now()), now()), fecha_creacion)) ELSE llegada_at END
             WHERE id = $3 AND estado <> 'finalizada' RETURNING *`,
            [diagnostico || null, nuevoEstado, req.params.id, nuevoEstado, momento]
        );
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: MENSAJE_OT_CERRADA });
        }
        // Historial: un cambio aplicado deja su evento; uno atrasado (la OT ya estaba en ese estado
        // o mas adelante) tambien, con aplicado = false, para saber que el mecanico lo hizo aunque
        // no moviera nada. Un reintento con el mismo uuid no duplica (ON CONFLICT DO NOTHING).
        // Sin uuid, repetir el estado actual es un reintento puro y no se registra (la regla esta
        // en utils/eventosOt.js).
        const decision = decidirEventoDiagnostico({ cambio, estadoActual: check.estado, estadoPedido: estado, uuid: uuidTarea });
        if (decision.registrar) {
            await dejarEvento(client, {
                ordenId: Number(req.params.id), tipo: 'cambio_estado', origen: 'terreno',
                estadoAnterior: check.estado, estadoNuevo: estado, usuario: req.user,
                ocurrioEn: momento, creadaEn: check.creadaEn, uuidCliente: uuidTarea,
                nacioPorSincronizacion: check.nacioPorSincronizacion, aplicado: decision.aplicado,
            });
        }
        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar diagnóstico' });
    } finally {
        if (client) client.release();
    }
});

// PATCH /api/ordenes-trabajo/:id/datos - cabecera de la OT tal como esta en el talonario:
// tipo de servicio, observaciones iniciales y finales, y el folio del papel.
// `diagnostico` es la observacion INICIAL (mismo concepto, ya lo leen el portal del cliente y
// el panel); `observacion_final` es lo que se hizo. el jefe de taller pidio separarlas (entrevista, punto 5).
router.patch('/:id/datos', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { tipo_servicio, diagnostico, observacion_final, folio_papel } = req.body;
    if (tipo_servicio !== undefined && tipo_servicio !== null && !TIPOS_SERVICIO.includes(tipo_servicio)) {
        return res.status(400).json({ error: `tipo_servicio debe ser uno de: ${TIPOS_SERVICIO.join(', ')}` });
    }
    try {
        const check = await verificarDuenoOrden(req.params.id, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
        if (!check.editable) return res.status(409).json({ error: MENSAJE_OT_CERRADA });

        const result = await pool.query(
            `UPDATE ordenes_trabajo
             SET tipo_servicio = COALESCE($1::tipo_servicio_ot, tipo_servicio),
                 diagnostico = COALESCE($2, diagnostico),
                 observacion_final = COALESCE($3, observacion_final),
                 folio_papel = COALESCE($4, folio_papel)
             WHERE id = $5 RETURNING *`,
            [
                tipo_servicio || null,
                diagnostico === undefined ? null : diagnostico,
                observacion_final === undefined ? null : observacion_final,
                folio_papel === undefined ? null : folio_papel,
                req.params.id,
            ]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar los datos de la orden' });
    }
});

// PUT /api/ordenes-trabajo/:id/checklist - sistemas donde SE INTERVINO (no una pauta de
// revision). Se envia la lista completa de ids marcados y reemplaza la anterior: es
// idempotente, que es lo que necesita la cola offline del movil ante un reintento.
router.put('/:id/checklist', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { servicio_ids } = req.body;
    if (!Array.isArray(servicio_ids)) {
        return res.status(400).json({ error: 'servicio_ids debe ser una lista' });
    }
    let client = null;
    try {
        client = await pool.connect();
        const check = await verificarDuenoOrden(req.params.id, req.user.id, { db: client });
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
        if (!check.editable) return res.status(409).json({ error: MENSAJE_OT_CERRADA });

        await client.query('BEGIN');
        await client.query('DELETE FROM ot_servicios WHERE orden_trabajo_id = $1', [req.params.id]);
        for (const servicioId of servicio_ids) {
            await client.query(
                `INSERT INTO ot_servicios (orden_trabajo_id, servicio_id) VALUES ($1, $2)
                 ON CONFLICT (orden_trabajo_id, servicio_id) DO NOTHING`,
                [req.params.id, servicioId]
            );
        }
        await client.query('COMMIT');
        res.json({ orden_trabajo_id: Number(req.params.id), servicio_ids });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al guardar el checklist' });
    } finally {
        if (client) client.release();
    }
});

// POST /api/ordenes-trabajo/:id/tramos - registrar un tramo de trabajo (inicio y termino).
// El papel trae dos bloques porque el trabajo se puede retomar en otra visita; aca son N.
router.post('/:id/tramos', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { inicio, termino } = req.body;
    if (!inicio) {
        return res.status(400).json({ error: 'inicio es requerido' });
    }
    if (termino && new Date(termino) < new Date(inicio)) {
        return res.status(400).json({ error: 'El termino no puede ser anterior al inicio' });
    }
    const { valido: uuidValido, uuid } = leerUuidCliente(req.body);
    if (!uuidValido) {
        return res.status(400).json({ error: 'uuid_cliente no es un UUID valido' });
    }
    try {
        const check = await verificarDuenoOrden(req.params.id, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
        if (!check.editable) return res.status(409).json({ error: MENSAJE_OT_CERRADA });

        const yaRegistrado = await buscarPorUuid(pool, 'tramos_trabajo', uuid);
        if (yaRegistrado) return res.status(200).json(yaRegistrado);

        // Cerrar un tramo: la app envia primero el tramo abierto (solo inicio) y, al terminar,
        // el mismo inicio con su termino. Antes eso insertaba un segundo tramo y el primero
        // quedaba abierto para siempre, duplicando las horas de la visita. Si existe el tramo
        // abierto con ese inicio, se cierra en vez de crear otro.
        if (termino) {
            const cerrado = await pool.query(
                `UPDATE tramos_trabajo SET termino = $1
                 WHERE orden_trabajo_id = $2 AND usuario_id = $3 AND inicio = $4 AND termino IS NULL
                 RETURNING *`,
                [termino, req.params.id, req.user.id, inicio]
            );
            if (cerrado.rows.length > 0) return res.status(200).json(cerrado.rows[0]);

            // Reintento de ese mismo cierre: el UPDATE no guarda el uuid (la fila ya tiene el del
            // tramo abierto), asi que se reconoce por los datos. Sin esto, el reintento insertaba
            // un segundo tramo ya cerrado y duplicaba las horas de la visita.
            const yaCerrado = await pool.query(
                `SELECT * FROM tramos_trabajo
                 WHERE orden_trabajo_id = $1 AND usuario_id = $2 AND inicio = $3 AND termino = $4
                 LIMIT 1`,
                [req.params.id, req.user.id, inicio, termino]
            );
            if (yaCerrado.rows.length > 0) return res.status(200).json(yaCerrado.rows[0]);
        }

        const result = await pool.query(
            `INSERT INTO tramos_trabajo (orden_trabajo_id, inicio, termino, usuario_id, uuid_cliente)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [req.params.id, inicio, termino || null, req.user.id, uuid]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (esUuidDuplicado(err)) {
            const existente = await buscarPorUuid(pool, 'tramos_trabajo', uuid);
            if (existente) return res.status(200).json(existente);
        }
        console.error(err);
        res.status(500).json({ error: 'Error al registrar el tramo de trabajo' });
    }
});

// PATCH /api/ordenes-trabajo/:id/finalizar - mecanico cierra la OT.
// Ya NO recibe `facturable`: en el talonario esa marca es por linea de repuesto, asi que el
// campo de la orden lo deriva insumos.js al cambiar una linea (ver utils/facturableOt.js).
router.patch('/:id/finalizar', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { persona_recibe, sin_persona, firma_path } = req.body;
    // Datos de recepcion opcionales: los APK anteriores al rediseño no los envian.
    const tieneRecepcion = persona_recibe !== undefined || sin_persona !== undefined || firma_path !== undefined;
    if (tieneRecepcion && !sin_persona && !persona_recibe) {
        return res.status(400).json({ error: 'Debe indicar persona_recibe o marcar sin_persona' });
    }
    // la firma tiene que haberse subido a la carpeta de firmas de esta misma orden
    if (firma_path && !rutaPerteneceAOrden(firma_path, `firmas/ot-${Number(req.params.id)}/`)) {
        return res.status(400).json({ error: 'La firma no corresponde a esta orden de trabajo' });
    }
    let client = null;
    try {
        client = await pool.connect();
        const check = await verificarDuenoOrden(req.params.id, req.user.id, { db: client });
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });

        await client.query('BEGIN');
        const actual = await client.query('SELECT * FROM ordenes_trabajo WHERE id = $1 FOR UPDATE', [req.params.id]);
        const cierre = evaluarCierre(actual.rows[0].estado);
        if (cierre.yaFinalizada) {
            // reintento de la cola offline: la OT ya se cerro, con su firma y su aviso al
            // cliente. Antes se volvia a cerrar, cambiando fecha_cierre y encolando otro aviso.
            await client.query('ROLLBACK');
            return res.json(actual.rows[0]);
        }
        if (!cierre.permitido) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `Una orden en estado ${actual.rows[0].estado} no se puede cerrar` });
        }
        const result = await client.query(
            `UPDATE ordenes_trabajo
             SET estado = 'finalizada', fecha_cierre = now()
             WHERE id = $1 RETURNING *`,
            [req.params.id]
        );
        if (tieneRecepcion) {
            // ON CONFLICT: la cola offline puede reintentar el PATCH; no debe duplicar ni fallar
            await client.query(
                `INSERT INTO firmas_recepcion (orden_trabajo_id, persona_recibe, sin_persona, firma_path)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (orden_trabajo_id) DO UPDATE
                 SET persona_recibe = EXCLUDED.persona_recibe,
                     sin_persona = EXCLUDED.sin_persona,
                     firma_path = EXCLUDED.firma_path`,
                [req.params.id, persona_recibe || null, Boolean(sin_persona), firma_path || null]
            );
        }

        // Aviso de cierre al cliente, mismo patron Outbox que /asignar: la notificacion se
        // inserta en la misma transaccion que cierra la OT. Cierra el par que dibuja el BPMN
        // del informe - HU-07 avisa quien va a atender el equipo, esto avisa que quedo listo.
        const orden = result.rows[0];
        const contactoCierre = await contactoCliente(client, orden.cliente_id);
        if (contactoCierre) {
            const maquinaria = await client.query('SELECT codigo FROM maquinarias WHERE id = $1', [orden.maquinaria_id]);
            await client.query(
                `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ($1, $2, $3)`,
                [contactoCierre.canal, contactoCierre.destinatario, JSON.stringify({
                    tipo: 'ot_finalizada',
                    orden_trabajo_id: orden.id,
                    maquinaria_codigo: maquinaria.rows[0] ? maquinaria.rows[0].codigo : null,
                    observacion_final: orden.observacion_final,
                })]
            );
        }

        // el cierre y su evento van juntos; el reintento de un cierre ya aplicado salio antes y no
        // deja evento. La hora es la del servidor hasta que el APK mande la suya.
        await dejarEvento(client, {
            ordenId: orden.id, tipo: 'cierre', origen: 'terreno',
            estadoAnterior: actual.rows[0].estado, estadoNuevo: 'finalizada', usuario: req.user,
            uuidCliente: leerUuidTarea(req.body.uuid_cliente) || leerUuidTarea(req.body.uuid),
        });

        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al finalizar orden de trabajo' });
    } finally {
        if (client) client.release();
    }
});

// PATCH /api/ordenes-trabajo/:id/valorizacion - gerente aprueba monto (HU-04)
router.patch('/:id/valorizacion', verifyToken, requireRole('gerente'), async (req, res) => {
    const { valorizacion } = req.body;
    if (valorizacion === undefined || valorizacion === null || valorizacion === '' || isNaN(valorizacion)
        || Number(valorizacion) < 0) {
        return res.status(400).json({ error: 'El monto debe ser mayor o igual a 0' });
    }
    let client = null;
    try {
        client = await pool.connect();
        // la valorizacion y su evento van en la misma transaccion; la fila se bloquea para que el
        // monto anterior que queda en el historial sea el que de verdad se reemplazo
        await client.query('BEGIN');
        const actual = await client.query(
            'SELECT estado, valorizacion FROM ordenes_trabajo WHERE id = $1 FOR UPDATE',
            [req.params.id]
        );
        if (actual.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        // se valoriza el trabajo terminado: una OT en curso todavia puede sumar repuestos
        if (actual.rows[0].estado !== 'finalizada') {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Solo se valoriza una orden ya finalizada' });
        }
        // facturable NO se toca aca: se deriva de las lineas de repuesto (utils/facturableOt.js)
        const result = await client.query(
            `UPDATE ordenes_trabajo
             SET valorizacion = $1, valorizacion_aprobada_por = $2
             WHERE id = $3 RETURNING *`,
            [valorizacion, req.user.id, req.params.id]
        );
        await dejarEvento(client, {
            ordenId: result.rows[0].id, tipo: 'valorizacion', origen: 'panel', usuario: req.user,
            detalle: {
                valorizacion_anterior: actual.rows[0].valorizacion === null ? null : Number(actual.rows[0].valorizacion),
                valorizacion_nueva: Number(result.rows[0].valorizacion),
            },
        });
        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al aprobar valorización' });
    } finally {
        if (client) client.release();
    }
});

// GET /api/ordenes-trabajo/:id/historial - linea de tiempo de la orden (administrativo y gerente).
// Los eventos salen en el orden en que se escribieron (id), con la creacion siempre primero.
// `ocurrio_en` es la hora que se muestra, pero no ordena: un telefono con el reloj mal daria
// cadenas "de X a Y" incoherentes. Tampoco ordena `registrado_en`, que es la hora de inicio de la
// transaccion y puede invertir dos operaciones casi simultaneas; el id sigue el orden real, porque
// cada evento se escribe con la fila de la OT bloqueada. `sincronizado_tarde` marca los que llegaron
// al servidor mas de 10 minutos despues de ocurrir, salvo los reconstruidos por la migracion (su
// registrado_en es la fecha de la migracion, no un atraso).
router.get('/:id/historial', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    if (!/^[1-9]\d{0,8}$/.test(req.params.id)) return res.status(400).json({ error: 'Id de orden inválido' });
    try {
        const orden = await pool.query('SELECT id FROM ordenes_trabajo WHERE id = $1', [req.params.id]);
        if (orden.rows.length === 0) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        const result = await pool.query(
            `SELECT e.id, e.orden_trabajo_id, e.tipo, e.estado_anterior, e.estado_nuevo, e.usuario_id,
                    u.nombre AS usuario_nombre, e.rol, e.ocurrio_en, e.registrado_en, e.origen,
                    e.aplicado, e.hora_dudosa, e.detalle
             FROM ordenes_eventos e
             LEFT JOIN usuarios u ON u.id = e.usuario_id
             WHERE e.orden_trabajo_id = $1
             -- la creacion va siempre primero (una OT hecha sin senal nace con la hora de la
             -- sincronizacion, despues de eventos que el telefono ya habia vivido); el resto por
             -- orden de escritura (id), decidido por David: llegada al servidor
             ORDER BY (e.tipo = 'creacion') DESC, e.id`,
            [req.params.id]
        );
        res.json(result.rows.map((e) => ({
            ...e,
            sincronizado_tarde: e.origen !== 'migracion' && sincronizadoTarde(e.ocurrio_en, e.registrado_en),
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar el historial de la orden' });
    }
});

module.exports = router;
