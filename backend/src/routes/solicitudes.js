const express = require('express');
require('../utils/asyncErrores');
const { validarIdsEnRuta, validarCuerpo } = require('../utils/validacion');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { subidaImagen } = require('../middleware/upload');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { urlFirmadaONull } = require('../utils/urlsFirmadas');
const { rutaAdjuntoSolicitud } = require('../utils/rutaArchivo');
const { dejarEvento } = require('../utils/eventosOt');
const { validarCoordenadasFormulario } = require('../utils/geo');
const { fijarDestinoOt } = require('../utils/fijarDestinoOt');

const { origenDeCliente } = require('../utils/estadoEquipo');
const { validarGravedad, gravedadMayor, estadoPorGravedad, textoMotivo, textoDetalle, ESTADOS_OT_CON_DETALLE, SQL_ASISTENCIA_ABIERTA } = require('../utils/asistenciaCliente');

const router = express.Router();
validarIdsEnRuta(router, ['id']);

const TIPOS_VALIDOS = ['falla', 'mantencion_preventiva'];

/** El bucket es privado: la ruta guardada se cambia por una URL firmada temporal al leer. */
async function conUrlFirmada(filas) {
    return Promise.all(filas.map(async (fila) => {
        if (!fila.evidencia_url) return fila;
        return { ...fila, evidencia_url: await urlFirmadaONull(supabase, BUCKET_DOCUMENTOS, fila.evidencia_url) };
    }));
}

router.post('/', verifyToken, requireRole('cliente'), subidaImagen.single('archivo'), async (req, res) => {
    const { maquinaria_id, descripcion, tipo } = req.body;
    const errCuerpo = validarCuerpo(req.body, { textos: { descripcion: 2000, tipo: 50 }, ids: ['maquinaria_id'] });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    if (!maquinaria_id || !descripcion) {
        return res.status(400).json({ error: 'maquinaria_id y descripcion son requeridos' });
    }
    const tipoFinal = tipo && TIPOS_VALIDOS.includes(tipo) ? tipo : 'falla';
    // ubicacion de OTRA obra (opcional): sin ella se usa la de la empresa, registrada en clientes.
    // Llega en un multipart, por eso viene como texto.
    const coords = validarCoordenadasFormulario(req.body.latitud, req.body.longitud);
    if (!coords.ok) return res.status(400).json({ error: coords.error });
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Tu cuenta no está vinculada a ninguna empresa. Pide a GOMAQ que la vincule' });
    }
    const g = validarGravedad(req.body.gravedad);
    if (!g.valida) return res.status(400).json({ error: 'gravedad debe ser sigue_operando, parcial o fuera_de_servicio' });
    let client = null;
    let evidenciaUrl = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        // la fila del equipo se bloquea: dos solicitudes simultaneas del mismo equipo se serializan y la segunda ve la primera
        const maquinaria = await client.query(
            'SELECT id, estado FROM maquinarias WHERE id = $1 AND cliente_id = $2 FOR NO KEY UPDATE',
            [maquinaria_id, req.user.cliente_id]
        );
        if (maquinaria.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Ese equipo no pertenece a tu empresa' });
        }
        // una sola asistencia abierta por equipo: para agregar algo se usa POST /:id/detalle
        const abierta = await client.query(
            `SELECT s.id FROM solicitudes s LEFT JOIN ordenes_trabajo ot ON ot.id = s.orden_trabajo_id
             WHERE s.maquinaria_id = $1 AND s.cliente_id = $2 AND ${SQL_ASISTENCIA_ABIERTA} LIMIT 1`,
            [maquinaria_id, req.user.cliente_id]
        );
        if (abierta.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                error: 'Este equipo ya tiene una asistencia en curso',
                solicitud_id: abierta.rows[0].id,
            });
        }
        if (req.file) {
            // la ruta la arma el servidor: el nombre del cliente solo aporta la extension
            evidenciaUrl = rutaAdjuntoSolicitud(req.user.cliente_id, req.file.originalname);
            const { error: errorSubida } = await supabase.storage
                .from(BUCKET_DOCUMENTOS)
                .upload(evidenciaUrl, req.file.buffer, { contentType: req.file.mimetype });
            if (errorSubida) throw errorSubida;
        }
        const result = await client.query(
            `INSERT INTO solicitudes (cliente_id, maquinaria_id, descripcion, tipo, evidencia_url, latitud, longitud, gravedad)
             VALUES ($1, $2, $3, $4::tipo_solicitud, $5, $6, $7, $8) RETURNING *`,
            [req.user.cliente_id, maquinaria_id, descripcion, tipoFinal, evidenciaUrl, coords.latitud, coords.longitud, g.gravedad]
        );
        // la orden nace sola, sin pasar por el administrativo: queda pendiente y sin tecnico, asi los mecanicos
        // la ven para tomarla (PATCH /:id/tomar) o el administrativo se la asigna. La solicitud queda como registro
        // del origen, ya vinculada a su OT.
        const otResult = await client.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, origen, motivo)
             VALUES ($1, $2, $4::origen_orden, $3) RETURNING *`,
            [maquinaria_id, req.user.cliente_id, textoMotivo({ descripcion, gravedad: g.gravedad }),
             await origenDeCliente(client, req.user.cliente_id)]
        );
        const orden = otResult.rows[0];
        await dejarEvento(client, {
            ordenId: orden.id, tipo: 'creacion', origen: 'panel', estadoNuevo: orden.estado,
            usuario: req.user,
            detalle: { maquinaria_id: orden.maquinaria_id, cliente_id: orden.cliente_id, solicitud_id: result.rows[0].id },
        });
        await client.query(
            `UPDATE solicitudes SET estado = 'convertida', orden_trabajo_id = $1 WHERE id = $2`,
            [orden.id, result.rows[0].id]
        );
        // despues de vincular la solicitud: si el cliente indico otra obra, ese es el destino
        await fijarDestinoOt(client, orden.id);
        const cambio = estadoPorGravedad({ gravedad: g.gravedad, estadoEquipo: maquinaria.rows[0].estado });
        if (cambio) {
            await client.query('UPDATE maquinarias SET estado = $1, estado_origen = $2 WHERE id = $3', [cambio.estado, cambio.origen, maquinaria_id]);
        }
        await client.query('COMMIT');
        res.status(201).json({
            ...result.rows[0], estado: 'convertida', orden_trabajo_id: orden.id,
            estado_equipo: cambio ? cambio.estado : maquinaria.rows[0].estado,
        });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        // compensacion: si el archivo subio pero la BD fallo, no dejarlo huerfano
        if (evidenciaUrl) {
            await supabase.storage.from(BUCKET_DOCUMENTOS).remove([evidenciaUrl]).catch(() => {});
        }
        throw err;
    } finally {
        if (client) client.release();
    }
});

// POST /api/solicitudes/:id/detalle - el cliente agrega un detalle a su asistencia pendiente (no abre otra).
// Puede subir la gravedad, nunca bajarla, y con ella el estado del equipo (mismas reglas que al pedirla).
router.post('/:id/detalle', verifyToken, requireRole('cliente'), async (req, res) => {
    const errCuerpo = validarCuerpo(req.body, { textos: { texto: 2000 } });
    if (errCuerpo) return res.status(400).json({ error: errCuerpo });
    const texto = typeof req.body.texto === 'string' ? req.body.texto.trim() : '';
    if (!texto) return res.status(400).json({ error: 'texto es requerido' });
    const g = validarGravedad(req.body.gravedad);
    if (!g.valida) return res.status(400).json({ error: 'gravedad debe ser sigue_operando, parcial o fuera_de_servicio' });
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Tu cuenta no está vinculada a ninguna empresa. Pide a GOMAQ que la vincule' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const sol = await client.query(
            'SELECT id, maquinaria_id, gravedad, estado, orden_trabajo_id FROM solicitudes WHERE id = $1 AND cliente_id = $2 FOR UPDATE',
            [req.params.id, req.user.cliente_id]
        );
        if (sol.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Asistencia no encontrada' });
        }
        // el detalle se suma al motivo de la orden, que es lo que lee el tecnico. Solo mientras el tecnico no la
        // acepto: despues ya va en camino y un texto nuevo no le llegaria. Primero la fila de la orden y despues la del equipo.
        const ot = sol.rows[0].orden_trabajo_id
            ? await client.query('SELECT id, estado FROM ordenes_trabajo WHERE id = $1 FOR NO KEY UPDATE', [sol.rows[0].orden_trabajo_id])
            : { rows: [] };
        // una solicitud antigua aun pendiente (sin orden) tambien admite el detalle: queda en la solicitud
        const sinOrdenAun = ot.rows.length === 0 && sol.rows[0].estado === 'pendiente';
        if (!sinOrdenAun && (ot.rows.length === 0 || !ESTADOS_OT_CON_DETALLE.includes(ot.rows[0].estado))) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'El técnico ya tomó esta asistencia. Ya no se le pueden agregar detalles' });
        }
        const equipo = await client.query('SELECT estado FROM maquinarias WHERE id = $1 FOR NO KEY UPDATE', [sol.rows[0].maquinaria_id]);
        const mayor = gravedadMayor(sol.rows[0].gravedad, g.gravedad);
        await client.query('INSERT INTO solicitudes_detalle (solicitud_id, texto, gravedad) VALUES ($1, $2, $3)', [sol.rows[0].id, texto, g.gravedad]);
        if (mayor !== sol.rows[0].gravedad) {
            await client.query('UPDATE solicitudes SET gravedad = $1 WHERE id = $2', [mayor, sol.rows[0].id]);
        }
        if (!sinOrdenAun) {
            await client.query(
                'UPDATE ordenes_trabajo SET motivo = COALESCE(motivo, \'\') || $1 WHERE id = $2',
                [textoDetalle({ texto, gravedadAnterior: sol.rows[0].gravedad, gravedadNueva: mayor }), ot.rows[0].id]
            );
        }
        const cambio = equipo.rows[0] ? estadoPorGravedad({ gravedad: mayor, estadoEquipo: equipo.rows[0].estado }) : null;
        if (cambio) {
            await client.query('UPDATE maquinarias SET estado = $1, estado_origen = $2 WHERE id = $3', [cambio.estado, cambio.origen, sol.rows[0].maquinaria_id]);
        }
        await client.query('COMMIT');
        res.status(201).json({ solicitud_id: sol.rows[0].id, gravedad: mayor });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
});

router.get('/mias', verifyToken, requireRole('cliente'), async (req, res) => {
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Tu cuenta no está vinculada a ninguna empresa. Pide a GOMAQ que la vincule' });
    }
    const result = await pool.query(
        `SELECT s.*, m.codigo AS maquinaria_codigo,
                    (SELECT COALESCE(json_agg(json_build_object('texto', d.texto, 'gravedad', d.gravedad, 'created_at', d.created_at) ORDER BY d.created_at), '[]'::json) FROM solicitudes_detalle d WHERE d.solicitud_id = s.id) AS detalles,
                    ot.id AS ot_id, ot.estado AS ot_estado,
                    u.nombre AS mecanico_nombre
             FROM solicitudes s
             JOIN maquinarias m ON m.id = s.maquinaria_id
             LEFT JOIN ordenes_trabajo ot ON ot.id = s.orden_trabajo_id
             LEFT JOIN usuarios u ON u.id = ot.mecanico_id
             WHERE s.cliente_id = $1
             ORDER BY s.created_at DESC`,
        [req.user.cliente_id]
    );
    res.json(await conUrlFirmada(result.rows));
});

router.get('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    // ?estado=pendiente: las que cuenta el dashboard (utils/pendientes.js); sin el, todas
    const filtro = req.query.estado;
    if (filtro !== undefined && !['pendiente', 'convertida', 'rechazada'].includes(filtro)) {
        return res.status(400).json({ error: 'Estado inválido. Valores posibles: pendiente, convertida, rechazada' });
    }
    const result = await pool.query(
        `SELECT s.*, c.nombre AS cliente_nombre, m.codigo AS maquinaria_codigo,
                    (SELECT COALESCE(json_agg(json_build_object('texto', d.texto, 'gravedad', d.gravedad, 'created_at', d.created_at) ORDER BY d.created_at), '[]'::json) FROM solicitudes_detalle d WHERE d.solicitud_id = s.id) AS detalles
             FROM solicitudes s
             JOIN clientes c ON c.id = s.cliente_id
             JOIN maquinarias m ON m.id = s.maquinaria_id
             ${filtro ? 'WHERE s.estado = $1::estado_solicitud' : ''}
             ORDER BY s.created_at DESC`,
        filtro ? [filtro] : []
    );
    res.json(await conUrlFirmada(result.rows));
});

router.patch('/:id/convertir', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const solicitudResult = await client.query('SELECT * FROM solicitudes WHERE id = $1 FOR UPDATE', [req.params.id]);
        const solicitud = solicitudResult.rows[0];
        if (!solicitud) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Asistencia no encontrada' });
        }
        if (solicitud.estado !== 'pendiente') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Esta asistencia ya fue procesada' });
        }

        const otResult = await client.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, origen, motivo)
             VALUES ($1, $2, $4::origen_orden, $3) RETURNING *`,
            [solicitud.maquinaria_id, solicitud.cliente_id, solicitud.descripcion, await origenDeCliente(client, solicitud.cliente_id)]
        );
        const orden = otResult.rows[0];
        // la OT nace en la misma transaccion que su evento de creacion (historial, migracion 020)
        await dejarEvento(client, {
            ordenId: orden.id, tipo: 'creacion', origen: 'panel', estadoNuevo: orden.estado,
            usuario: req.user,
            detalle: { maquinaria_id: orden.maquinaria_id, cliente_id: orden.cliente_id, solicitud_id: solicitud.id },
        });

        await client.query(
            `UPDATE solicitudes SET estado = 'convertida', orden_trabajo_id = $1 WHERE id = $2`,
            [orden.id, solicitud.id]
        );
        // despues de vincular la solicitud: si el cliente indico otra obra, ese es el destino
        await fijarDestinoOt(client, orden.id);

        await client.query('COMMIT');
        res.json({ solicitud_id: solicitud.id, orden_trabajo: orden });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'Error al convertir solicitud' });
    } finally {
        if (client) client.release();
    }
});

module.exports = router;
