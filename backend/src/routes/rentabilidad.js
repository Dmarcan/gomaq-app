const express = require('express');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { calcularRentabilidad } = require('../utils/rentabilidad');
const { parsearPaginacion, parsearBusqueda, envolver } = require('../utils/paginacion');

const router = express.Router();

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Por defecto los ultimos 12 meses, que es el horizonte con que se evalua un arriendo. */
function rangoDeFechas(query) {
    const hasta = query.hasta ? new Date(query.hasta) : new Date();
    let desde;
    if (query.desde) {
        desde = new Date(query.desde);
    } else {
        desde = new Date(hasta);
        desde.setFullYear(desde.getFullYear() - 1);
    }
    return { desde, hasta };
}

// Gasto en repuestos por equipo. Cuenta TODAS las lineas, cobradas o no: es el costo real
// para GOMAQ, no lo facturado al cliente (entrevista el jefe de taller, punto 1). Las anuladas no: el
// repuesto volvio al furgon, no se gasto.
const SQL_LINEAS = `
    SELECT ot.maquinaria_id, mi.cantidad, mi.precio_unitario
    FROM movimientos_insumo mi
    JOIN ordenes_trabajo ot ON ot.id = mi.orden_trabajo_id
    WHERE mi.tipo = 'salida' AND mi.anulada_at IS NULL
      AND mi.created_at BETWEEN $1 AND $2
`;

// Ingreso facturado por equipo, por sus dos caminos: factura de arriendo (facturas.maquinaria_id,
// migracion 008) y factura de reparacion (a traves de la orden de trabajo).
const SQL_FACTURAS = `
    SELECT COALESCE(f.maquinaria_id, ot.maquinaria_id) AS maquinaria_id, f.monto
    FROM facturas f
    LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
    WHERE COALESCE(f.maquinaria_id, ot.maquinaria_id) IS NOT NULL
      AND f.created_at BETWEEN $1 AND $2
`;

function agruparPorMaquinaria(filas) {
    const mapa = new Map();
    for (const fila of filas) {
        const id = fila.maquinaria_id;
        if (!mapa.has(id)) mapa.set(id, []);
        mapa.get(id).push(fila);
    }
    return mapa;
}

// GET /api/rentabilidad - toda la flota, lo que sale a perdida primero.
// Responde la pregunta de el jefe de taller: "no sabemos si en los tres meses que estuvo la maquina se
// gasto mas plata de la que dejaba el arriendo".
router.get('/', verifyToken, requireRole('gerente', 'administrativo'), async (req, res) => {
    const { desde, hasta } = rangoDeFechas(req.query);
    const { limit, offset } = parsearPaginacion(req.query);
    const q = parsearBusqueda(req.query);
    try {
        const [equipos, lineas, facturas] = await Promise.all([
            q
                ? pool.query(
                    `SELECT id, codigo, tipo, estado FROM maquinarias
                     WHERE codigo ILIKE $1 OR tipo ILIKE $1 ORDER BY codigo`,
                    [`%${q}%`]
                  )
                : pool.query('SELECT id, codigo, tipo, estado FROM maquinarias ORDER BY codigo'),
            pool.query(SQL_LINEAS, [desde, hasta]),
            pool.query(SQL_FACTURAS, [desde, hasta]),
        ]);

        const lineasPorEquipo = agruparPorMaquinaria(lineas.rows);
        const facturasPorEquipo = agruparPorMaquinaria(facturas.rows);

        const resultado = equipos.rows
            .map((equipo) => ({
                ...equipo,
                ...calcularRentabilidad({
                    lineas: lineasPorEquipo.get(equipo.id) || [],
                    facturas: facturasPorEquipo.get(equipo.id) || [],
                }),
            }))
            // lo que sale a perdida arriba: es lo que hay que decidir
            .sort((a, b) => a.margen - b.margen);

        // el margen se calcula en memoria (cruza lineas y facturas), asi que la pagina se
        // recorta despues de ordenar: paginar en SQL daria un orden distinto al del margen
        const pagina = limit === null ? resultado : resultado.slice(offset, offset + limit);

        res.json({
            desde: desde.toISOString(),
            hasta: hasta.toISOString(),
            // el resumen se calcula sobre TODA la flota, no sobre la pagina: si contara solo
            // lo cargado, "3 equipos a perdida" cambiaria al pulsar "cargar mas" y enganaria
            resumen: {
                a_perdida: resultado.filter((e) => e.sale_a_perdida).length,
                lineas_sin_precio: resultado.reduce((n, e) => n + (e.lineas_sin_precio || 0), 0),
            },
            ...envolver(pagina, resultado.length, { limit, offset }),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al calcular la rentabilidad de la flota' });
    }
});

// GET /api/rentabilidad/maquinaria/:id - detalle de un equipo, con el desglose que lo respalda
router.get('/maquinaria/:id', verifyToken, requireRole('gerente', 'administrativo'), async (req, res) => {
    const { desde, hasta } = rangoDeFechas(req.query);
    const { id } = req.params;
    try {
        const equipo = await pool.query('SELECT id, codigo, tipo, estado FROM maquinarias WHERE id = $1', [id]);
        if (equipo.rows.length === 0) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }

        const [lineas, facturas] = await Promise.all([
            pool.query(
                `SELECT mi.id, mi.cantidad, mi.precio_unitario, mi.descripcion, mi.facturable,
                        mi.created_at, mi.orden_trabajo_id, i.nombre AS insumo_nombre
                 FROM movimientos_insumo mi
                 JOIN ordenes_trabajo ot ON ot.id = mi.orden_trabajo_id
                 LEFT JOIN insumos i ON i.id = mi.insumo_id
                 WHERE mi.tipo = 'salida' AND mi.anulada_at IS NULL AND ot.maquinaria_id = $1
                   AND mi.created_at BETWEEN $2 AND $3
                 ORDER BY mi.created_at DESC`,
                [id, desde, hasta]
            ),
            pool.query(
                `SELECT f.id, f.folio, f.monto, f.created_at, f.orden_trabajo_id
                 FROM facturas f
                 LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
                 WHERE COALESCE(f.maquinaria_id, ot.maquinaria_id) = $1
                   AND f.created_at BETWEEN $2 AND $3
                 ORDER BY f.created_at DESC`,
                [id, desde, hasta]
            ),
        ]);

        res.json({
            maquinaria: equipo.rows[0],
            desde: desde.toISOString(),
            hasta: hasta.toISOString(),
            ...calcularRentabilidad({ lineas: lineas.rows, facturas: facturas.rows }),
            lineas: lineas.rows.map((l) => ({
                ...l,
                cantidad: num(l.cantidad),
                precio_unitario: num(l.precio_unitario),
            })),
            facturas: facturas.rows.map((f) => ({ ...f, monto: num(f.monto) })),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al calcular la rentabilidad del equipo' });
    }
});

module.exports = router;
