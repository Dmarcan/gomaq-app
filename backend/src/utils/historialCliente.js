// Historial de un cliente: lo que ha arrendado, facturado y las ordenes de trabajo que se le hicieron.
// Armado puro (`armarHistorial`) y la lectura de la base (`cargarHistorialCliente`).
//
// No devuelve archivo_url ni URL firmadas: los documentos se abren desde el perfil del equipo o la orden.
// Los arriendos salen de utils/arriendos.js (una sola definicion de "arriendo") filtrados en memoria por
// cliente; con un cliente a la vez es aceptable, pero no llamarlo dentro de un bucle.

const { cargarArriendos } = require('./arriendos');

const TOPE_LISTA = 200;

const aNumero = (v) => (v === null || v === undefined ? null : Number(v));

// de la mas reciente a la mas antigua; las fechas son texto YYYY-MM-DD y los nulos van al final
function comparaDesc(campo) {
    return (a, b) => {
        const x = a[campo] || '';
        const y = b[campo] || '';
        if (x === y) return b.id - a.id;
        return x < y ? 1 : -1;
    };
}

function armarArriendo(a) {
    return {
        id: a.guia_despacho_id,
        guia_despacho_id: a.guia_despacho_id,
        guia_recepcion_id: a.guia_recepcion_id || null,
        maquinaria_id: a.maquinaria_id,
        maquinaria_codigo: a.maquinaria_codigo,
        inicio_cobro: a.inicio_cobro,
        fin: a.fin || null,
        en_curso: a.en_curso === true,
        falta_recepcion: a.falta_recepcion === true,
    };
}

/**
 * Arma la respuesta. Entradas:
 *   cliente     fila de la ficha
 *   arriendos   salida de cargarArriendos YA filtrada por este cliente
 *   facturas    filas (hasta tope + 1) y ordenes (hasta tope + 1)
 *   totales     { facturas, total_facturado } contados en la base sobre TODAS las facturas
 */
function armarHistorial({ cliente, arriendos = [], facturas = [], ordenes = [], totales = {}, tope = TOPE_LISTA }) {
    const arr = arriendos.map(armarArriendo).sort(comparaDesc('inicio_cobro'));
    const fac = facturas
        .map((f) => ({
            id: f.id,
            folio: f.folio,
            monto: aNumero(f.monto),
            monto_traslado: aNumero(f.monto_traslado) || 0,
            fecha_emision: f.fecha_emision || null,
            periodo_desde: f.periodo_desde || null,
            periodo_hasta: f.periodo_hasta || null,
            maquinaria_id: f.maquinaria_id ?? null,
            maquinaria_codigo: f.maquinaria_codigo ?? null,
            orden_trabajo_id: f.orden_trabajo_id ?? null,
        }))
        .sort(comparaDesc('fecha_emision'));
    const ord = ordenes
        .map((o) => ({
            id: o.id,
            estado: o.estado,
            origen: o.origen ?? null,
            maquinaria_id: o.maquinaria_id,
            maquinaria_codigo: o.maquinaria_codigo,
            fecha_creacion: o.fecha_creacion || null,
            fecha_cierre: o.fecha_cierre || null,
        }))
        .sort(comparaDesc('fecha_creacion'));

    const equiposHoy = new Set(arr.filter((a) => a.en_curso).map((a) => a.maquinaria_id));
    return {
        cliente,
        resumen: {
            equipos_arrendados_hoy: equiposHoy.size,
            arriendos: arr.length,
            facturas: totales.facturas ?? fac.length,
            total_facturado: totales.total_facturado ?? fac.reduce((s, f) => s + (f.monto || 0), 0),
        },
        arriendos: arr.slice(0, tope),
        facturas: fac.slice(0, tope),
        ordenes: ord.slice(0, tope),
        hay_mas: { arriendos: arr.length > tope, facturas: fac.length > tope, ordenes: ord.length > tope },
    };
}

const SQL_FACTURAS = `
    SELECT f.id, f.folio, f.monto, f.monto_traslado,
           to_char(f.fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
           to_char(f.periodo_desde, 'YYYY-MM-DD') AS periodo_desde,
           to_char(f.periodo_hasta, 'YYYY-MM-DD') AS periodo_hasta,
           f.orden_trabajo_id,
           COALESCE(f.maquinaria_id, ot.maquinaria_id) AS maquinaria_id,
           m.codigo AS maquinaria_codigo
    FROM facturas f
    LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
    LEFT JOIN maquinarias m ON m.id = COALESCE(f.maquinaria_id, ot.maquinaria_id)
    WHERE COALESCE(f.cliente_id, ot.cliente_id) = $1
    ORDER BY f.fecha_emision DESC NULLS LAST, f.id DESC
    LIMIT $2
`;

const SQL_TOTALES = `
    SELECT COUNT(*)::int AS facturas, COALESCE(SUM(f.monto), 0) AS total_facturado
    FROM facturas f
    LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
    WHERE COALESCE(f.cliente_id, ot.cliente_id) = $1
`;

const SQL_ORDENES = `
    SELECT ot.id, ot.estado, ot.origen, ot.maquinaria_id, m.codigo AS maquinaria_codigo,
           to_char(ot.fecha_creacion AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') AS fecha_creacion,
           to_char(ot.fecha_cierre AT TIME ZONE 'America/Santiago', 'YYYY-MM-DD') AS fecha_cierre
    FROM ordenes_trabajo ot
    JOIN maquinarias m ON m.id = ot.maquinaria_id
    WHERE ot.cliente_id = $1
    ORDER BY ot.fecha_creacion DESC, ot.id DESC
    LIMIT $2
`;

/** Lee el historial de un cliente. Devuelve null si el cliente no existe. */
async function cargarHistorialCliente(db, config, clienteId) {
    const cli = await db.query('SELECT * FROM clientes WHERE id = $1', [clienteId]);
    if (cli.rows.length === 0) return null;
    const [todos, fac, tot, ord] = await Promise.all([
        cargarArriendos(db, config),
        db.query(SQL_FACTURAS, [clienteId, TOPE_LISTA + 1]),
        db.query(SQL_TOTALES, [clienteId]),
        db.query(SQL_ORDENES, [clienteId, TOPE_LISTA + 1]),
    ]);
    return armarHistorial({
        cliente: cli.rows[0],
        arriendos: todos.filter((a) => a.cliente_id === clienteId),
        facturas: fac.rows,
        ordenes: ord.rows,
        totales: { facturas: tot.rows[0].facturas, total_facturado: Number(tot.rows[0].total_facturado) },
    });
}

module.exports = { armarHistorial, cargarHistorialCliente, TOPE_LISTA };
