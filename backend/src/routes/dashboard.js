const express = require('express');
require('../utils/asyncErrores');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');

const { TIPOS_INTERNOS, SQL_AVISOS_PROBLEMAS, SQL_AVISOS_EN_ERROR, SQL_AVISOS_ATRASADOS } = require('../utils/avisos');
const { SQL_SOLICITUDES_POR_ATENDER, sqlGuiasSinDocumento, SQL_CUENTAS_POR_APROBAR, SQL_DESCUADRES } = require('../utils/pendientes');
const { cargarAlertasMantencion, contarAlertas } = require('../utils/mantencion');
const { cargarArriendos, filtrarPorFacturar, filtrarConAviso } = require('../utils/arriendos');
const { leerConfiguracion } = require('../utils/configuracion');
const { SQL_OT_SIN_ASIGNAR, SQL_OT_POR_VALORIZAR, SQL_OT_LISTA_FACTURAR } = require('../utils/ordenes');
const { SQL_FACTURAS_VENCIDAS, SQL_FACTURAS_PROXIMAS } = require('../utils/cobranza');

const router = express.Router();

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
            `SELECT COUNT(*) AS n FROM ordenes_trabajo ot WHERE ${SQL_OT_POR_VALORIZAR}`
        );
        const solicitudesPendientes = await pool.query(
            `SELECT COUNT(*) AS n FROM solicitudes WHERE ${SQL_SOLICITUDES_POR_ATENDER}`
        );
        // los avisos internos (mecanico y gerente) no cuentan: mientras el proveedor sea un stub todos terminan en
        // error y taparian la alarma de los avisos al cliente
        const notificacionesError = await pool.query(
            `SELECT COUNT(*) AS n FROM notificaciones_pendientes WHERE ${SQL_AVISOS_EN_ERROR}`,
            [TIPOS_INTERNOS]
        );
        // pendientes que llevan mas de 10 min vencidos sin que nadie los tome: el worker esta caido
        const notificacionesAtrasadas = await pool.query(
            `SELECT COUNT(*) AS n FROM notificaciones_pendientes WHERE ${SQL_AVISOS_ATRASADOS}`
        );
        // despachos registrados sin PDF: el equipo ya salio y falta el respaldo
        const guiasSinDocumento = await pool.query(`SELECT COUNT(*) AS n FROM guias WHERE ${sqlGuiasSinDocumento()}`);
        // la aprobacion de cuentas de clientes vive en una pestaña de Clientes: el atajo la hace visible
        const cuentasPorAprobar = await pool.query(
            `SELECT COUNT(*) AS n FROM solicitudes_cliente WHERE ${SQL_CUENTAS_POR_APROBAR}`
        );
        // tarjetas de cobranza: el mismo predicado que GET /api/facturacion/emitidas?estado=vencidas|proximas
        const cobranza = await pool.query(
            `SELECT COUNT(*) FILTER (WHERE ${SQL_FACTURAS_VENCIDAS})::int AS vencidas,
                    COUNT(*) FILTER (WHERE ${SQL_FACTURAS_PROXIMAS})::int AS proximas
             FROM facturas f`
        );

        res.json({
            flota: flota.rows[0],
            atajos: {
                pendientes_facturar: Number(pendientesFacturar.rows[0].n),
                solicitudes_pendientes: Number(solicitudesPendientes.rows[0].n),
                notificaciones_error: Number(notificacionesError.rows[0].n),
                notificaciones_atrasadas: Number(notificacionesAtrasadas.rows[0].n),
                guias_sin_documento: Number(guiasSinDocumento.rows[0].n),
                cuentas_por_aprobar: Number(cuentasPorAprobar.rows[0].n),
            },
            cobranza: { vencidas: cobranza.rows[0].vencidas, proximas: cobranza.rows[0].proximas },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al calcular el resumen del dashboard' });
    }
});

// Los arriendos se arman con una consulta que recorre todas las guias (utils/arriendos.js). El dashboard se
// refresca seguido y lo abren varios usuarios: se guarda el resultado 30 s en memoria (por configuracion
// de cobro). El numero del dashboard puede ir hasta 30 s atrasado respecto de las pestanas de Facturacion,
// que siempre leen en vivo. `vaciarCacheArriendos` lo usan las pruebas.
const TTL_ARRIENDOS_MS = 30000;
let cacheArriendos = null;

function vaciarCacheArriendos() {
    cacheArriendos = null;
}

async function arriendosParaDashboard(config) {
    const clave = JSON.stringify(config);
    if (cacheArriendos && cacheArriendos.clave === clave && Date.now() - cacheArriendos.en < TTL_ARRIENDOS_MS) {
        return cacheArriendos.arriendos;
    }
    const arriendos = await cargarArriendos(pool, config);
    cacheArriendos = { clave, en: Date.now(), arriendos };
    return arriendos;
}

// el bloque "Pendientes" del dashboard: cada numero sale del mismo
// predicado que la lista a la que lleva (utils/*), para que el numero y la lista no discrepen.
//   mantencion_vencida / mantencion_proxima  GET /api/horometro/alertas
//   ot_sin_asignar                           GET /api/ordenes-trabajo?sin_asignar=1
//   asistencias_por_atender                  GET /api/solicitudes?estado=pendiente
//   avisos_con_problemas                     GET /api/notificaciones?problemas=1 (total)
//   por_facturar                             la pestana "Por facturar" (arriendos cerrados + reparaciones listas)
//   arriendos_con_aviso                      GET /api/facturacion/arriendos-en-curso con aviso
//   ot_por_valorizar                         la pestana "Pendiente de valorizar"
//   guias_sin_documento                      GET /api/maquinarias/guias/recientes?sin_documento=1
//   descuadres                               GET /api/insumos/descuadres
//   cuentas_por_aprobar                      GET /api/usuarios/solicitudes
// Usa 3 conexiones a lo sumo (los conteos simples van en un solo SELECT): el pool es de 10.
router.get('/pendientes', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const config = await leerConfiguracion(pool);
        const [alertas, arriendos, conteos] = await Promise.all([
            cargarAlertasMantencion(pool),
            arriendosParaDashboard(config),
            pool.query(
                `SELECT
                    (SELECT COUNT(*)::int FROM ordenes_trabajo ot WHERE ${SQL_OT_SIN_ASIGNAR}) AS ot_sin_asignar,
                    (SELECT COUNT(*)::int FROM solicitudes WHERE ${SQL_SOLICITUDES_POR_ATENDER}) AS asistencias_por_atender,
                    (SELECT COUNT(*)::int FROM notificaciones_pendientes WHERE ${SQL_AVISOS_PROBLEMAS}) AS avisos_con_problemas,
                    (SELECT COUNT(*)::int FROM ordenes_trabajo ot WHERE ${SQL_OT_LISTA_FACTURAR}) AS reparaciones_listas,
                    (SELECT COUNT(*)::int FROM ordenes_trabajo ot WHERE ${SQL_OT_POR_VALORIZAR}) AS ot_por_valorizar,
                    (SELECT COUNT(*)::int FROM guias WHERE ${sqlGuiasSinDocumento()}) AS guias_sin_documento,
                    (SELECT COUNT(*)::int FROM stock_ubicacion WHERE ${SQL_DESCUADRES}) AS descuadres,
                    (SELECT COUNT(*)::int FROM solicitudes_cliente WHERE ${SQL_CUENTAS_POR_APROBAR}) AS cuentas_por_aprobar`,
                [TIPOS_INTERNOS]
            ),
        ]);
        const c = conteos.rows[0];
        const { vencidas, proximas } = contarAlertas(alertas);
        res.json({
            mantencion_vencida: vencidas,
            mantencion_proxima: proximas,
            ot_sin_asignar: c.ot_sin_asignar,
            asistencias_por_atender: c.asistencias_por_atender,
            avisos_con_problemas: c.avisos_con_problemas,
            por_facturar: filtrarPorFacturar(arriendos).length + c.reparaciones_listas,
            arriendos_con_aviso: filtrarConAviso(arriendos, config).length,
            ot_por_valorizar: c.ot_por_valorizar,
            guias_sin_documento: c.guias_sin_documento,
            descuadres: c.descuadres,
            cuentas_por_aprobar: c.cuentas_por_aprobar,
            generado_en: new Date().toISOString(),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al calcular los pendientes del dashboard' });
    }
});

// cuanto de lo facturado corresponde a cada ejecutivo en terreno
router.get('/ventas-por-ejecutivo', verifyToken, requireRole('administrativo', 'gerente'), async (req, res) => {
    const { desde, hasta } = req.query;
    try {
        // una factura tiene dos origenes posibles y excluyentes: reparacion (orden_trabajo_id)
        // o arriendo (guia_recepcion_id). Ambos LEFT JOIN + COALESCE para que el reporte incluya los dos:
        // un INNER JOIN a ordenes_trabajo dejaria fuera los arriendos, que son el rubro principal.
        const result = await pool.query(
            `SELECT e.id AS ejecutivo_id, COALESCE(e.nombre, 'Directo') AS ejecutivo_nombre,
                    COALESCE(SUM(f.monto), 0) AS monto
             FROM facturas f
             LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
             LEFT JOIN guias g ON g.id = f.guia_recepcion_id
             LEFT JOIN clientes c ON c.id = COALESCE(f.cliente_id, ot.cliente_id, g.cliente_id)
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

// OTs creadas por mes calendario (ultimos 6 meses)
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
module.exports.vaciarCacheArriendos = vaciarCacheArriendos;
