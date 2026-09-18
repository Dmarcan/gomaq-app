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
                -- disponible = se lo puede arrendar hoy: sin cliente Y operativo. Uno fuera de servicio o
                -- en mantencion sin cliente no esta arrendado, pero tampoco esta disponible.
                COUNT(*) FILTER (WHERE cliente_id IS NULL AND estado = 'operativa') AS disponibles,
                COUNT(*) FILTER (WHERE estado = 'operativa') AS operativas,
                COUNT(*) FILTER (WHERE estado = 'en_mantencion') AS en_mantencion,
                COUNT(*) FILTER (WHERE estado = 'fuera_de_servicio') AS fuera_de_servicio,
                COUNT(*) AS total
            FROM maquinarias
        `);

        const pendientesFacturar = await pool.query(
            `SELECT COUNT(*) AS n FROM ordenes_trabajo
             WHERE facturable = true AND valorizacion IS NULL AND estado = 'finalizada'`
        );
        const solicitudesPendientes = await pool.query(
            `SELECT COUNT(*) AS n FROM solicitudes WHERE estado = 'pendiente'`
        );
        const notificacionesError = await pool.query(
            `SELECT COUNT(*) AS n FROM notificaciones_pendientes WHERE estado = 'error'`
        );
        // la aprobacion de cuentas de clientes vive en una pestaña de Clientes: el atajo la hace visible
        const cuentasPorAprobar = await pool.query(
            `SELECT COUNT(*) AS n FROM solicitudes_cliente WHERE estado = 'pendiente'`
        );

        res.json({
            flota: flota.rows[0],
            atajos: {
                pendientes_facturar: Number(pendientesFacturar.rows[0].n),
                solicitudes_pendientes: Number(solicitudesPendientes.rows[0].n),
                notificaciones_error: Number(notificacionesError.rows[0].n),
                cuentas_por_aprobar: Number(cuentasPorAprobar.rows[0].n),
            },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al calcular el resumen del dashboard' });
    }
});

// GET /api/dashboard/ventas-por-ejecutivo?desde=&hasta= - cuanto de lo facturado corresponde
// a cada ejecutivo en terreno (reemplazo del comparativo manual que la administrativa arma en Excel)
router.get('/ventas-por-ejecutivo', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { desde, hasta } = req.query;
    try {
        // una factura tiene dos origenes posibles y excluyentes: reparacion (orden_trabajo_id)
        // o arriendo (guia_recepcion_id). Ambos LEFT JOIN + COALESCE para que el reporte
        // incluya los dos - un INNER JOIN a ordenes_trabajo botaba todos los arriendos,
        // que son justamente el rubro principal del negocio (bug corregido en auditoria).
        const result = await pool.query(
            `SELECT e.id AS ejecutivo_id, COALESCE(e.nombre, 'Directo') AS ejecutivo_nombre,
                    COALESCE(SUM(f.monto), 0) AS monto
             FROM facturas f
             LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
             LEFT JOIN guias g ON g.id = f.guia_recepcion_id
             LEFT JOIN clientes c ON c.id = COALESCE(ot.cliente_id, g.cliente_id)
             LEFT JOIN ejecutivos e ON e.id = c.ejecutivo_id
             WHERE ($1::date IS NULL OR f.fecha_emision >= $1::date)
               AND ($2::date IS NULL OR f.fecha_emision <= $2::date)
             GROUP BY e.id, e.nombre
             ORDER BY monto DESC`,
            [desde || null, hasta || null]
        );

        const totalGeneral = result.rows.reduce((acc, fila) => acc + Number(fila.monto), 0);
        const filas = result.rows.map((fila) => ({
            ...fila,
            monto: Number(fila.monto),
            porcentaje: totalGeneral > 0 ? Number(fila.monto) / totalGeneral * 100 : 0,
        }));

        res.json({ total_general: totalGeneral, ejecutivos: filas });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al calcular ventas por ejecutivo' });
    }
});

// GET /api/dashboard/ots-por-mes - OTs creadas por mes calendario (ultimos 6 meses)
// para el grafico de linea del dashboard. generate_series rellena los meses sin OTs
// con cero, para que la linea no "salte" meses.
router.get('/ots-por-mes', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT to_char(m.mes, 'YYYY-MM') AS mes, COUNT(ot.id)::int AS total
            FROM generate_series(
                date_trunc('month', now()) - interval '5 months',
                date_trunc('month', now()),
                interval '1 month'
            ) AS m(mes)
            LEFT JOIN ordenes_trabajo ot ON date_trunc('month', ot.fecha_creacion) = m.mes
            GROUP BY m.mes
            ORDER BY m.mes
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al calcular OTs por mes' });
    }
});

module.exports = router;
