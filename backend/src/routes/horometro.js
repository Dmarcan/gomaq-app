const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { calcularEstadoMantencion, requiereAviso, HORAS_AVISO_MANTENCION } = require('../utils/mantencion');
const { leerUuidCliente, buscarPorUuid, esUuidDuplicado } = require('../utils/idempotencia');

const router = express.Router();

// Postgres devuelve NUMERIC como string (mismo caso que el COUNT(*) del dashboard):
// sin esto las horas se concatenarian en vez de restarse.
const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Encola el aviso de mantencion proxima siguiendo el patron Outbox (informe 6.4.2): la
 * notificacion se inserta en la MISMA transaccion que la lectura, para que no queden
 * desincronizadas si el proceso muere entre medio.
 *
 * Se manda una sola vez por ciclo (marca alerta_mantencion_enviada, que se apaga al
 * reiniciar el contador): si no, cada lectura nueva sobre el umbral repetiria el mensaje.
 *
 * Destinatarios: los usuarios internos con el switch encendido desde el panel. El envio real
 * todavia no existe (el worker es un stub), asi que estas filas quedaran en error tras los
 * reintentos hasta que se configure WhatsApp Cloud API / SMTP.
 */
async function encolarAvisoMantencion(client, maquinaria, estado) {
    const destinatarios = await client.query(
        `SELECT email, telefono_whatsapp FROM usuarios
         WHERE recibe_alertas_mantencion = true AND estado_cuenta = 'activo'`
    );
    if (destinatarios.rows.length === 0) return 0;

    const payload = {
        tipo: 'mantencion_proxima',
        maquinaria_id: maquinaria.id,
        maquinaria_codigo: maquinaria.codigo,
        horas_usadas: estado.horas_usadas,
        horas_restantes: estado.horas_restantes,
        intervalo_horas: num(maquinaria.intervalo_mantencion_horas),
        vencida: estado.vencida,
    };

    let encoladas = 0;
    for (const usuario of destinatarios.rows) {
        if (usuario.email) {
            await client.query(
                `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', $1, $2)`,
                [usuario.email, JSON.stringify(payload)]
            );
            encoladas++;
        }
        if (usuario.telefono_whatsapp) {
            await client.query(
                `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('whatsapp', $1, $2)`,
                [usuario.telefono_whatsapp, JSON.stringify(payload)]
            );
            encoladas++;
        }
    }

    await client.query('UPDATE maquinarias SET alerta_mantencion_enviada = true WHERE id = $1', [maquinaria.id]);
    return encoladas;
}

// POST /api/horometro/maquinaria/:id - registrar una lectura.
// El origen se deriva del rol y no se acepta del cliente: la app del mecanico es 'movil',
// el panel es 'panel', y 'guia' lo escribe internamente la subida de la guia de despacho.
router.post('/maquinaria/:id', verifyToken, requireRole('mecanico', 'administrativo', 'gerente'), async (req, res) => {
    const { id } = req.params;
    const { valor, orden_trabajo_id, observacion, reiniciar_contador } = req.body;

    const lectura = Number(valor);
    if (valor === undefined || valor === null || valor === '' || isNaN(lectura) || lectura < 0) {
        return res.status(400).json({ error: 'valor debe ser un numero de horas mayor o igual a 0' });
    }
    const { valido: uuidValido, uuid } = leerUuidCliente(req.body);
    if (!uuidValido) {
        return res.status(400).json({ error: 'uuid_cliente no es un UUID valido' });
    }

    // Reintento de una lectura ya guardada desde el movil: no se repite ni el reinicio del
    // contador ni el aviso de mantencion, que ya ocurrieron con la primera.
    const responderExistente = (existente) => res.status(200).json({
        lectura: existente,
        estado_mantencion: null,
        contador_reiniciado: false,
        avisos_encolados: 0,
        ya_registrada: true,
    });
    const yaRegistrada = await buscarPorUuid(pool, 'lecturas_horometro', uuid);
    if (yaRegistrada) return responderExistente(yaRegistrada);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const maquinariaResult = await client.query(
            `SELECT id, codigo, cliente_id, intervalo_mantencion_horas, horometro_ultima_mantencion,
                    alerta_mantencion_enviada
             FROM maquinarias WHERE id = $1 FOR UPDATE`,
            [id]
        );
        const maquinaria = maquinariaResult.rows[0];
        if (!maquinaria) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }

        // un mecanico solo puede registrar sobre un equipo de una OT suya, igual que en el
        // resto de su flujo (no tiene visibilidad de la flota completa)
        if (req.user.rol === 'mecanico') {
            const suya = await client.query(
                `SELECT 1 FROM ordenes_trabajo WHERE maquinaria_id = $1 AND mecanico_id = $2 LIMIT 1`,
                [id, req.user.id]
            );
            if (suya.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'No tiene una orden de trabajo para este equipo' });
            }
        }

        const origen = req.user.rol === 'mecanico' ? 'movil' : 'panel';
        const insercion = await client.query(
            `INSERT INTO lecturas_horometro
                (maquinaria_id, valor, origen, cliente_id, orden_trabajo_id, usuario_id, observacion, uuid_cliente)
             VALUES ($1, $2, $3::origen_lectura_horometro, $4, $5, $6, $7, $8)
             RETURNING *`,
            [id, lectura, origen, maquinaria.cliente_id, orden_trabajo_id || null, req.user.id, observacion || null, uuid]
        );

        // el reinicio es una confirmacion explicita de quien cierra la mantencion, no algo
        // que el sistema deduzca: la lectura de este momento pasa a ser la base del ciclo
        let reiniciado = false;
        if (reiniciar_contador === true || reiniciar_contador === 'true') {
            await client.query(
                `UPDATE maquinarias
                 SET horometro_ultima_mantencion = $1, alerta_mantencion_enviada = false
                 WHERE id = $2`,
                [lectura, id]
            );
            maquinaria.horometro_ultima_mantencion = lectura;
            maquinaria.alerta_mantencion_enviada = false;
            reiniciado = true;
        }

        const estado = calcularEstadoMantencion({
            ultimaLectura: lectura,
            horometroUltimaMantencion: num(maquinaria.horometro_ultima_mantencion),
            intervaloHoras: num(maquinaria.intervalo_mantencion_horas),
        });

        let avisosEncolados = 0;
        if (requiereAviso(estado) && !maquinaria.alerta_mantencion_enviada) {
            avisosEncolados = await encolarAvisoMantencion(client, maquinaria, estado);
        }

        await client.query('COMMIT');
        res.status(201).json({
            lectura: insercion.rows[0],
            estado_mantencion: estado,
            contador_reiniciado: reiniciado,
            avisos_encolados: avisosEncolados,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        if (esUuidDuplicado(err)) {
            const existente = await buscarPorUuid(pool, 'lecturas_horometro', uuid);
            if (existente) return responderExistente(existente);
        }
        console.error(err);
        res.status(500).json({ error: 'Error al registrar la lectura de horometro' });
    } finally {
        client.release();
    }
});

// GET /api/horometro/maquinaria/:id - historial de lecturas + estado de mantencion.
// El historial trae el cliente de cada lectura (snapshot), que es lo que permite ver
// "donde estuvo el equipo y cuanto se uso en cada lugar" (entrevista el jefe de taller).
router.get('/maquinaria/:id', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const { id } = req.params;
    try {
        const maquinariaResult = await pool.query(
            `SELECT id, codigo, tipo, intervalo_mantencion_horas, horometro_ultima_mantencion
             FROM maquinarias WHERE id = $1`,
            [id]
        );
        const maquinaria = maquinariaResult.rows[0];
        if (!maquinaria) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }

        const lecturas = await pool.query(
            `SELECT l.id, l.valor, l.origen, l.fecha, l.observacion,
                    c.nombre AS cliente_nombre, u.nombre AS usuario_nombre
             FROM lecturas_horometro l
             LEFT JOIN clientes c ON c.id = l.cliente_id
             LEFT JOIN usuarios u ON u.id = l.usuario_id
             WHERE l.maquinaria_id = $1
             ORDER BY l.fecha DESC`,
            [id]
        );

        const ultima = lecturas.rows[0] ? num(lecturas.rows[0].valor) : null;
        res.json({
            maquinaria: {
                id: maquinaria.id,
                codigo: maquinaria.codigo,
                tipo: maquinaria.tipo,
                intervalo_mantencion_horas: num(maquinaria.intervalo_mantencion_horas),
                horometro_ultima_mantencion: num(maquinaria.horometro_ultima_mantencion),
            },
            ultima_lectura: ultima,
            estado_mantencion: calcularEstadoMantencion({
                ultimaLectura: ultima,
                horometroUltimaMantencion: num(maquinaria.horometro_ultima_mantencion),
                intervaloHoras: num(maquinaria.intervalo_mantencion_horas),
            }),
            lecturas: lecturas.rows.map((l) => ({ ...l, valor: num(l.valor) })),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar el historial de horometro' });
    }
});

// GET /api/horometro/pendientes - agenda del mes: equipos arrendados a los que todavia no se
// les toma el horometro este mes. Al registrar la lectura, el equipo sale solo de la lista.
//
// PENDIENTE DE CONFIRMAR CON GOMAQ: por ahora solo entran los equipos arrendados, porque son
// los que acumulan horas de uso; falta confirmar si tambien quieren medir los que estan en
// taller o en patio.
router.get('/pendientes', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT m.id, m.codigo, m.tipo, m.ubicacion, c.nombre AS cliente_nombre,
                    u.valor AS ultima_lectura, u.fecha AS ultima_fecha
             FROM maquinarias m
             JOIN clientes c ON c.id = m.cliente_id
             LEFT JOIN LATERAL (
                 SELECT valor, fecha FROM lecturas_horometro l
                 WHERE l.maquinaria_id = m.id ORDER BY l.fecha DESC LIMIT 1
             ) u ON true
             WHERE m.cliente_id IS NOT NULL
               AND m.estado <> 'fuera_de_servicio'
               AND NOT EXISTS (
                   SELECT 1 FROM lecturas_horometro l2
                   WHERE l2.maquinaria_id = m.id
                     AND date_trunc('month', l2.fecha) = date_trunc('month', now())
               )
             ORDER BY c.nombre, m.codigo`
        );
        res.json(result.rows.map((f) => ({ ...f, ultima_lectura: num(f.ultima_lectura) })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar los equipos pendientes de medicion' });
    }
});

// GET /api/horometro/alertas - equipos que ya cumplieron el intervalo o estan por cumplirlo
router.get('/alertas', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT m.id, m.codigo, m.tipo, m.intervalo_mantencion_horas, m.horometro_ultima_mantencion,
                    c.nombre AS cliente_nombre, u.valor AS ultima_lectura, u.fecha AS ultima_fecha
             FROM maquinarias m
             LEFT JOIN clientes c ON c.id = m.cliente_id
             JOIN LATERAL (
                 SELECT valor, fecha FROM lecturas_horometro l
                 WHERE l.maquinaria_id = m.id ORDER BY l.fecha DESC LIMIT 1
             ) u ON true
             WHERE m.estado <> 'fuera_de_servicio'`
        );

        const equipos = result.rows
            .map((fila) => {
                const estado = calcularEstadoMantencion({
                    ultimaLectura: num(fila.ultima_lectura),
                    horometroUltimaMantencion: num(fila.horometro_ultima_mantencion),
                    intervaloHoras: num(fila.intervalo_mantencion_horas),
                });
                return {
                    id: fila.id,
                    codigo: fila.codigo,
                    tipo: fila.tipo,
                    cliente_nombre: fila.cliente_nombre,
                    ultima_lectura: num(fila.ultima_lectura),
                    ultima_fecha: fila.ultima_fecha,
                    intervalo_mantencion_horas: num(fila.intervalo_mantencion_horas),
                    ...estado,
                };
            })
            .filter((e) => requiereAviso(e))
            // primero lo mas urgente: las vencidas (horas_restantes negativas) arriba
            .sort((a, b) => a.horas_restantes - b.horas_restantes);

        res.json({ horas_aviso: HORAS_AVISO_MANTENCION, equipos });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar las alertas de mantencion' });
    }
});

// POST /api/horometro/maquinaria/:id/reiniciar - marcar la mantencion como hecha desde el panel.
// Complementa la confirmacion que hace el mecanico al cerrar la OT: sirve para corregir un
// reinicio mal puesto y para cargar mantenciones anteriores al sistema.
router.post('/maquinaria/:id/reiniciar', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { id } = req.params;
    const { valor } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const maquinariaResult = await client.query(
            'SELECT id, cliente_id FROM maquinarias WHERE id = $1 FOR UPDATE',
            [id]
        );
        if (maquinariaResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }

        // si no se indica horometro se usa la ultima lectura conocida del equipo
        let base = valor === undefined || valor === null || valor === '' ? null : Number(valor);
        if (base !== null && (isNaN(base) || base < 0)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'valor debe ser un numero de horas mayor o igual a 0' });
        }
        if (base === null) {
            const ultima = await client.query(
                'SELECT valor FROM lecturas_horometro WHERE maquinaria_id = $1 ORDER BY fecha DESC LIMIT 1',
                [id]
            );
            if (ultima.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'El equipo no tiene lecturas: indique el horometro de la mantencion' });
            }
            base = num(ultima.rows[0].valor);
        } else {
            // un reinicio con horometro indicado tambien deja constancia como lectura, para
            // que el historial no muestre un salto sin origen
            await client.query(
                `INSERT INTO lecturas_horometro (maquinaria_id, valor, origen, cliente_id, usuario_id, observacion)
                 VALUES ($1, $2, 'panel', $3, $4, 'Mantencion preventiva registrada desde el panel')`,
                [id, base, maquinariaResult.rows[0].cliente_id, req.user.id]
            );
        }

        const actualizada = await client.query(
            `UPDATE maquinarias
             SET horometro_ultima_mantencion = $1, alerta_mantencion_enviada = false
             WHERE id = $2
             RETURNING id, codigo, intervalo_mantencion_horas, horometro_ultima_mantencion`,
            [base, id]
        );

        await client.query('COMMIT');
        res.json({
            ...actualizada.rows[0],
            intervalo_mantencion_horas: num(actualizada.rows[0].intervalo_mantencion_horas),
            horometro_ultima_mantencion: num(actualizada.rows[0].horometro_ultima_mantencion),
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al reiniciar el contador de mantencion' });
    } finally {
        client.release();
    }
});

// PATCH /api/horometro/maquinaria/:id/intervalo - ajustar el intervalo de un equipo puntual
router.patch('/maquinaria/:id/intervalo', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const intervalo = Number(req.body.intervalo_mantencion_horas);
    if (isNaN(intervalo) || intervalo <= 0) {
        return res.status(400).json({ error: 'intervalo_mantencion_horas debe ser un numero mayor a 0' });
    }
    try {
        const result = await pool.query(
            'UPDATE maquinarias SET intervalo_mantencion_horas = $1 WHERE id = $2 RETURNING id, codigo, intervalo_mantencion_horas',
            [intervalo, req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }
        res.json({ ...result.rows[0], intervalo_mantencion_horas: num(result.rows[0].intervalo_mantencion_horas) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al actualizar el intervalo de mantencion' });
    }
});

module.exports = { router, encolarAvisoMantencion };
