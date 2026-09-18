const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { verificarDuenoOrden, contactoCliente, MENSAJE_OT_CERRADA } = require('../utils/ordenes');
const { estadoTrasAsignar, puedeCambiarEstadoA, evaluarCierre } = require('../utils/estadosOt');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { parsearPaginacion, parsearBusqueda, envolver } = require('../utils/paginacion');
const { leerUuidCliente, buscarPorUuid, esUuidDuplicado } = require('../utils/idempotencia');
const { rutaPerteneceAOrden } = require('../utils/rutaArchivo');

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
    try {
        // facturable nace en false y ya no lo decide nadie a mano: se deriva de las lineas
        // de repuesto de la OT (ver utils/facturableOt.js), como en el talonario de papel
        const result = await pool.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, origen, motivo)
             VALUES ($1, $2, COALESCE($3::origen_orden, 'directo'), $4)
             RETURNING *`,
            [maquinaria_id, cliente_id || null, origen || null, motivo || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear orden de trabajo' });
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
    try {
        const yaCreada = await buscarPorUuid(pool, 'ordenes_trabajo', uuid);
        if (yaCreada) return devolverExistente(yaCreada);

        const maquinaria = await pool.query('SELECT id, cliente_id FROM maquinarias WHERE id = $1', [maquinaria_id]);
        if (maquinaria.rows.length === 0) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }
        const result = await pool.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, mecanico_id, origen, motivo, estado, uuid_cliente)
             VALUES ($1, $2, $3, 'directo', $4, 'en_terreno', $5)
             RETURNING *`,
            [maquinaria_id, maquinaria.rows[0].cliente_id, req.user.id, motivo || 'Equipo intervenido durante otra visita', uuid]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (esUuidDuplicado(err)) {
            const existente = await buscarPorUuid(pool, 'ordenes_trabajo', uuid);
            if (existente) return devolverExistente(existente);
        }
        console.error(err);
        res.status(500).json({ error: 'Error al crear la orden de trabajo en terreno' });
    }
});

// GET /api/ordenes-trabajo - listar (mecanico solo ve las suyas)
router.get('/', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const { limit, offset } = parsearPaginacion(req.query);
    const q = parsearBusqueda(req.query);
    try {
        const condiciones = [];
        const params = [];
        if (req.user.rol === 'mecanico') {
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
        res.status(500).json({ error: 'Error al consultar ordenes de trabajo' });
    }
});

// GET /api/ordenes-trabajo/mias - portal cliente: su historial de OT con facturas vinculadas
router.get('/mias', verifyToken, requireRole('cliente'), async (req, res) => {
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Su usuario no esta vinculado a ninguna empresa cliente' });
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
        res.status(500).json({ error: 'Error al consultar su historial' });
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
            return res.status(403).json({ error: 'No tiene permiso para ver esta orden' });
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

// PATCH /api/ordenes-trabajo/:id/asignar - asignar mecanico
// Patron Outbox (informe 6.4.2): la misma transaccion que asigna el mecanico
// inserta la notificacion pendiente (HU-07) para que nunca queden desincronizadas
router.patch('/:id/asignar', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { mecanico_id } = req.body;
    if (!mecanico_id) {
        return res.status(400).json({ error: 'mecanico_id es requerido' });
    }
    const client = await pool.connect();
    try {
        const mecanico = await client.query('SELECT id, nombre, rut FROM usuarios WHERE id = $1 AND rol = $2', [mecanico_id, 'mecanico']);
        if (mecanico.rows.length === 0) {
            return res.status(400).json({ error: 'mecanico_id no corresponde a un usuario con rol mecanico' });
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
        // una OT finalizada no vuelve a "asignada"; una en curso cambia de tecnico sin retroceder
        const nuevoEstado = estadoTrasAsignar(actual.rows[0].estado);
        if (!nuevoEstado) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'La orden ya esta finalizada y no se puede reasignar' });
        }
        // asignar al mismo tecnico otra vez (doble clic) no debe mandarle un segundo aviso al cliente
        const mismoTecnico = actual.rows[0].mecanico_id === Number(mecanico_id);

        const otResult = await client.query(
            `UPDATE ordenes_trabajo SET mecanico_id = $1, estado = $2 WHERE id = $3
             RETURNING *, (SELECT codigo FROM maquinarias WHERE id = ordenes_trabajo.maquinaria_id) AS maquinaria_codigo`,
            [mecanico_id, nuevoEstado, req.params.id]
        );
        const orden = otResult.rows[0];
        if (mismoTecnico) {
            await client.query('COMMIT');
            return res.json(orden);
        }

        const contacto = await contactoCliente(client, orden.cliente_id);
        if (contacto) {
            // HU-07 promete avisar "quien llega a reparar su equipo Y CON QUE VEHICULO":
            // el vehiculo y el RUT permiten que porteria reconozca el furgon y valide al
            // tecnico al ingresar a la planta.
            const vehiculo = await client.query(
                'SELECT marca, modelo, patente FROM vehiculos WHERE usuario_id = $1 AND activo = true',
                [mecanico_id]
            );
            await client.query(
                `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ($1, $2, $3)`,
                [contacto.canal, contacto.destinatario, JSON.stringify({
                    tipo: 'mecanico_asignado',
                    orden_trabajo_id: orden.id,
                    maquinaria_codigo: orden.maquinaria_codigo,
                    mecanico_nombre: mecanico.rows[0].nombre,
                    mecanico_rut: mecanico.rows[0].rut,
                    vehiculo: vehiculo.rows[0] || null,
                })]
            );
        }

        await client.query('COMMIT');
        res.json(orden);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al asignar mecanico' });
    } finally {
        client.release();
    }
});

// PATCH /api/ordenes-trabajo/:id/diagnostico - mecanico registra diagnostico y avanza estado
router.patch('/:id/diagnostico', verifyToken, requireRole('mecanico'), async (req, res) => {
    const { diagnostico, estado } = req.body;
    const estadosValidos = ['en_terreno', 'en_reparacion'];
    if (estado && !estadosValidos.includes(estado)) {
        return res.status(400).json({ error: `estado debe ser uno de: ${estadosValidos.join(', ')}` });
    }
    try {
        const check = await verificarDuenoOrden(req.params.id, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });
        if (!check.editable) return res.status(409).json({ error: MENSAJE_OT_CERRADA });
        if (estado && !puedeCambiarEstadoA(check.estado, estado)) {
            return res.status(409).json({ error: `La orden no puede pasar de ${check.estado} a ${estado}` });
        }

        // la condicion sobre el estado cubre que la OT se cierre entre la verificacion y el UPDATE
        const result = await pool.query(
            `UPDATE ordenes_trabajo
             SET diagnostico = COALESCE($1, diagnostico), estado = COALESCE($2, estado)
             WHERE id = $3 AND estado <> 'finalizada' RETURNING *`,
            [diagnostico || null, estado || null, req.params.id]
        );
        if (result.rows.length === 0) return res.status(409).json({ error: MENSAJE_OT_CERRADA });
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar diagnostico' });
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
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });
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
    const client = await pool.connect();
    try {
        const check = await verificarDuenoOrden(req.params.id, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });
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
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al guardar el checklist' });
    } finally {
        client.release();
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
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });
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
    const client = await pool.connect();
    try {
        const check = await verificarDuenoOrden(req.params.id, req.user.id);
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden no esta asignada a usted' });

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

        await client.query('COMMIT');
        res.json(result.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al finalizar orden de trabajo' });
    } finally {
        client.release();
    }
});

// PATCH /api/ordenes-trabajo/:id/valorizacion - gerente aprueba monto (HU-04)
router.patch('/:id/valorizacion', verifyToken, requireRole('gerente'), async (req, res) => {
    const { valorizacion } = req.body;
    if (valorizacion === undefined || valorizacion === null || valorizacion === '' || isNaN(valorizacion)
        || Number(valorizacion) < 0) {
        return res.status(400).json({ error: 'valorizacion debe ser un monto mayor o igual a 0' });
    }
    try {
        const actual = await pool.query('SELECT estado FROM ordenes_trabajo WHERE id = $1', [req.params.id]);
        if (actual.rows.length === 0) {
            return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        }
        // se valoriza el trabajo terminado: una OT en curso todavia puede sumar repuestos
        if (actual.rows[0].estado !== 'finalizada') {
            return res.status(409).json({ error: 'Solo se valoriza una orden ya finalizada' });
        }
        // facturable NO se toca aca: se deriva de las lineas de repuesto (utils/facturableOt.js)
        const result = await pool.query(
            `UPDATE ordenes_trabajo
             SET valorizacion = $1, valorizacion_aprobada_por = $2
             WHERE id = $3 RETURNING *`,
            [valorizacion, req.user.id, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al aprobar valorizacion' });
    }
});

module.exports = router;
