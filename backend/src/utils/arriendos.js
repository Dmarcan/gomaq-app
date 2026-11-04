// Lectura de arriendos desde las guias (bloque 2b): una sola definicion de "arriendo" que comparten
// /pendientes, /arriendos-en-curso y la propuesta de periodo.
//
// Un arriendo es un despacho no fallido. Lo cierra la siguiente guia no fallida del mismo equipo
// (orden por fecha e id):
//   - una recepcion: el arriendo termina ese dia (menos uno si el dia de recepcion no cuenta);
//   - otro despacho: cierre implicito con la misma formula sobre la fecha del segundo despacho y el
//     aviso `falta_recepcion` (no deberia pasar; si pasa, el segundo es otro arriendo, de otro cliente);
//   - ninguna: el arriendo sigue en curso.
// Una recepcion sin despacho antes (o precedida por otra recepcion) no es un arriendo y se ignora.

const { diaSantiago, sumarDias } = require('./diasArriendo');
const { proponerPeriodo } = require('./periodosArriendo');

const SQL_ARRIENDOS = `
    WITH ordenadas AS (
        SELECT g.id, g.maquinaria_id, g.tipo, g.fecha, g.cliente_id, g.inicio_cobro,
               LEAD(g.id) OVER w AS sig_id,
               LEAD(g.tipo) OVER w AS sig_tipo,
               LEAD(g.fecha) OVER w AS sig_fecha
        FROM guias g
        WHERE g.fallido = false
        WINDOW w AS (PARTITION BY g.maquinaria_id ORDER BY g.fecha, g.id)
    )
    SELECT o.id AS guia_despacho_id, o.maquinaria_id, m.codigo AS maquinaria_codigo,
           o.cliente_id, c.nombre AS cliente_nombre, c.email AS cliente_email,
           o.fecha AS fecha_despacho,
           to_char(COALESCE(o.inicio_cobro, gomaq_inicio_cobro(o.fecha, $1)), 'YYYY-MM-DD') AS inicio_cobro,
           CASE WHEN o.sig_tipo = 'recepcion' THEN o.sig_id END AS guia_recepcion_id,
           o.sig_tipo, o.sig_fecha AS fecha_fin,
           to_char(fa.facturado_hasta, 'YYYY-MM-DD') AS facturado_hasta,
           (fa.hay_final OR (o.sig_tipo = 'recepcion' AND EXISTS (
                SELECT 1 FROM facturas f2 WHERE f2.guia_recepcion_id = o.sig_id))) AS facturado_completo,
           to_char(now() AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') AS hoy
    FROM ordenadas o
    JOIN maquinarias m ON m.id = o.maquinaria_id
    LEFT JOIN clientes c ON c.id = o.cliente_id
    LEFT JOIN LATERAL (
        SELECT MAX(f.periodo_hasta) AS facturado_hasta,
               COALESCE(bool_or(f.guia_recepcion_id IS NOT NULL), false) AS hay_final
        FROM facturas f WHERE f.guia_despacho_id = o.id
    ) fa ON true
    WHERE o.tipo = 'despacho'
      AND ($2::int IS NULL OR o.id = $2)
      AND ($3::int IS NULL OR o.sig_id = $3)
      AND ($4::int IS NULL OR o.maquinaria_id = $4)
    ORDER BY o.maquinaria_id, o.fecha, o.id
`;

/** Ultimo dia del arriendo a partir de la guia que lo cierra, o null si sigue en curso. */
function finDelArriendo(fila, incluirDiaRecepcion) {
    if (!fila.sig_tipo) return null;
    const dia = diaSantiago(fila.fecha_fin);
    return incluirDiaRecepcion ? dia : sumarDias(dia, -1);
}

/**
 * Arriendos con su estado de facturacion y la propuesta del proximo periodo.
 * Filtros opcionales: despachoId, recepcionId (la que lo cierra), maquinariaId.
 */
async function cargarArriendos(db, config, { despachoId = null, recepcionId = null, maquinariaId = null } = {}) {
    const r = await db.query(SQL_ARRIENDOS, [config.hora_corte_despacho, despachoId, recepcionId, maquinariaId]);
    return r.rows.map((fila) => {
        const fin = finDelArriendo(fila, config.incluir_dia_recepcion);
        const propuesta = proponerPeriodo({
            inicioCobro: fila.inicio_cobro,
            facturadoHasta: fila.facturado_hasta,
            fin,
            hoy: fila.hoy,
            diaFacturacion: config.dia_facturacion,
            corteCierraPeriodo: config.corte_cierra_periodo,
        });
        return {
            ...fila,
            fin,
            en_curso: fin === null,
            falta_recepcion: fila.sig_tipo === 'despacho',
            ...propuesta,
            // un arriendo con factura final, o ya facturado mas alla de su fin, no tiene nada mas que facturar
            nada_que_facturar: propuesta.nada_que_facturar || fila.facturado_completo,
        };
    });
}

module.exports = { SQL_ARRIENDOS, cargarArriendos, finDelArriendo };
