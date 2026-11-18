const express = require('express');
require('../utils/asyncErrores');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// catalogo de los 31 sistemas del talonario, agrupados como en el papel.
// El movil lo descarga y lo cachea en SQLite (igual que el catalogo de insumos) para poder
// llenar la OT en terreno sin señal.
router.get('/', verifyToken, requireRole('gerente', 'administrativo', 'mecanico'), async (req, res) => {
    const result = await pool.query(
        `SELECT id, grupo, nombre, orden FROM servicios_checklist
             WHERE activo = true ORDER BY orden`
    );
    res.json(result.rows);
});

module.exports = router;
