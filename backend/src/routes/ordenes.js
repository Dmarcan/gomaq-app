const express = require('express');
require('../utils/asyncErrores');
const { validarIdsEnRuta, validarCuerpo, fechaHoraInvalida } = require('../utils/validacion');

const MAX_ELEMENTOS_CHECKLIST = 100;
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { verificarDuenoOrden, contactoCliente, MENSAJE_OT_CERRADA, SQL_OT_SIN_ASIGNAR } = require('../utils/ordenes');
const { cobroParaCliente } = require('../utils/cobroCliente');
const { estadoTrasAsignar, evaluarCambioEstado, evaluarCierre, parsearEstados, EN_CURSO_PANEL, ESTADOS } = require('../utils/estadosOt');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { urlFirmadaONull } = require('../utils/urlsFirmadas');
const { parsearPaginacion, parsearBusqueda, envolver } = require('../utils/paginacion');
const { leerUuidCliente, buscarPorUuid, esUuidDuplicado } = require('../utils/idempotencia');
const { rutaPerteneceAOrden } = require('../utils/rutaArchivo');
const { montoEnteroONulo } = require('../utils/auditoriaLinea');
const {
    dejarEvento, leerUuidTarea, sincronizadoTarde, decidirEventoDiagnostico, decidirEventoAsignacion, esMismoTecnico,
} = require('../utils/eventosOt');
const { avisarAsignacion, avisarPorValorizar } = require('../utils/avisos');

const {
    validarEstadoEquipoCierre, aplicarEntradaEquipo, aplicarCierreEquipo, origenDeCliente,
} = require('../utils/estadoEquipo');
const { EN_CURSO } = require('../utils/estadosOt');
const { fijarDestinoOt } = require('../utils/fijarDestinoOt');
const { guardarPosicion, limpiarViaje } = require('../utils/posicionMecanico');
const { SQL_ETA_LLEGADA_AT, conLlegadaEstimada } = require('../utils/etaLlegada');
const { mejorarEtaConRutas } = require('../services/rutasEta');

// Estado interno de la ETA (origen de la ultima consulta, cupo gastado, ajuste): no sale en el listado
// ni en el detalle de la OT, que se arman con `ot.*`. Una columna nueva de ETA no llega por accidente.
const CAMPOS_INTERNOS_ETA = [
    'eta_origen_lat', 'eta_origen_lng', 'eta_consultas', 'eta_intento_at', 'eta_ajustada_llegada_at', 'eta_ajustada_at',
];
function sinInternosEta(fila) {
    const copia = { ...fila };
    for (const campo of CAMPOS_INTERNOS_ETA) delete copia[campo];
    return copia;
}

const router = express.Router();
validarIdsEnRuta(router, ['id']);

// Los seis tipos del talonario. Los marca el mecanico en terreno, que es quien sabe de que
// se trato la visita; el administrativo no lo fija al crear la OT.
const TIPOS_SERVICIO = [
    'preventivo', 'reparacion', 'garantia_full_mantencion',
    'correctivo', 'bateria_cargador', 'administrativo',
];

router.post('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { maquinaria_id, cliente_id, motivo } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { motivo: 2000 }, ids: ['maquinaria_id', 'cliente_id'] });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
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
        // facturable nace en false: se deriva de las lineas de repuesto de la OT (ver utils/facturableOt.js),
        // como en el talonario de papel.
        // La OT y su evento de creacion van en la misma transaccion (historial, migracion 020).
        await client.query('BEGIN');
        // el origen lo da el cliente de la orden (con ejecutivo = externo), no quien llama a la API
        const clienteOrden = cliente_id || equipo.rows[0].cliente_id || null;
        const result = await client.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, origen, motivo)
             VALUES ($1, $2, $3::origen_orden, $4)
             RETURNING *`,
            [maquinaria_id, clienteOrden, await origenDeCliente(client, clienteOrden), motivo || null]
        );
        const orden = result.rows[0];
        // destino de la visita (ubicacion del cliente o de la guia vigente); sin coordenadas queda en null
        await fijarDestinoOt(client, orden.id);
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

// el mecanico abre una OT para un segundo equipo.
//
// Si intervino otro equipo, el repuesto no puede quedar en el aire: se fuerza una OT por equipo
// intervenido, en vez de dejar que una linea apunte a una maquina distinta a la de su orden, y asi el
// costo por equipo queda bien atribuido sin casos especiales.
//
// Nace ya asignada a quien la crea y en 'en_terreno', para que pueda cargarle repuestos de
// inmediato sin pasar por el administrativo.
router.post('/en-terreno', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { maquinaria_id, motivo } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { motivo: 20000 }, ids: ['maquinaria_id'] });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
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

        // la OT y su evento de creacion van en la misma transaccion (historial, migracion 020)
        await client.query('BEGIN');
        // El equipo se bloquea ANTES de insertar la OT: el INSERT toma KEY SHARE sobre el equipo por la
        // clave foranea y aplicarEntradaEquipo pide despues el bloqueo del mismo equipo; con dos
        // mecanicos abriendo OT sobre el mismo equipo a la vez, cada uno esperaba al otro (deadlock).
        // Ademas el cliente de la OT se lee ya con el equipo bloqueado, no antes.
        const maquinaria = await client.query('SELECT id, cliente_id FROM maquinarias WHERE id = $1 FOR NO KEY UPDATE', [maquinaria_id]);
        if (maquinaria.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }
        const result = await client.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, origen, motivo, estado, uuid_cliente, llegada_at)
             VALUES ($1, $2, $3, $6::origen_orden, $4, 'en_terreno', $5, now())
             RETURNING *`,
            [maquinaria_id, maquinaria.rows[0].cliente_id, req.user.id, motivo || 'Equipo intervenido durante otra visita', uuid,
             await origenDeCliente(client, maquinaria.rows[0].cliente_id)]
        );
        const orden = result.rows[0];
        // la OT nace ya en terreno: un equipo operativo pasa a en_mantencion
        await aplicarEntradaEquipo(client, orden.maquinaria_id);
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

router.get('/', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const { limit, offset } = parsearPaginacion(req.query);
    const q = parsearBusqueda(req.query);
    // ?estado acepta una lista separada por comas (pestana "En curso" del panel); uno desconocido da 400
    let estados = null;
    if (req.query.estado) {
        const parseado = parsearEstados(req.query.estado);
        if (parseado.error) return res.status(400).json({ error: parseado.error });
        estados = parseado.estados;
    }
    const ascendente = req.query.dir === 'asc';
    const condiciones = [];
    const params = [];
    if (req.query.sin_asignar === '1') {
        // ordenes creadas por la oficina o por un cliente que todavia no tienen mecanico: el
        // mecanico las ve para poder tomarlas (PATCH /:id/tomar) y el panel las lista en
        // "Sin asignar" (las mismas que cuenta el dashboard)
        condiciones.push(SQL_OT_SIN_ASIGNAR);
    } else if (req.user.rol === 'mecanico') {
        params.push(req.user.id);
        condiciones.push(`ot.mecanico_id = $${params.length}`);
    }
    if (q) {
        params.push(`%${q}%`);
        condiciones.push(`(m.codigo ILIKE $${params.length} OR c.nombre ILIKE $${params.length}
                               OR ot.motivo ILIKE $${params.length})`);
    }
    if (estados) {
        params.push(estados);
        condiciones.push(`ot.estado = ANY($${params.length}::estado_orden[])`);
    }
    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    const base = `FROM ordenes_trabajo ot
                      JOIN maquinarias m ON m.id = ot.maquinaria_id
                      LEFT JOIN clientes c ON c.id = ot.cliente_id
                      LEFT JOIN usuarios um ON um.id = ot.mecanico_id
                      ${where}`;
    const total = await pool.query(`SELECT COUNT(*)::int AS n ${base}`, params);

    // desempate por id: la paginacion no debe repetir ni saltarse filas con la misma fecha
    let sql = `SELECT ot.*, m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre, um.nombre AS mecanico_nombre
                   ${base} ORDER BY ot.fecha_creacion ${ascendente ? 'ASC' : 'DESC'}, ot.id ${ascendente ? 'ASC' : 'DESC'}`;
    const paramsPagina = [...params];
    if (limit !== null) {
        paramsPagina.push(limit, offset);
        sql += ` LIMIT $${paramsPagina.length - 1} OFFSET $${paramsPagina.length}`;
    }
    const result = await pool.query(sql, paramsPagina);
    res.json(envolver(result.rows.map(sinInternosEta), total.rows[0].n, { limit, offset }));
});

// conteos de las pestanas de Ordenes del panel. Se declara antes de
// /:id para que "resumen" no se lea como un id. Cada conteo es el total de la lista con su filtro:
//   sin_asignar -> ?sin_asignar=1 ; en_curso -> ?estado=<EN_CURSO_PANEL> ; finalizadas -> ?estado=finalizada
router.get('/resumen', verifyToken, requireRole('gerente', 'administrativo'), async (req, res) => {
    const r = await pool.query(
        `SELECT COUNT(*)::int AS todas,
                    COUNT(*) FILTER (WHERE ${SQL_OT_SIN_ASIGNAR})::int AS sin_asignar,
                    COUNT(*) FILTER (WHERE ot.estado = ANY($1::estado_orden[]))::int AS en_curso,
                    COUNT(*) FILTER (WHERE ot.estado = 'finalizada')::int AS finalizadas
             FROM ordenes_trabajo ot`,
        [EN_CURSO_PANEL]
    );
    const porEstado = await pool.query('SELECT estado, COUNT(*)::int AS n FROM ordenes_trabajo GROUP BY estado');
    res.json({
        ...r.rows[0],
        // todos los estados, con 0 los que no tienen ordenes: el panel no tiene que adivinar cuales faltan
        por_estado: { ...Object.fromEntries(ESTADOS.map((e) => [e, 0])), ...Object.fromEntries(porEstado.rows.map((f) => [f.estado, f.n])) },
    });
});

router.get('/mias', verifyToken, requireRole('cliente'), async (req, res) => {
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Tu cuenta no está vinculada a ninguna empresa. Pide a GOMAQ que la vincule' });
    }
    // datos del cliente que cambian con cada avance de la orden: nada de caches intermedios
    res.set('Cache-Control', 'no-store');
    const result = await pool.query(
        `SELECT ot.id, ot.estado, ot.motivo, ot.diagnostico, ot.fecha_creacion, ot.fecha_cierre,
                    ot.aceptada_at, ot.en_camino_at, ot.llegada_at, ot.facturable, ot.valorizacion,
                    -- cuando se le asigno el tecnico de ahora: la ULTIMA asignacion o toma que de verdad se aplico, y no
                    -- posterior a la aceptacion (si se reasigna, aceptada_at/en_camino_at/llegada_at se borran y la linea
                    -- de tiempo del portal no se desordena)
                    (SELECT MAX(e.ocurrio_en) FROM ordenes_eventos e
                     WHERE e.orden_trabajo_id = ot.id AND e.tipo IN ('asignacion', 'toma') AND e.aplicado
                       AND e.ocurrio_en <= COALESCE(ot.aceptada_at, ot.en_camino_at, ot.llegada_at, 'infinity'::timestamptz)) AS asignada_at,
                    -- lineas de repuesto sin decidir si se cobran: "por confirmar" para el cliente
                    (SELECT COUNT(*)::int FROM movimientos_insumo mi
                     WHERE mi.orden_trabajo_id = ot.id AND mi.anulada_at IS NULL AND mi.facturable = 'pendiente') AS lineas_pendientes,
                    m.codigo AS maquinaria_codigo, m.tipo AS maquinaria_tipo,
                    f.id AS factura_id, f.folio AS factura_folio, f.archivo_url AS factura_url,
                    -- comprobante de pago de SU factura: solo la ruta, se cambia por URL firmada mas abajo
                    CASE WHEN f.fecha_pago IS NOT NULL THEN f.comprobante_pago_ruta END AS comprobante_url,
                    u.nombre AS mecanico_nombre,
                    -- el vehiculo de hoy del tecnico: solo de una orden abierta (en una terminada podria ser otro)
                    v.patente AS vehiculo_patente, v.marca AS vehiculo_marca, v.modelo AS vehiculo_modelo,
                    -- hora estimada de llegada: solo mientras el tecnico va en camino, como hora absoluta. Al
                    -- cliente NUNCA le llegan coordenadas (ni la posicion del tecnico ni el destino de la OT)
                    ${SQL_ETA_LLEGADA_AT} AS eta_llegada_at,
                    -- "Actualizada hace X": la hora de la ultima posicion con que se ajusto la llegada
                    -- (solo una hora, no la posicion) o, si no hubo ajuste, la de la ultima consulta de rutas
                    CASE WHEN ot.estado = 'en_camino' AND ot.eta_segundos IS NOT NULL
                         THEN COALESCE(ot.eta_ajustada_at, ot.eta_calculada_at) END AS eta_calculada_at,
                    CASE WHEN ot.estado = 'en_camino' AND ot.eta_segundos IS NOT NULL
                         THEN ot.eta_fuente IS DISTINCT FROM 'ors' END AS eta_aproximada
             FROM ordenes_trabajo ot
             JOIN maquinarias m ON m.id = ot.maquinaria_id
             LEFT JOIN facturas f ON f.orden_trabajo_id = ot.id
             -- el portal muestra quien atiende cada orden abierta, no solo las que nacieron de
             -- una asistencia pedida por el cliente
             LEFT JOIN usuarios u ON u.id = ot.mecanico_id
             LEFT JOIN vehiculos v ON v.usuario_id = ot.mecanico_id AND v.activo AND ot.estado <> 'finalizada'
             WHERE ot.cliente_id = $1
             ORDER BY ot.fecha_creacion DESC`,
        [req.user.cliente_id]
    );

    // factura_url guarda la ruta dentro del bucket privado, no una URL directa;
    // se reemplaza por una URL firmada temporal (1h) antes de responder
    const conUrlFirmada = await Promise.all(result.rows.map(async ({ facturable, lineas_pendientes: lineasPendientes, valorizacion, ...resto }) => {
        // al cliente se le dice si hay cobro, nunca montos ni la marca interna de facturable
        const fila = { ...resto, cobro: cobroParaCliente({ estado: resto.estado, facturable, lineasPendientes, valorizacion }) };
        const firmar = async (ruta) => {
            if (!ruta) return null;
            return urlFirmadaONull(supabase, BUCKET_DOCUMENTOS, ruta);
        };
        return { ...fila, factura_url: await firmar(fila.factura_url), comprobante_url: await firmar(fila.comprobante_url) };
    }));

    res.json(conUrlFirmada);
});

router.get('/:id', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const result = await pool.query(
        // factura_id y factura_folio: el panel avisa que una orden facturada no admite cambios de
        // lineas. Hay a lo mas una factura por OT (indice unico de la migracion 016).
        `SELECT ot.*, m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre, um.nombre AS mecanico_nombre,
                    f.id AS factura_id, f.folio AS factura_folio,
                    ${SQL_ETA_LLEGADA_AT} AS eta_llegada_at
             FROM ordenes_trabajo ot
             JOIN maquinarias m ON m.id = ot.maquinaria_id
             LEFT JOIN clientes c ON c.id = ot.cliente_id
             LEFT JOIN usuarios um ON um.id = ot.mecanico_id
             LEFT JOIN facturas f ON f.orden_trabajo_id = ot.id
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
        // eta_llegada_at solo para administrativo y gerente con la OT en camino (utils/etaLlegada.js)
        ...conLlegadaEstimada(sinInternosEta(orden), req.user.rol),
        servicio_ids: servicios.rows.map((s) => s.servicio_id),
        tramos: tramos.rows,
    });
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

// el mecanico toma una orden que nadie tiene asignada.
//
// Atomico: el UPDATE solo prospera si la orden sigue pendiente y sin mecanico, asi que dos
// mecanicos tomando la misma a la vez no pueden quedar los dos. El perdedor recibe 409. Un
// reintento del mismo mecanico (la respuesta se perdio) responde bien con la orden ya suya.
router.patch('/:id/tomar', verifyToken, requireRole('mecanico'), async (req, res) => {
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
        await fijarDestinoOt(client, tomada.rows[0].id);
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

// Patron Outbox (informe 6.4.2): la misma transaccion que asigna el mecanico
// inserta la notificacion pendiente (HU-07) para que nunca queden desincronizadas
router.patch('/:id/asignar', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { mecanico_id } = req.body;
    const errCuerpo = validarCuerpo(req.body, { ids: ['mecanico_id'] });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (!mecanico_id) {
        return res.status(400).json({ error: 'mecanico_id es requerido' });
    }
    let client = null;
    try {
        client = await pool.connect();
        const mecanico = await client.query('SELECT id, nombre, rut, estado_cuenta FROM usuarios WHERE id = $1 AND rol = $2', [mecanico_id, 'mecanico']);
        if (mecanico.rows.length === 0) {
            return res.status(400).json({ error: 'El usuario elegido no es un mecánico' });
        }
        if (mecanico.rows[0].estado_cuenta !== 'activo') {
            return res.status(400).json({ error: 'El mecánico está desactivado' });
        }

        await client.query('BEGIN');

        const actual = await client.query(
            'SELECT estado, mecanico_id FROM ordenes_trabajo WHERE id = $1 FOR NO KEY UPDATE',
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

        // cambio de tecnico: el viaje anterior ya no vale (se borran su posicion y su ETA, que son de
        // otra persona) y el destino se vuelve a fijar con los datos de hoy
        await limpiarViaje(client, orden.id);
        await fijarDestinoOt(client, orden.id);
        await encolarAvisoAsignacion(client, orden, mecanico.rows[0]);
        // aviso interno al mecanico nuevo y, si habia otro, al anterior ("ya no vayas"). Solo llega aca
        // si el tecnico cambio: el doble clic salio arriba sin encolar nada
        await avisarAsignacion(client, { ordenId: orden.id, nuevoId: mecanico_id, anteriorId: actual.rows[0].mecanico_id });

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

router.patch('/:id/diagnostico', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { diagnostico, estado, ocurrio_en } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { diagnostico: 20000 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    const estadosValidos = ['aceptada', 'en_camino', 'en_terreno', 'en_reparacion'];
    if (estado && !estadosValidos.includes(estado)) {
        return res.status(400).json({ error: `estado debe ser uno de: ${estadosValidos.join(', ')}` });
    }
    // hora real del toque en el telefono (la cola offline puede enviarlo mucho despues). Opcional;
    // si falta o es invalida se usa la del servidor, y nunca queda en el futuro.
    const momento = ocurrio_en && !Number.isNaN(Date.parse(ocurrio_en)) ? new Date(ocurrio_en).toISOString() : null;
    // uuid de la tarea de la cola de terreno: el APK lo manda como `uuid`; se acepta tambien `uuid_cliente`
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
        // primera llegada a trabajo (de un estado que no es de trabajo a en_terreno o en_reparacion): el
        // equipo pasa a mantencion. Ir y volver entre terreno y reparacion no lo repite.
        if (cambio === 'cambiar' && EN_CURSO.includes(estado) && !EN_CURSO.includes(check.estado)) {
            await aplicarEntradaEquipo(client, result.rows[0].maquinaria_id);
        }
        const decision = decidirEventoDiagnostico({ cambio, estadoActual: check.estado, estadoPedido: estado, uuid: uuidTarea });
        if (decision.registrar) {
            await dejarEvento(client, {
                ordenId: Number(req.params.id), tipo: 'cambio_estado', origen: 'terreno',
                estadoAnterior: check.estado, estadoNuevo: estado, usuario: req.user,
                ocurrioEn: momento, creadaEn: check.creadaEn, uuidCliente: uuidTarea,
                nacioPorSincronizacion: check.nacioPorSincronizacion, aplicado: decision.aplicado,
            });
        }

        // Posicion del mecanico (ubicacion + ETA). Solo con un cambio a 'en_camino' que SI se aplico:
        // un en_camino atrasado que llega por la cola offline (la OT ya avanzo) no debe guardar una
        // posicion vieja. Y nunca puede hacer fallar el cambio de estado: si la posicion es invalida
        // se descarta (un error aqui haria que la cola reintentara el cambio para siempre).
        let origenParaRuta = null;
        if (cambio === 'cambiar' && estado === 'en_camino' && req.body.posicion && typeof req.body.posicion === 'object') {
            await client.query('SAVEPOINT posicion');
            try {
                const guardada = await guardarPosicion(client, {
                    ordenId: Number(req.params.id), usuarioId: req.user.id,
                    posicion: { ...req.body.posicion, capturada_en: req.body.posicion.capturada_en ?? momento ?? new Date().toISOString() },
                });
                if (guardada.guardada) origenParaRuta = guardada.origen;
                await client.query('RELEASE SAVEPOINT posicion');
            } catch (errPos) {
                console.error('Posicion descartada:', errPos.message);
                await client.query('ROLLBACK TO SAVEPOINT posicion');
            }
        } else if (cambio === 'cambiar' && (estado === 'en_terreno' || estado === 'en_reparacion')) {
            // llego: la posicion y la ETA del viaje dejan de existir (privacidad del mecanico)
            await limpiarViaje(client, Number(req.params.id));
        }
        await client.query('COMMIT');
        res.json(result.rows[0]);
        // primera posicion del viaje: se pide una ruta real fuera de la respuesta (ver /posicion)
        if (origenParaRuta) {
            mejorarEtaConRutas(pool, { ordenId: Number(req.params.id), usuarioId: req.user.id, origen: origenParaRuta });
        }
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar diagnóstico' });
    } finally {
        if (client) client.release();
    }
});

// el mecanico envia su posicion mientras va en camino.
//
// Fuera de la cola offline a proposito: una posicion vieja no sirve, asi que no se reintenta ni
// lleva uuid_cliente. La idempotencia es por hora de captura (solo gana la mas nueva). Solo el
// mecanico dueno de la OT, y solo mientras esta en camino; en cualquier otro estado responde 200
// sin guardar para que la app deje de enviar sin tratarlo como error. La fila de la OT se
// bloquea con FOR UPDATE: asi una reasignacion o un cambio a en_terreno concurrente no deja una
// posicion colgada.
router.post('/:id/posicion', verifyToken, requireRole('mecanico'), async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
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
        if (check.estado !== 'en_camino') {
            await client.query('ROLLBACK');
            return res.json({ guardada: false, motivo: 'fuera_de_camino' });
        }
        const resultado = await guardarPosicion(client, {
            ordenId: Number(req.params.id), usuarioId: req.user.id, posicion: req.body,
        });
        if (!resultado.guardada && ['coordenadas_invalidas', 'hora_invalida', 'hora_futura'].includes(resultado.motivo)) {
            await client.query('ROLLBACK');
            const mensajes = {
                hora_invalida: 'capturada_en debe ser una fecha valida',
                hora_futura: 'capturada_en esta en el futuro: revise la hora del telefono',
            };
            return res.status(400).json({ error: resultado.error || mensajes[resultado.motivo] });
        }
        await client.query('COMMIT');
        res.json({ guardada: resultado.guardada, motivo: resultado.motivo || null, eta: resultado.eta || null });
        // ya respondido: una ruta real mejora la ETA aproximada. Sin await y sin lanzar nunca; si no hay
        // llave, cupo o servicio, la OT conserva la aproximada
        if (resultado.guardada) {
            mejorarEtaConRutas(pool, { ordenId: Number(req.params.id), usuarioId: req.user.id, origen: resultado.origen });
        }
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al guardar la posición' });
    } finally {
        if (client) client.release();
    }
});

// cabecera de la OT tal como esta en el talonario:
// tipo de servicio, observaciones iniciales y finales, y el folio del papel.
// `diagnostico` es la observacion INICIAL (mismo concepto, ya lo leen el portal del cliente y
// el panel); `observacion_final` es lo que se hizo.
router.patch('/:id/datos', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { tipo_servicio, diagnostico, observacion_final, folio_papel } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { diagnostico: 20000, observacion_final: 20000, folio_papel: 20 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (tipo_servicio !== undefined && tipo_servicio !== null && !TIPOS_SERVICIO.includes(tipo_servicio)) {
        return res.status(400).json({ error: `tipo_servicio debe ser uno de: ${TIPOS_SERVICIO.join(', ')}` });
    }
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
});

// sistemas donde SE INTERVINO (no una pauta de
// revision). Se envia la lista completa de ids marcados y reemplaza la anterior: es
// idempotente, que es lo que necesita la cola offline del movil ante un reintento.
router.put('/:id/checklist', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { servicio_ids } = req.body;
    if (!Array.isArray(servicio_ids)) {
        return res.status(400).json({ error: 'servicio_ids debe ser una lista' });
    }
    // sin tope, un arreglo enorme hacia un INSERT por elemento dentro de la transaccion
    if (servicio_ids.length > MAX_ELEMENTOS_CHECKLIST || !servicio_ids.every((s) => Number.isInteger(s) && s > 0 && s <= 2147483647)) {
        return res.status(400).json({ error: `servicio_ids debe ser una lista de hasta ${MAX_ELEMENTOS_CHECKLIST} ids válidos` });
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

// registrar un tramo de trabajo (inicio y termino).
// El papel trae dos bloques porque el trabajo se puede retomar en otra visita; aca son N.
router.post('/:id/tramos', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { inicio, termino } = req.body;
    if (!inicio) {
        return res.status(400).json({ error: 'inicio es requerido' });
    }
    if (fechaHoraInvalida(inicio) || (termino && fechaHoraInvalida(termino))) {
        return res.status(400).json({ error: 'inicio y termino deben ser fechas válidas' });
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

        // Cerrar un tramo: la app envia primero el tramo abierto (solo inicio) y, al terminar, el mismo inicio
        // con su termino. Si existe el tramo abierto con ese inicio, se cierra en vez de crear otro: si no,
        // quedaria abierto para siempre y duplicaria las horas de la visita.
        if (termino) {
            const cerrado = await pool.query(
                `UPDATE tramos_trabajo SET termino = $1
                 WHERE orden_trabajo_id = $2 AND usuario_id = $3 AND inicio = $4 AND termino IS NULL
                 RETURNING *`,
                [termino, req.params.id, req.user.id, inicio]
            );
            if (cerrado.rows.length > 0) return res.status(200).json(cerrado.rows[0]);

            // Reintento de ese mismo cierre: el UPDATE no guarda el uuid (la fila ya tiene el del
            // tramo abierto), asi que se reconoce por los datos. Sin esto, el reintento insertaria
            // un segundo tramo ya cerrado y duplicaria las horas de la visita.
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

// mecanico cierra la OT.
// No recibe `facturable`: en el talonario esa marca es por linea de repuesto, asi que el
// campo de la orden lo deriva insumos.js al cambiar una linea (ver utils/facturableOt.js).
router.patch('/:id/finalizar', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { persona_recibe, sin_persona, firma_path, ocurrio_en } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { persona_recibe: 1000, firma_path: 300 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    // como queda el equipo al cerrar: 'operativa' o 'fuera_de_servicio'. Ausente = APK anterior.
    const equipoPedido = validarEstadoEquipoCierre(req.body.estado_equipo);
    if (!equipoPedido.valido) {
        return res.status(400).json({ error: 'estado_equipo debe ser operativa o fuera_de_servicio' });
    }
    // hora real del cierre en el telefono (la cola offline puede enviarlo mucho despues); nunca en el futuro
    const momento = ocurrio_en && !Number.isNaN(Date.parse(ocurrio_en)) ? new Date(ocurrio_en).toISOString() : null;
    // Datos de recepcion opcionales: los APK antiguos no los envian.
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
        const actual = await client.query('SELECT * FROM ordenes_trabajo WHERE id = $1 FOR NO KEY UPDATE', [req.params.id]);
        const cierre = evaluarCierre(actual.rows[0].estado);
        if (cierre.yaFinalizada) {
            // reintento de la cola offline: la OT ya se cerro, con su firma y su aviso al
            // cliente. Sin este caso se volveria a cerrar, cambiando fecha_cierre y encolando otro aviso.
            await client.query('ROLLBACK');
            return res.json(actual.rows[0]);
        }
        if (!cierre.permitido) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: `Una orden en estado ${actual.rows[0].estado} no se puede cerrar` });
        }
        const result = await client.query(
            `UPDATE ordenes_trabajo
             SET estado = 'finalizada',
                 fecha_cierre = GREATEST(LEAST(COALESCE($2::timestamptz, now()), now()), fecha_creacion)
             WHERE id = $1 RETURNING *`,
            [req.params.id, momento]
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
        // inserta en la misma transaccion que cierra la OT. HU-07 avisa quien va a atender el equipo;
        // esto avisa que quedo listo.
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

        // una orden con repuestos facturables queda esperando que el gerente apruebe el monto. El reintento
        // de un cierre ya aplicado salio antes (yaFinalizada) y no llega aca
        if (orden.facturable === true && (orden.valorizacion === null || orden.valorizacion === undefined)) {
            await avisarPorValorizar(client, orden.id, 'Orden finalizada');
        }

        // el cierre y su evento van juntos; el reintento de un cierre ya aplicado salio antes y no
        // deja evento. La hora es la del servidor hasta que el APK mande la suya.
        // el equipo queda como diga la regla (ver utils/estadoEquipo.js); su estado anterior y nuevo van al historial
        const equipo = await aplicarCierreEquipo(client, orden.maquinaria_id, orden.id, equipoPedido.estado);
        await dejarEvento(client, {
            ordenId: orden.id, tipo: 'cierre', origen: 'terreno',
            estadoAnterior: actual.rows[0].estado, estadoNuevo: 'finalizada', usuario: req.user,
            uuidCliente: leerUuidTarea(req.body.uuid_cliente) || leerUuidTarea(req.body.uuid),
            ocurrioEn: momento, creadaEn: check.creadaEn, nacioPorSincronizacion: check.nacioPorSincronizacion,
            detalle: {
                estado_equipo_pedido: equipoPedido.estado,
                estado_equipo_anterior: equipo.anterior,
                estado_equipo_nuevo: equipo.nuevo,
            },
        });
        // la OT se cerro: no puede quedar ni la posicion del mecanico ni su ETA
        await limpiarViaje(client, orden.id);

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

router.patch('/:id/valorizacion', verifyToken, requireRole('gerente'), async (req, res) => {
    const { valorizacion } = req.body;
    if (montoEnteroONulo(valorizacion) === null) {
        return res.status(400).json({ error: 'El monto debe ser un número entero de pesos, mayor o igual a 0' });
    }
    let client = null;
    try {
        client = await pool.connect();
        // la valorizacion y su evento van en la misma transaccion; la fila se bloquea para que el
        // monto anterior que queda en el historial sea el que de verdad se reemplazo
        await client.query('BEGIN');
        const actual = await client.query(
            'SELECT estado, valorizacion FROM ordenes_trabajo WHERE id = $1 FOR NO KEY UPDATE',
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
        // una orden ya facturada no cambia de monto: el valor facturado esta en el SII (facturas.js
        // bloquea esta misma fila al subir la factura, asi que no hay carrera entre las dos)
        const facturada = await client.query('SELECT 1 FROM facturas WHERE orden_trabajo_id = $1', [req.params.id]);
        if (facturada.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'La orden ya está facturada: para cambiar el monto hay que emitir una nota de crédito' });
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

// linea de tiempo de la orden (administrativo y gerente).
// Los eventos salen en el orden en que se escribieron (id), con la creacion siempre primero.
// `ocurrio_en` es la hora que se muestra, pero no ordena: un telefono con el reloj mal daria
// cadenas "de X a Y" incoherentes. Tampoco ordena `registrado_en`, que es la hora de inicio de la
// transaccion y puede invertir dos operaciones casi simultaneas; el id sigue el orden real, porque
// cada evento se escribe con la fila de la OT bloqueada. `sincronizado_tarde` marca los que llegaron
// al servidor mas de 10 minutos despues de ocurrir, salvo los reconstruidos por la migracion (su
// registrado_en es la fecha de la migracion, no un atraso).
router.get('/:id/historial', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    if (!/^[1-9]\d{0,8}$/.test(req.params.id)) return res.status(400).json({ error: 'Id de orden inválido' });
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
});

module.exports = router;
