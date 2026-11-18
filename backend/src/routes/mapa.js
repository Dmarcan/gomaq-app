const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { validarUbicacionBodega } = require('../utils/geo');
const { cargarAlertasMantencion } = require('../utils/mantencion');
const { armarRespuestaMapa, armarBodega } = require('../utils/mapaOperativo');

const router = express.Router();

// Solo la oficina. El cliente y el mecanico no ven este mapa (ni coordenadas de nadie).
const soloOficina = [verifyToken, requireRole('administrativo', 'gerente')];

// La bodega central: la misma fila que usa insumos.js (la primera de tipo 'bodega').
const SQL_BODEGA = `SELECT id, nombre, latitud, longitud, ubicacion_actualizada_at
                    FROM ubicaciones_stock WHERE tipo = 'bodega' ORDER BY id LIMIT 1`;

// equipos (arrendados y en bodega) y furgones en camino, con su ubicacion.
// No llama al servicio de rutas ni recalcula la ETA: solo lee lo que ya esta guardado.
router.get('/', ...soloOficina, async (req, res) => {
    try {
        const [bodega, equipos, furgones, alertas] = await Promise.all([
            pool.query(SQL_BODEGA),
            pool.query(`
                SELECT m.id, m.codigo, m.tipo, m.marca, m.modelo, m.estado, m.cliente_id,
                       c.nombre AS cliente_nombre, c.direccion, c.latitud AS c_lat, c.longitud AS c_lng,
                       g.tipo AS g_tipo, g.cliente_id AS g_cliente_id, g.latitud AS g_lat, g.longitud AS g_lng,
                       o.id AS ot_id, o.estado AS ot_estado, o.mecanico_nombre AS ot_mecanico
                FROM maquinarias m
                LEFT JOIN clientes c ON c.id = m.cliente_id
                -- la OT abierta mas reciente del equipo (cualquier estado menos finalizada), para decirlo en su ficha
                LEFT JOIN LATERAL (
                    SELECT ot.id, ot.estado, um.nombre AS mecanico_nombre
                    FROM ordenes_trabajo ot
                    LEFT JOIN usuarios um ON um.id = ot.mecanico_id
                    WHERE ot.maquinaria_id = m.id AND ot.estado <> 'finalizada'
                    ORDER BY ot.id DESC LIMIT 1
                ) o ON true
                LEFT JOIN LATERAL (
                    SELECT tipo, cliente_id, latitud, longitud FROM guias
                    WHERE maquinaria_id = m.id AND fallido = false
                    ORDER BY fecha DESC, id DESC LIMIT 1
                ) g ON true
                ORDER BY m.codigo`),
            // Solo OT en camino. La posicion se une por la OT Y por el mecanico dueno: una fila vieja
            // de otra OT o de otro tecnico nunca se mezcla. Sin posicion sigue en la lista (coordenadas null).
            pool.query(`
                SELECT ot.id AS orden_trabajo_id, u.nombre AS mecanico_nombre,
                       v.patente AS vehiculo_patente, v.marca AS vehiculo_marca, v.modelo AS vehiculo_modelo,
                       c.nombre AS cliente_nombre, m.id AS maquinaria_id, m.codigo AS maquinaria_codigo,
                       p.latitud, p.longitud, p.capturada_en AS posicion_at, p.quieto_desde,
                       CASE WHEN ot.eta_segundos IS NOT NULL
                            THEN COALESCE(ot.eta_ajustada_llegada_at,
                                          ot.eta_calculada_at + make_interval(secs => ot.eta_segundos)) END AS eta_llegada_at,
                       ot.eta_fuente
                FROM ordenes_trabajo ot
                JOIN maquinarias m ON m.id = ot.maquinaria_id
                LEFT JOIN clientes c ON c.id = ot.cliente_id
                LEFT JOIN usuarios u ON u.id = ot.mecanico_id
                LEFT JOIN vehiculos v ON v.usuario_id = ot.mecanico_id AND v.activo = true
                LEFT JOIN posiciones_mecanico p ON p.usuario_id = ot.mecanico_id AND p.orden_trabajo_id = ot.id
                WHERE ot.estado = 'en_camino'
                ORDER BY ot.id`),
            cargarAlertasMantencion(pool),
        ]);
        res.json(armarRespuestaMapa({
            bodega: bodega.rows[0] || null,
            equipos: equipos.rows,
            furgones: furgones.rows,
            alertas,
        }));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al cargar el mapa' });
    }
});

router.get('/bodega', ...soloOficina, async (req, res) => {
    try {
        const fila = (await pool.query(SQL_BODEGA)).rows[0];
        if (!fila) return res.status(409).json({ error: 'No hay una bodega registrada' });
        res.json({ ...armarBodega(fila), ubicacion_actualizada_at: fila.ubicacion_actualizada_at });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al leer la bodega' });
    }
});

// fija la ubicacion de la bodega. Latitud y longitud juntas; las dos en
// null la borran (un cuerpo vacio o con una sola responde 400). Administrativo y gerente.
router.put('/bodega', ...soloOficina, async (req, res) => {
    const coords = validarUbicacionBodega(req.body);
    if (!coords.ok) return res.status(400).json({ error: coords.error });
    try {
        const r = await pool.query(
            `UPDATE ubicaciones_stock
             SET latitud = $1, longitud = $2, ubicacion_actualizada_por = $3, ubicacion_actualizada_at = now()
             WHERE id = (SELECT id FROM ubicaciones_stock WHERE tipo = 'bodega' ORDER BY id LIMIT 1)
             RETURNING id, nombre, latitud, longitud, ubicacion_actualizada_at`,
            [coords.latitud, coords.longitud, req.user.id]
        );
        if (r.rows.length === 0) return res.status(409).json({ error: 'No hay una bodega registrada' });
        res.json({ ...armarBodega(r.rows[0]), ubicacion_actualizada_at: r.rows[0].ubicacion_actualizada_at });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al guardar la ubicación de la bodega' });
    }
});

module.exports = router;
