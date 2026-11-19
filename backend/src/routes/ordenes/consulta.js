// Alta, listados y detalle de las ordenes de trabajo.
const express = require('express');
require('../../utils/asyncErrores');
const { validarIdsEnRuta, validarCuerpo } = require('../../utils/validacion');
const pool = require('../../config/db');
const { verifyToken, requireRole } = require('../../middleware/auth');
const { SQL_OT_SIN_ASIGNAR } = require('../../utils/ordenes');
const { cobroParaCliente } = require('../../utils/cobroCliente');
const { armarDetalleOtCliente } = require('../../utils/detalleOtCliente');
const { parsearEstados, EN_CURSO_PANEL, ESTADOS } = require('../../utils/estadosOt');
const { supabase, BUCKET, BUCKET_DOCUMENTOS } = require('../../config/supabase');
const { urlFirmadaONull } = require('../../utils/urlsFirmadas');
const { parsearPaginacion, parsearBusqueda, envolver } = require('../../utils/paginacion');
const { leerUuidCliente, buscarPorUuid, esUuidDuplicado } = require('../../utils/idempotencia');
const { dejarEvento } = require('../../utils/eventosOt');
const { avisarOtDisponible } = require('../../utils/avisos');
const { aplicarEntradaEquipo, origenDeCliente } = require('../../utils/estadoEquipo');
const { fijarDestinoOt } = require('../../utils/fijarDestinoOt');
const { SQL_ETA_LLEGADA_AT, conLlegadaEstimada } = require('../../utils/etaLlegada');
const { conTransaccion } = require('../../utils/transaccion');
const { sinInternosEta } = require('./comun');

const router = express.Router();
validarIdsEnRuta(router, ['id']);

router.post('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { maquinaria_id, cliente_id, motivo } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { motivo: 2000 }, ids: ['maquinaria_id', 'cliente_id'] });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (!maquinaria_id) {
        return res.status(400).json({ error: 'maquinaria_id es requerido' });
    }
    try {
        // El cliente de la orden es quien tiene el equipo AHORA, y la base ya lo sabe: no hay que
        // preguntarlo. Se copia a la orden (no se deriva despues) porque maquinarias.cliente_id
        // se pone en NULL al recibir el equipo de vuelta, y la orden tiene que seguir diciendo
        // de quien era. Es lo mismo que hace la OT que abre el mecanico en terreno. Un
        // cliente_id explicito se respeta, para quien llame a la API con otro criterio.
        const equipo = await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [maquinaria_id]);
        if (equipo.rows.length === 0) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }
        // facturable nace en false: se deriva de las lineas de repuesto de la OT (ver utils/facturableOt.js),
        // como en el talonario de papel.
        // La OT y su evento de creacion van en la misma transaccion (historial, migracion 020).
        await conTransaccion(pool, async (client, { confirmar }) => {
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
            // nace sin tecnico: se avisa a los mecanicos libres (con el flag de push apagado no hace nada)
            await avisarOtDisponible(client, orden.id);
            await confirmar();
            res.status(201).json(orden);
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear orden de trabajo' });
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
    try {
        const yaCreada = await buscarPorUuid(pool, 'ordenes_trabajo', uuid);
        if (yaCreada) return devolverExistente(yaCreada);
        // la OT y su evento de creacion van en la misma transaccion (historial, migracion 020)
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
            // El equipo se bloquea ANTES de insertar la OT: el INSERT toma KEY SHARE sobre el equipo por la
            // clave foranea y aplicarEntradaEquipo pide despues el bloqueo del mismo equipo; con dos
            // mecanicos abriendo OT sobre el mismo equipo a la vez, cada uno esperaba al otro (deadlock).
            // Ademas el cliente de la OT se lee ya con el equipo bloqueado, no antes.
            const maquinaria = await client.query('SELECT id, cliente_id FROM maquinarias WHERE id = $1 FOR NO KEY UPDATE', [maquinaria_id]);
            if (maquinaria.rows.length === 0) {
                await deshacer();
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
            await confirmar();
            res.status(201).json(orden);
        });
    } catch (err) {
        if (esUuidDuplicado(err)) {
            // otro reintento gano la carrera: se devuelve su OT. Si esta consulta tambien falla, el
            // error no puede quedar sin manejar (Express 4 no captura el rechazo): cae al 500 de abajo.
            try {
                const existente = await buscarPorUuid(pool, 'ordenes_trabajo', uuid);
                if (existente) return devolverExistente(existente);
            } catch (errBusqueda) {
                console.error(errBusqueda);
            }
        }
        console.error(err);
        res.status(500).json({ error: 'Error al crear la orden de trabajo en terreno' });
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
    let sql = `SELECT ot.*, m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre, um.nombre AS mecanico_nombre,
                   (SELECT e.rol FROM ordenes_eventos e WHERE e.orden_trabajo_id = ot.id AND e.tipo = 'creacion' ORDER BY e.id LIMIT 1) AS creada_por_rol
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

// GET /api/ordenes-trabajo/mias/:id - el detalle de una orden del cliente para el historial del portal:
// linea de tiempo, motivo, diagnostico, observacion final y fotos antes/despues. Va antes de /:id.
// El cliente_id sale siempre del token: una orden de otra empresa responde 404 igual que una que no existe.
// No lleva factura ni la foto de la solicitud, y nunca montos ni coordenadas (utils/detalleOtCliente.js).
router.get('/mias/:id', verifyToken, requireRole('cliente'), async (req, res) => {
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Tu cuenta no está vinculada a ninguna empresa. Pide a GOMAQ que la vincule' });
    }
    res.set('Cache-Control', 'no-store');
    const ot = await pool.query(
        `SELECT ot.id, ot.estado, ot.motivo, ot.diagnostico, ot.observacion_final, ot.fecha_creacion, ot.fecha_cierre,
                ot.facturable, ot.valorizacion,
                (SELECT COUNT(*)::int FROM movimientos_insumo mi
                 WHERE mi.orden_trabajo_id = ot.id AND mi.anulada_at IS NULL AND mi.facturable = 'pendiente') AS lineas_pendientes,
                m.codigo AS maquinaria_codigo, m.tipo AS maquinaria_tipo,
                u.nombre AS mecanico_nombre
         FROM ordenes_trabajo ot
         JOIN maquinarias m ON m.id = ot.maquinaria_id
         LEFT JOIN usuarios u ON u.id = ot.mecanico_id
         WHERE ot.id = $1 AND ot.cliente_id = $2`,
        [req.params.id, req.user.cliente_id]
    );
    const orden = ot.rows[0];
    if (!orden) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });

    // solo las columnas que la linea de tiempo necesita: nunca detalle, usuario_id ni origen
    const [eventos, evidencias] = await Promise.all([
        pool.query(
            `SELECT tipo, estado_anterior, estado_nuevo, rol, ocurrio_en, registrado_en, aplicado, hora_dudosa
             FROM ordenes_eventos WHERE orden_trabajo_id = $1
             ORDER BY (tipo = 'creacion') DESC, id`,
            [orden.id]
        ),
        pool.query(
            'SELECT id, tipo, path, created_at FROM evidencias_fotograficas WHERE orden_trabajo_id = $1 ORDER BY created_at',
            [orden.id]
        ),
    ]);
    const fotos = await Promise.all(evidencias.rows.map(async (f) => ({
        id: f.id, tipo: f.tipo, created_at: f.created_at, url: await urlFirmadaONull(supabase, BUCKET, f.path),
    })));

    res.json(armarDetalleOtCliente({ orden, eventos: eventos.rows, fotos }));
});

router.get('/:id', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const result = await pool.query(
        // factura_id y factura_folio: el panel avisa que una orden facturada no admite cambios de
        // lineas. Hay a lo mas una factura por OT (indice unico de la migracion 016).
        `SELECT ot.*, m.codigo AS maquinaria_codigo, c.nombre AS cliente_nombre, um.nombre AS mecanico_nombre,
                    (SELECT e.rol FROM ordenes_eventos e WHERE e.orden_trabajo_id = ot.id AND e.tipo = 'creacion' ORDER BY e.id LIMIT 1) AS creada_por_rol,
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

module.exports = router;
