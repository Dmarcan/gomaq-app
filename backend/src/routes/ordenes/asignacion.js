// Foto de la solicitud, tomar y asignar una orden.
const express = require('express');
require('../../utils/asyncErrores');
const { validarIdsEnRuta, validarCuerpo } = require('../../utils/validacion');
const pool = require('../../config/db');
const { verifyToken, requireRole } = require('../../middleware/auth');
const { SQL_OT_SIN_ASIGNAR } = require('../../utils/ordenes');
const { estadoTrasAsignar } = require('../../utils/estadosOt');
const { supabase, BUCKET_DOCUMENTOS } = require('../../config/supabase');
const { urlFirmadaONull } = require('../../utils/urlsFirmadas');
const { dejarEvento, decidirEventoAsignacion, esMismoTecnico } = require('../../utils/eventosOt');
const { avisarAsignacion, avisarAlCliente } = require('../../utils/avisos');
const { fijarDestinoOt } = require('../../utils/fijarDestinoOt');
const { limpiarViaje } = require('../../utils/posicionMecanico');
const { conTransaccion } = require('../../utils/transaccion');

const router = express.Router();
validarIdsEnRuta(router, ['id']);

/**
 * Avisa al cliente que su equipo tiene tecnico asignado. Lo usan /asignar (la oficina elige al mecanico) y
 * /tomar (el mecanico la toma). Va por push a los usuarios con cuenta de cliente de ESA empresa (rol cliente y
 * cliente_id de la orden) que tengan un dispositivo del panel; el mensaje es solo "Tu equipo tiene tecnico
 * asignado" y "OT #id, equipo codigo": el nombre, el RUT y el vehiculo del mecanico no salen en el push (la
 * identificacion para porteria, HU-07, queda en el detalle de la orden del portal). Sin flag no hace nada.
 */
async function encolarAvisoAsignacion(client, orden) {
    await avisarAlCliente(client, { tipo: 'mecanico_asignado', ordenId: orden.id, clienteId: orden.cliente_id });
}

// el mecanico toma una orden que nadie tiene asignada.
//
// Atomico: el UPDATE solo prospera si la orden sigue pendiente y sin mecanico, asi que dos
// mecanicos tomando la misma a la vez no pueden quedar los dos. El perdedor recibe 409. Un
// reintento del mismo mecanico (la respuesta se perdio) responde bien con la orden ya suya.
// GET /api/ordenes-trabajo/:id/foto-solicitud - la foto que el cliente adjunto al pedir la asistencia, como URL firmada
// de 1 hora. El tecnico de la orden (o cualquiera, si aun nadie la tomo, para poder decidir) y la oficina; el cliente
// no pasa por aqui. 404 si la orden no nacio de una asistencia con foto.
router.get('/:id/foto-solicitud', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const r = await pool.query(
        `SELECT ot.mecanico_id, (${SQL_OT_SIN_ASIGNAR}) AS sin_asignar, s.evidencia_url
         FROM ordenes_trabajo ot JOIN solicitudes s ON s.orden_trabajo_id = ot.id
         WHERE ot.id = $1 AND s.evidencia_url IS NOT NULL`,
        [req.params.id]
    );
    const fila = r.rows[0];
    if (!fila) return res.status(404).json({ error: 'Esta orden no tiene foto del cliente' });
    if (req.user.rol === 'mecanico' && fila.mecanico_id !== req.user.id && !fila.sin_asignar) {
        return res.status(403).json({ error: 'Esta orden está asignada a otro técnico' });
    }
    const url = await urlFirmadaONull(supabase, BUCKET_DOCUMENTOS, fila.evidencia_url);
    if (!url) return res.status(404).json({ error: 'No se pudo abrir la foto' });
    res.set('Cache-Control', 'no-store');
    res.json({ url });
});

router.patch('/:id/tomar', verifyToken, requireRole('mecanico'), async (req, res) => {
    try {
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
            const tomada = await client.query(
                `UPDATE ordenes_trabajo SET mecanico_id = $1, estado = 'asignada'
                 WHERE id = $2 AND mecanico_id IS NULL AND estado = 'pendiente'
                 RETURNING *, (SELECT codigo FROM maquinarias WHERE id = ordenes_trabajo.maquinaria_id) AS maquinaria_codigo`,
                [req.user.id, req.params.id]
            );
            if (tomada.rows.length === 0) {
                await deshacer();
                const actual = await client.query('SELECT * FROM ordenes_trabajo WHERE id = $1', [req.params.id]);
                if (actual.rows.length === 0) return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
                if (actual.rows[0].mecanico_id === req.user.id) return res.json(actual.rows[0]);
                return res.status(409).json({ error: 'Otro técnico ya tomó esta orden o ya no está disponible' });
            }
            const mecanico = await client.query('SELECT id, nombre, rut FROM usuarios WHERE id = $1', [req.user.id]);
            await fijarDestinoOt(client, tomada.rows[0].id);
            await encolarAvisoAsignacion(client, tomada.rows[0]);
            await dejarEvento(client, {
                ordenId: tomada.rows[0].id, tipo: 'toma', origen: 'terreno',
                estadoAnterior: 'pendiente', estadoNuevo: 'asignada', usuario: req.user,
                detalle: { mecanico_anterior_id: null, mecanico_nuevo_id: req.user.id },
            });
            await confirmar();
            res.json(tomada.rows[0]);
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al tomar la orden' });
    }
});

// Patron Outbox: la misma transaccion que asigna el mecanico
// inserta la notificacion pendiente (HU-07) para que nunca queden desincronizadas
router.patch('/:id/asignar', verifyToken, requireRole('administrativo'), async (req, res) => {
    const { mecanico_id } = req.body;
    const errCuerpo = validarCuerpo(req.body, { ids: ['mecanico_id'] });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (!mecanico_id) {
        return res.status(400).json({ error: 'mecanico_id es requerido' });
    }
    try {
        const mecanico = await pool.query('SELECT id, nombre, rut, estado_cuenta FROM usuarios WHERE id = $1 AND rol = $2', [mecanico_id, 'mecanico']);
        if (mecanico.rows.length === 0) {
            return res.status(400).json({ error: 'El usuario elegido no es un mecánico' });
        }
        if (mecanico.rows[0].estado_cuenta !== 'activo') {
            return res.status(400).json({ error: 'El mecánico está desactivado' });
        }
        return await conTransaccion(pool, async (client, { confirmar, deshacer }) => {

            const actual = await client.query(
                'SELECT estado, mecanico_id FROM ordenes_trabajo WHERE id = $1 FOR NO KEY UPDATE',
                [req.params.id]
            );
            if (actual.rows.length === 0) {
                await deshacer();
                return res.status(404).json({ error: 'Orden de trabajo no encontrada' });
            }
            // asignar al mismo tecnico otra vez (doble clic) no debe mandarle un segundo aviso al cliente
            const mismoTecnico = esMismoTecnico(actual.rows[0].mecanico_id, mecanico_id);
            // una OT finalizada no vuelve a "asignada"; una en curso cambia de tecnico sin retroceder
            const nuevoEstado = estadoTrasAsignar(actual.rows[0].estado, mismoTecnico);
            if (!nuevoEstado) {
                await deshacer();
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
                await confirmar();
                return res.json(orden);
            }

            // cambio de tecnico: el viaje anterior ya no vale (se borran su posicion y su ETA, que son de
            // otra persona) y el destino se vuelve a fijar con los datos de hoy
            await limpiarViaje(client, orden.id);
            await fijarDestinoOt(client, orden.id);
            await encolarAvisoAsignacion(client, orden);
            // aviso interno al mecanico nuevo y, si habia otro, al anterior ("ya no vayas"). Solo llega aca
            // si el tecnico cambio: el doble clic salio arriba sin encolar nada
            await avisarAsignacion(client, { ordenId: orden.id, nuevoId: mecanico_id, anteriorId: actual.rows[0].mecanico_id });

            await confirmar();
            res.json(orden);
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al asignar mecánico' });
    }
});

module.exports = router;
