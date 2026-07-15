const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'facturas');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// POST /api/ordenes-trabajo/:id/factura - subir PDF de factura ya emitida en el SII
router.post('/:id/factura', verifyToken, requireRole('administrativo'), upload.single('archivo'), async (req, res) => {
    const { id } = req.params;
    const { folio, monto, fecha_emision } = req.body;
    if (!folio || !req.file) {
        return res.status(400).json({ error: 'folio y archivo (PDF) son requeridos' });
    }
    try {
        const archivoUrl = `/uploads/facturas/${req.file.filename}`;
        const result = await pool.query(
            `INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, monto, fecha_emision)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [id, folio, archivoUrl, monto || null, fecha_emision || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al subir factura' });
    }
});

// GET /api/ordenes-trabajo/:id/factura - listar facturas de una OT
router.get('/:id/factura', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM facturas WHERE orden_trabajo_id = $1 ORDER BY created_at DESC',
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al consultar facturas' });
    }
});

module.exports = router;
