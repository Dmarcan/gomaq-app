// Lista de facturas emitidas con su estado de cobranza (GET /api/facturacion/emitidas).
//
// `armarFilaEmitida` es pura; `cargarEmitidas` hace la consulta con los predicados de utils/cobranza.js (los
// mismos que cuentan las tarjetas del inicio). El estado de cada fila se calcula con el "hoy" que devuelve la
// propia consulta, asi el filtro SQL y el estado de la fila usan exactamente el mismo dia.
//
// No devuelve archivo_url: el PDF se abre desde el perfil del equipo o la orden, con URL firmada.

const { FILTROS_ESTADO, SQL_HOY, estadoCobranza, diasMora, diasParaVencer } = require('./cobranza');

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Fila de la consulta -> fila de la respuesta. `hoy` es 'YYYY-MM-DD' en Santiago. */
function armarFilaEmitida(f, hoy) {
    const base = {
        fecha_vencimiento: f.fecha_vencimiento || null,
        fecha_pago: f.fecha_pago || null,
        anulada_nc: f.anulada_nc || null,
    };
    return {
        id: Number(f.id),
        folio: f.folio,
        tipo: f.orden_trabajo_id === null || f.orden_trabajo_id === undefined ? 'arriendo' : 'reparacion',
        orden_trabajo_id: num(f.orden_trabajo_id),
        cliente_id: num(f.cliente_id),
        cliente_nombre: f.cliente_nombre || null,
        ejecutivo_id: num(f.ejecutivo_id),
        ejecutivo_nombre: f.ejecutivo_nombre || null,
        maquinaria_id: num(f.maquinaria_id),
        maquinaria_codigo: f.maquinaria_codigo || null,
        periodo_desde: f.periodo_desde || null,
        periodo_hasta: f.periodo_hasta || null,
        monto: num(f.monto),
        monto_neto: num(f.monto_neto),
        monto_traslado: num(f.monto_traslado) ?? 0,
        traslado_entrega: num(f.traslado_entrega),
        traslado_retiro: num(f.traslado_retiro),
        fecha_emision: f.fecha_emision || null,
        ...base,
        estado_cobranza: estadoCobranza(base, hoy),
        dias_mora: diasMora(base, hoy),
        dias_para_vencer: diasParaVencer(base, hoy),
    };
}

// cliente: el de la factura, el de la OT o el de la guia de recepcion (facturas de arriendo antiguas)
const SQL_CLIENTE = 'COALESCE(f.cliente_id, ot.cliente_id, g.cliente_id)';
// fecha para el filtro desde/hasta: la emision, o el dia de carga si la factura no la tiene
const SQL_FECHA_REF = `COALESCE(f.fecha_emision, (f.created_at AT TIME ZONE 'America/Santiago')::date)`;

const DESDE_JOIN = `
    FROM facturas f
    LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
    LEFT JOIN guias g ON g.id = f.guia_recepcion_id
    LEFT JOIN clientes c ON c.id = ${SQL_CLIENTE}
    LEFT JOIN ejecutivos e ON e.id = c.ejecutivo_id
    LEFT JOIN maquinarias m ON m.id = COALESCE(f.maquinaria_id, ot.maquinaria_id)
`;

const escaparLike = (texto) => texto.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Lee las facturas emitidas.
 * @param {{estado?: string, clienteId?: number|null, q?: string|null, desde?: string|null, hasta?: string|null,
 *          id?: number|null, limit?: number|null, offset?: number}} filtros  `estado` debe ser una clave de FILTROS_ESTADO
 * @returns {Promise<{items: Array, total: number, hoy: string}>}
 */
async function cargarEmitidas(db, { estado = 'todas', clienteId = null, q = null, desde = null, hasta = null, id = null, limit = null, offset = 0 } = {}) {
    const predicado = FILTROS_ESTADO[estado];
    if (!predicado) throw new Error(`estado de cobranza desconocido: ${estado}`);
    const params = [clienteId, q ? `%${escaparLike(q)}%` : null, desde, hasta, id];
    const donde = `
        WHERE ${predicado}
          AND ($1::int IS NULL OR ${SQL_CLIENTE} = $1::int)
          AND ($2::text IS NULL OR f.folio ILIKE $2::text OR c.nombre ILIKE $2::text)
          AND ($3::date IS NULL OR ${SQL_FECHA_REF} >= $3::date)
          AND ($4::date IS NULL OR ${SQL_FECHA_REF} <= $4::date)
          AND ($5::int IS NULL OR f.id = $5::int)`;
    // por cobrar: lo que vence primero arriba (la vencida hace mas tiempo); el resto, la emision mas reciente
    const orden = ['vencidas', 'proximas', 'por_cobrar'].includes(estado)
        ? 'f.fecha_vencimiento ASC NULLS LAST, f.id ASC'
        : `${SQL_FECHA_REF} DESC, f.id DESC`;
    const [filas, conteo] = await Promise.all([
        db.query(
            `SELECT f.id, f.folio, f.orden_trabajo_id, ${SQL_CLIENTE} AS cliente_id, c.nombre AS cliente_nombre,
                    e.id AS ejecutivo_id, e.nombre AS ejecutivo_nombre,
                    COALESCE(f.maquinaria_id, ot.maquinaria_id) AS maquinaria_id, m.codigo AS maquinaria_codigo,
                    to_char(f.periodo_desde, 'YYYY-MM-DD') AS periodo_desde, to_char(f.periodo_hasta, 'YYYY-MM-DD') AS periodo_hasta,
                    f.monto, f.monto_neto, f.monto_traslado, f.traslado_entrega, f.traslado_retiro,
                    to_char(f.fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
                    to_char(f.fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento,
                    to_char(f.fecha_pago, 'YYYY-MM-DD') AS fecha_pago,
                    f.anulada_nc,
                    to_char(${SQL_HOY}, 'YYYY-MM-DD') AS hoy
             ${DESDE_JOIN}
             ${donde}
             ORDER BY ${orden}
             LIMIT $6 OFFSET $7`,
            [...params, limit, offset || 0]
        ),
        db.query(
            `SELECT COUNT(*)::int AS n, to_char(${SQL_HOY}, 'YYYY-MM-DD') AS hoy ${DESDE_JOIN} ${donde}`,
            params
        ),
    ]);
    const hoy = conteo.rows[0].hoy;
    return {
        items: filas.rows.map((f) => armarFilaEmitida(f, f.hoy || hoy)),
        total: conteo.rows[0].n,
        hoy,
    };
}

module.exports = { armarFilaEmitida, cargarEmitidas, SQL_CLIENTE, SQL_FECHA_REF, DESDE_JOIN };
