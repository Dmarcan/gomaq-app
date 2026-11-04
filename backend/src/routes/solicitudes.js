const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { subidaImagen } = require('../middleware/upload');
const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
const { rutaAdjuntoSolicitud } = require('../utils/rutaArchivo');
const { dejarEvento } = require('../utils/eventosOt');

const { origenDeCliente } = require('../utils/estadoEquipo');

const router = express.Router();

const TIPOS_VALIDOS = ['falla', 'mantencion_preventiva'];
const URL_EXPIRACION_SEGUNDOS = 3600;

/** El bucket es privado: la ruta guardada se cambia por una URL firmada temporal al leer. */
async function conUrlFirmada(filas) {
    return Promise.all(filas.map(async (fila) => {
        if (!fila.evidencia_url) return fila;
        const { data, error } = await supabase.storage
            .from(BUCKET_DOCUMENTOS)
            .createSignedUrl(fila.evidencia_url, URL_EXPIRACION_SEGUNDOS);
        return { ...fila, evidencia_url: error ? null : data.signedUrl };
    }));
}

// POST /api/solicitudes - el cliente reporta una falla o pide mantencion sobre su propia maquinaria
router.post('/', verifyToken, requireRole('cliente'), subidaImagen.single('archivo'), async (req, res) => {
    const { maquinaria_id, descripcion, tipo } = req.body;
    if (!maquinaria_id || !descripcion) {
        return res.status(400).json({ error: 'maquinaria_id y descripcion son requeridos' });
    }
    const tipoFinal = tipo && TIPOS_VALIDOS.includes(tipo) ? tipo : 'falla';
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Tu cuenta no está vinculada a ninguna empresa. Pide a GOMAQ que la vincule' });
    }
    try {
        const maquinaria = await pool.query(
            'SELECT id FROM maquinarias WHERE id = $1 AND cliente_id = $2',
            [maquinaria_id, req.user.cliente_id]
        );
        if (maquinaria.rows.length === 0) {
            return res.status(403).json({ error: 'Ese equipo no pertenece a tu empresa' });
        }
        let evidenciaUrl = null;
        if (req.file) {
            // la ruta la arma el servidor: el nombre del cliente solo aporta la extension
            evidenciaUrl = rutaAdjuntoSolicitud(req.user.cliente_id, req.file.originalname);
            const { error: errorSubida } = await supabase.storage
                .from(BUCKET_DOCUMENTOS)
                .upload(evidenciaUrl, req.file.buffer, { contentType: req.file.mimetype });
            if (errorSubida) throw errorSubida;
        }

        try {
            const result = await pool.query(
                `INSERT INTO solicitudes (cliente_id, maquinaria_id, descripcion, tipo, evidencia_url)
                 VALUES ($1, $2, $3, $4::tipo_solicitud, $5) RETURNING *`,
                [req.user.cliente_id, maquinaria_id, descripcion, tipoFinal, evidenciaUrl]
            );
            res.status(201).json(result.rows[0]);
        } catch (errorBd) {
            // compensacion: si el archivo subio pero la BD fallo, no dejarlo huerfano
            if (evidenciaUrl) {
                await supabase.storage.from(BUCKET_DOCUMENTOS).remove([evidenciaUrl]).catch(() => {});
            }
            throw errorBd;
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear solicitud' });
    }
});

// GET /api/solicitudes/mias - el cliente ve sus propias solicitudes con el estado de la OT vinculada
router.get('/mias', verifyToken, requireRole('cliente'), async (req, res) => {
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Tu cuenta no está vinculada a ninguna empresa. Pide a GOMAQ que la vincule' });
    }
    try {
        const result = await pool.query(
            `SELECT s.*, m.codigo AS maquinaria_codigo,
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
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar tus solicitudes' });
    }
});

// GET /api/solicitudes - administrativo/gerente revisan las solicitudes de los clientes
router.get('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    // ?estado=pendiente: las que cuenta el dashboard (utils/pendientes.js); sin el, todas
    const filtro = req.query.estado;
    if (filtro !== undefined && !['pendiente', 'convertida', 'rechazada'].includes(filtro)) {
        return res.status(400).json({ error: 'Estado inválido. Valores posibles: pendiente, convertida, rechazada' });
    }
    try {
        const result = await pool.query(
            `SELECT s.*, c.nombre AS cliente_nombre, m.codigo AS maquinaria_codigo
             FROM solicitudes s
             JOIN clientes c ON c.id = s.cliente_id
             JOIN maquinarias m ON m.id = s.maquinaria_id
             ${filtro ? 'WHERE s.estado = $1::estado_solicitud' : ''}
             ORDER BY s.created_at DESC`,
            filtro ? [filtro] : []
        );
        res.json(await conUrlFirmada(result.rows));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar solicitudes' });
    }
});

// PATCH /api/solicitudes/:id/convertir - transforma la solicitud en una Orden de Trabajo real
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
