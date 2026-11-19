// Cierre de la orden, valorizacion e historial.
const express = require('express');
require('../../utils/asyncErrores');
const { validarIdsEnRuta, validarCuerpo } = require('../../utils/validacion');
const pool = require('../../config/db');
const { verifyToken, requireRole } = require('../../middleware/auth');
const { verificarDuenoOrden } = require('../../utils/ordenes');
const { evaluarCierre } = require('../../utils/estadosOt');
const { rutaPerteneceAOrden } = require('../../utils/rutaArchivo');
const { montoEnteroONulo } = require('../../utils/auditoriaLinea');
const { dejarEvento, leerUuidTarea, sincronizadoTarde } = require('../../utils/eventosOt');
const { avisarPorValorizar, avisarAlCliente } = require('../../utils/avisos');
const { validarEstadoEquipoCierre, aplicarCierreEquipo } = require('../../utils/estadoEquipo');
const { limpiarViaje } = require('../../utils/posicionMecanico');
const { conTransaccion } = require('../../utils/transaccion');

const router = express.Router();
validarIdsEnRuta(router, ['id']);

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
    try {
        const check = await verificarDuenoOrden(req.params.id, req.user.id, { db: pool });
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
            const actual = await client.query('SELECT * FROM ordenes_trabajo WHERE id = $1 FOR NO KEY UPDATE', [req.params.id]);
            const cierre = evaluarCierre(actual.rows[0].estado);
            if (cierre.yaFinalizada) {
                // reintento de la cola offline: la OT ya se cerro, con su firma y su aviso al
                // cliente. Sin este caso se volveria a cerrar, cambiando fecha_cierre y encolando otro aviso.
                await deshacer();
                return res.json(actual.rows[0]);
            }
            if (!cierre.permitido) {
                await deshacer();
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
            // inserta en la misma transaccion que cierra la OT. Es push a los usuarios cliente de la empresa de la
            // orden, solo con "Tu orden de trabajo finalizo" y el numero de OT (sin la observacion final).
            const orden = result.rows[0];
            await avisarAlCliente(client, { tipo: 'ot_finalizada', ordenId: orden.id, clienteId: orden.cliente_id });

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

            await confirmar();
            res.json(result.rows[0]);
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al finalizar orden de trabajo' });
    }
});

router.patch('/:id/valorizacion', verifyToken, requireRole('gerente'), async (req, res) => {
    const { valorizacion } = req.body;
    if (montoEnteroONulo(valorizacion) === null) {
        return res.status(400).json({ error: 'El monto debe ser un número entero de pesos, mayor o igual a 0' });
    }
    try {
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
            // la valorizacion y su evento van en la misma transaccion; la fila se bloquea para que el
            // monto anterior que queda en el historial sea el que de verdad se reemplazo
            const actual = await client.query(
                'SELECT estado, valorizacion FROM ordenes_trabajo WHERE id = $1 FOR NO KEY UPDATE',
                [req.params.id]
            );
            if (actual.rows.length === 0) {
                await deshacer();
                return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
            }
            // se valoriza el trabajo terminado: una OT en curso todavia puede sumar repuestos
            if (actual.rows[0].estado !== 'finalizada') {
                await deshacer();
                return res.status(409).json({ error: 'Solo se valoriza una orden ya finalizada' });
            }
            // el monto se aprueba con todos los repuestos decididos: uno en "?" (facturable 'pendiente') puede cambiar
            // lo que se cobra. Una OT finalizada ya no recibe repuestos nuevos desde la app.
            const sinDecidir = await client.query(
                `SELECT COUNT(*)::int AS n FROM movimientos_insumo
                 WHERE orden_trabajo_id = $1 AND anulada_at IS NULL AND facturable = 'pendiente'`,
                [req.params.id]
            );
            if (sinDecidir.rows[0].n > 0) {
                await deshacer();
                return res.status(409).json({
                    codigo: 'repuestos_sin_decidir',
                    repuestos_sin_decidir: sinDecidir.rows[0].n,
                    error: 'Hay repuestos sin decidir si se cobran: decide cada uno antes de aprobar la valorización',
                });
            }
            // una orden ya facturada no cambia de monto: el valor facturado esta en el SII (facturas.js
            // bloquea esta misma fila al subir la factura, asi que no hay carrera entre las dos)
            const facturada = await client.query('SELECT 1 FROM facturas WHERE orden_trabajo_id = $1', [req.params.id]);
            if (facturada.rows.length > 0) {
                await deshacer();
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
            await confirmar();
            res.json(result.rows[0]);
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al aprobar valorización' });
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
             -- orden de escritura (id): manda la llegada al servidor
             ORDER BY (e.tipo = 'creacion') DESC, e.id`,
        [req.params.id]
    );
    res.json(result.rows.map((e) => ({
        ...e,
        sincronizado_tarde: e.origen !== 'migracion' && sincronizadoTarde(e.ocurrio_en, e.registrado_en),
    })));
});

module.exports = router;
