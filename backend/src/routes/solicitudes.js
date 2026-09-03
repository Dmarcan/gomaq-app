const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { MAX_ADJUNTO_BYTES } = require('../middleware/upload');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'solicitudes');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
// adjunto opcional del cliente (foto o PDF). A diferencia del resto va a disco, no a
// memoria, pero sin tope un solo envio puede llenar el disco del servidor
const upload = multer({ storage, limits: { fileSize: MAX_ADJUNTO_BYTES, files: 1 } });

const TIPOS_VALIDOS = ['falla', 'mantencion_preventiva'];

// POST /api/solicitudes - el cliente reporta una falla o pide mantencion sobre su propia maquinaria
router.post('/', verifyToken, requireRole('cliente'), upload.single('archivo'), async (req, res) => {
    const { maquinaria_id, descripcion, tipo } = req.body;
    if (!maquinaria_id || !descripcion) {
        return res.status(400).json({ error: 'maquinaria_id y descripcion son requeridos' });
    }
    const tipoFinal = tipo && TIPOS_VALIDOS.includes(tipo) ? tipo : 'falla';
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Su usuario no esta vinculado a ninguna empresa cliente' });
    }
    try {
        const maquinaria = await pool.query(
            'SELECT id FROM maquinarias WHERE id = $1 AND cliente_id = $2',
            [maquinaria_id, req.user.cliente_id]
        );
        if (maquinaria.rows.length === 0) {
            return res.status(403).json({ error: 'Esa maquinaria no pertenece a su empresa' });
        }
        const evidenciaUrl = req.file ? `/uploads/solicitudes/${req.file.filename}` : null;
        const result = await pool.query(
            `INSERT INTO solicitudes (cliente_id, maquinaria_id, descripcion, tipo, evidencia_url)
             VALUES ($1, $2, $3, $4::tipo_solicitud, $5) RETURNING *`,
            [req.user.cliente_id, maquinaria_id, descripcion, tipoFinal, evidenciaUrl]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al crear solicitud' });
    }
});

// GET /api/solicitudes/mias - el cliente ve sus propias solicitudes con el estado de la OT vinculada
router.get('/mias', verifyToken, requireRole('cliente'), async (req, res) => {
    if (!req.user.cliente_id) {
        return res.status(400).json({ error: 'Su usuario no esta vinculado a ninguna empresa cliente' });
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
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar sus solicitudes' });
    }
});

// GET /api/solicitudes - administrativo/gerente revisan las solicitudes de los clientes
router.get('/', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT s.*, c.nombre AS cliente_nombre, m.codigo AS maquinaria_codigo
             FROM solicitudes s
             JOIN clientes c ON c.id = s.cliente_id
             JOIN maquinarias m ON m.id = s.maquinaria_id
             ORDER BY s.created_at DESC`
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar solicitudes' });
    }
});

// PATCH /api/solicitudes/:id/convertir - transforma la solicitud en una Orden de Trabajo real
router.patch('/:id/convertir', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const solicitudResult = await client.query('SELECT * FROM solicitudes WHERE id = $1 FOR UPDATE', [req.params.id]);
        const solicitud = solicitudResult.rows[0];
        if (!solicitud) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Solicitud no encontrada' });
        }
        if (solicitud.estado !== 'pendiente') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Esta solicitud ya fue procesada' });
        }

        const otResult = await client.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, origen, motivo)
             VALUES ($1, $2, 'directo', $3) RETURNING *`,
            [solicitud.maquinaria_id, solicitud.cliente_id, solicitud.descripcion]
        );
        const orden = otResult.rows[0];

        await client.query(
            `UPDATE solicitudes SET estado = 'convertida', orden_trabajo_id = $1 WHERE id = $2`,
            [orden.id, solicitud.id]
        );

        await client.query('COMMIT');
        res.json({ solicitud_id: solicitud.id, orden_trabajo: orden });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al convertir solicitud' });
    } finally {
        client.release();
    }
});

module.exports = router;
