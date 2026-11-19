// Trabajo en terreno: diagnostico, posicion, datos, checklist y tramos.
const express = require('express');
require('../../utils/asyncErrores');
const { validarIdsEnRuta, validarCuerpo, fechaHoraInvalida } = require('../../utils/validacion');
const pool = require('../../config/db');
const { verifyToken, requireRole } = require('../../middleware/auth');
const { verificarDuenoOrden, MENSAJE_OT_CERRADA } = require('../../utils/ordenes');
const { evaluarCambioEstado } = require('../../utils/estadosOt');
const { leerUuidCliente, buscarPorUuid, esUuidDuplicado } = require('../../utils/idempotencia');
const { dejarEvento, leerUuidTarea, decidirEventoDiagnostico } = require('../../utils/eventosOt');
const { aplicarEntradaEquipo } = require('../../utils/estadoEquipo');
const { EN_CURSO } = require('../../utils/estadosOt');
const { guardarPosicion, limpiarViaje } = require('../../utils/posicionMecanico');
const { mejorarEtaConRutas } = require('../../services/rutasEta');
const { conTransaccion } = require('../../utils/transaccion');
const { MAX_ELEMENTOS_CHECKLIST, TIPOS_SERVICIO } = require('./comun');

const router = express.Router();
validarIdsEnRuta(router, ['id']);

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
    try {
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
            // el estado se lee bloqueando la fila: el evento del historial tiene que decir de que
            // estado se partio, y eso no puede cambiar entre la lectura y el UPDATE
            const check = await verificarDuenoOrden(req.params.id, req.user.id, { db: client, bloquear: true });
            if (!check.existe) {
                await deshacer();
                return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
            }
            if (!check.esDueno) {
                await deshacer();
                return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
            }
            if (!check.editable) {
                await deshacer();
                return res.status(409).json({ error: MENSAJE_OT_CERRADA });
            }
            const cambio = estado ? evaluarCambioEstado(check.estado, estado) : 'sin_cambio';
            if (cambio === 'rechazar') {
                await deshacer();
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
                await deshacer();
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
            await confirmar();
            res.json(result.rows[0]);
            // primera posicion del viaje: se pide una ruta real fuera de la respuesta (ver /posicion)
            if (origenParaRuta) {
                mejorarEtaConRutas(pool, { ordenId: Number(req.params.id), usuarioId: req.user.id, origen: origenParaRuta });
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar diagnóstico' });
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
    try {
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
            const check = await verificarDuenoOrden(req.params.id, req.user.id, { db: client, bloquear: true });
            if (!check.existe) {
                await deshacer();
                return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
            }
            if (!check.esDueno) {
                await deshacer();
                return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
            }
            if (check.estado !== 'en_camino') {
                await deshacer();
                return res.json({ guardada: false, motivo: 'fuera_de_camino' });
            }
            const resultado = await guardarPosicion(client, {
                ordenId: Number(req.params.id), usuarioId: req.user.id, posicion: req.body,
            });
            if (!resultado.guardada && ['coordenadas_invalidas', 'hora_invalida', 'hora_futura'].includes(resultado.motivo)) {
                await deshacer();
                const mensajes = {
                    hora_invalida: 'capturada_en debe ser una fecha valida',
                    hora_futura: 'capturada_en esta en el futuro: revise la hora del telefono',
                };
                return res.status(400).json({ error: resultado.error || mensajes[resultado.motivo] });
            }
            await confirmar();
            res.json({ guardada: resultado.guardada, motivo: resultado.motivo || null, eta: resultado.eta || null });
            // ya respondido: una ruta real mejora la ETA aproximada. Sin await y sin lanzar nunca; si no hay
            // llave, cupo o servicio, la OT conserva la aproximada
            if (resultado.guardada) {
                mejorarEtaConRutas(pool, { ordenId: Number(req.params.id), usuarioId: req.user.id, origen: resultado.origen });
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al guardar la posición' });
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
    try {
        const check = await verificarDuenoOrden(req.params.id, req.user.id, { db: pool });
        if (!check.existe) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
        if (!check.esDueno) return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
        if (!check.editable) return res.status(409).json({ error: MENSAJE_OT_CERRADA });
        await conTransaccion(pool, async (client, { confirmar }) => {
            await client.query('DELETE FROM ot_servicios WHERE orden_trabajo_id = $1', [req.params.id]);
            for (const servicioId of servicio_ids) {
                await client.query(
                    `INSERT INTO ot_servicios (orden_trabajo_id, servicio_id) VALUES ($1, $2)
                     ON CONFLICT (orden_trabajo_id, servicio_id) DO NOTHING`,
                    [req.params.id, servicioId]
                );
            }
            await confirmar();
            res.json({ orden_trabajo_id: Number(req.params.id), servicio_ids });
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al guardar el checklist' });
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

module.exports = router;
