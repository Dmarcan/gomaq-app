const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /api/dashboard/resumen - estadisticas y atajos para la pantalla "Estado de la Flota"
router.get('/resumen', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const flota = await pool.query(`
            SELECT
                COUNT(*) FILTER (WHERE cliente_id IS NOT NULL) AS arrendados,
                COUNT(*) FILTER (WHERE cliente_id IS NULL) AS disponibles,
                COUNT(*) FILTER (WHERE estado = 'operativa') AS operativas,
                COUNT(*) FILTER (WHERE estado = 'en_mantencion') AS en_mantencion,
                COUNT(*) FILTER (WHERE estado = 'fuera_de_servicio') AS fuera_de_servicio,
                COUNT(*) AS total
            FROM maquinarias
        `);

        const pendientesFacturar = await pool.query(
            `SELECT COUNT(*) AS n FROM ordenes_trabajo WHERE facturable = true AND valorizacion IS NULL`
        );
        const solicitudesPendientes = await pool.query(
            `SELECT COUNT(*) AS n FROM solicitudes WHERE estado = 'pendiente'`
        );
        const notificacionesError = await pool.query(
            `SELECT COUNT(*) AS n FROM notificaciones_pendientes WHERE estado = 'error'`
        );

        res.json({
            flota: flota.rows[0],
            atajos: {
                pendientes_facturar: Number(pendientesFacturar.rows[0].n),
                solicitudes_pendientes: Number(solicitudesPendientes.rows[0].n),
                notificaciones_error: Number(notificacionesError.rows[0].n),
            },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al calcular el resumen del dashboard' });
    }
});

module.exports = router;
