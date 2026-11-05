// Documentos de un equipo (guias, ordenes de trabajo y facturas) y quien puede verlos.
//
// Un equipo pasa por varios clientes (ACSA, Prize, Servinut, ACSA...), asi que lo que ve cada
// cliente sale SIEMPRE del cliente que el propio documento guardo al momento del evento
// (guias.cliente_id, ordenes_trabajo.cliente_id, facturas.cliente_id), nunca de
// maquinarias.cliente_id, que es el cliente de hoy.
//
// El filtro por cliente va en el SQL (cada rama del UNION) y se repite con `visiblePara` como
// segunda defensa antes de responder.

/**
 * @param {{tipo: string, cliente_id: number|null}} doc  documento ya leido
 * @param {{rol: string, cliente_id?: number|null}} usuario
 */
function visiblePara(doc, usuario) {
    if (!usuario) return false;
    if (usuario.rol === 'gerente' || usuario.rol === 'administrativo') return true;
    if (usuario.rol === 'cliente') {
        return usuario.cliente_id != null && doc.cliente_id != null && Number(doc.cliente_id) === Number(usuario.cliente_id);
    }
    return false; // mecanico y cualquier rol desconocido
}

/**
 * Arma la consulta de documentos.
 *
 * Parametros: $1 = id del equipo; para el cliente, $2 = su cliente_id y $3 = momento en que se
 * aplico la migracion 010 (las guias anteriores recibieron su cliente por un relleno que copio el
 * cliente de hoy del equipo, asi que no son confiables para un cliente). Para administrativo y
 * gerente, $2 = filtro opcional por cliente (puede ser null).
 */
function construirSqlDocumentos({ rol }) {
    const esCliente = rol === 'cliente';
    const filtroGuia = esCliente
        ? 'AND g.cliente_id = $2 AND g.created_at >= $3::timestamptz'
        : 'AND ($2::int IS NULL OR g.cliente_id = $2)';
    const filtroOt = esCliente ? 'AND ot.cliente_id = $2' : 'AND ($2::int IS NULL OR ot.cliente_id = $2)';
    // la factura colgada de una guia (de recepcion o de despacho) anterior a la 010 hereda su cliente de esa guia
    const filtroFactura = esCliente
        ? `AND COALESCE(f.cliente_id, ot.cliente_id) = $2
           AND (f.guia_recepcion_id IS NULL OR EXISTS (
                SELECT 1 FROM guias gr WHERE gr.id = f.guia_recepcion_id AND gr.created_at >= $3::timestamptz))
           AND (f.guia_despacho_id IS NULL OR EXISTS (
                SELECT 1 FROM guias gd WHERE gd.id = f.guia_despacho_id AND gd.created_at >= $3::timestamptz))`
        : 'AND ($2::int IS NULL OR COALESCE(f.cliente_id, ot.cliente_id) = $2)';

    // al cliente no se le da el id de una OT que no es de su empresa (la factura de arriendo puede apuntar a otra)
    const idOtFactura = esCliente ? 'CASE WHEN ot.cliente_id = $2 THEN f.orden_trabajo_id END' : 'f.orden_trabajo_id';

    return `
        SELECT 'guia_' || g.tipo::text AS tipo, g.id, g.fecha AS fecha, NULL::text AS folio,
               g.cliente_id, g.archivo_url, (g.archivo_url IS NULL) AS sin_documento, g.fallido,
               NULL::text AS estado, NULL::text AS motivo, NULL::date AS periodo_desde, NULL::date AS periodo_hasta,
               NULL::int AS orden_trabajo_id, NULL::numeric AS valorizacion, NULL::timestamptz AS fecha_cierre
        FROM guias g
        WHERE g.maquinaria_id = $1 ${filtroGuia}
        UNION ALL
        SELECT 'orden_trabajo', ot.id, ot.fecha_creacion, NULL, ot.cliente_id, NULL, false, false,
               ot.estado::text, ot.motivo, NULL, NULL, ot.id, ot.valorizacion, ot.fecha_cierre
        FROM ordenes_trabajo ot
        WHERE ot.maquinaria_id = $1 ${filtroOt}
        UNION ALL
        SELECT 'factura', f.id, COALESCE(f.fecha_emision::timestamp AT TIME ZONE 'America/Santiago', f.created_at), f.folio,
               COALESCE(f.cliente_id, ot.cliente_id), f.archivo_url, false, false,
               NULL, NULL, f.periodo_desde, f.periodo_hasta, ${idOtFactura}, NULL, NULL
        FROM facturas f
        LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
        WHERE COALESCE(f.maquinaria_id, ot.maquinaria_id) = $1 ${filtroFactura}
        ORDER BY 3 DESC, 2 DESC`;
}

/**
 * Deja la fila lista para responder: ruta firmada en lugar de archivo_url y, para el cliente, sin
 * valorizacion (es un dato interno de GOMAQ).
 */
function filaPublica(fila, { rol, urlFirmada }) {
    const { archivo_url: _ruta, valorizacion, fecha_cierre: fechaCierre, ...resto } = fila;
    const salida = { ...resto, url: urlFirmada || null };
    if (fila.tipo === 'orden_trabajo') salida.fecha_cierre = fechaCierre;
    if (rol !== 'cliente' && fila.tipo === 'orden_trabajo') salida.valorizacion = valorizacion === null ? null : Number(valorizacion);
    return salida;
}


/**
 * Equipos con al menos un documento propio de un cliente (los que tiene hoy y los que tuvo antes),
 * con las mismas reglas de visibilidad que construirSqlDocumentos para el rol cliente.
 * Parametros: $1 = cliente_id del token, $2 = momento en que se aplico la migracion 010.
 * Devuelve por equipo: id, codigo, tipo, actual (esta con el cliente hoy), primer_documento y
 * ultimo_documento. Nunca datos de otros clientes ni costos.
 */
function construirSqlEquiposDelCliente() {
    return `
        WITH docs AS (
            SELECT g.maquinaria_id, g.fecha AS fecha
            FROM guias g
            WHERE g.cliente_id = $1 AND g.created_at >= $2::timestamptz
            UNION ALL
            SELECT ot.maquinaria_id, ot.fecha_creacion
            FROM ordenes_trabajo ot
            WHERE ot.cliente_id = $1
            UNION ALL
            SELECT COALESCE(f.maquinaria_id, ot.maquinaria_id), COALESCE(f.fecha_emision::timestamp AT TIME ZONE 'America/Santiago', f.created_at)
            FROM facturas f
            LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
            WHERE COALESCE(f.cliente_id, ot.cliente_id) = $1
              AND COALESCE(f.maquinaria_id, ot.maquinaria_id) IS NOT NULL
              AND (f.guia_recepcion_id IS NULL OR EXISTS (
                   SELECT 1 FROM guias gr WHERE gr.id = f.guia_recepcion_id AND gr.created_at >= $2::timestamptz))
              AND (f.guia_despacho_id IS NULL OR EXISTS (
                   SELECT 1 FROM guias gd WHERE gd.id = f.guia_despacho_id AND gd.created_at >= $2::timestamptz))
        )
        SELECT m.id, m.codigo, m.tipo, COALESCE(m.cliente_id = $1, false) AS actual,
               MIN(d.fecha) AS primer_documento, MAX(d.fecha) AS ultimo_documento
        FROM docs d
        JOIN maquinarias m ON m.id = d.maquinaria_id
        GROUP BY m.id, m.codigo, m.tipo, m.cliente_id
        ORDER BY COALESCE(m.cliente_id = $1, false) DESC, MAX(d.fecha) DESC, m.codigo`;
}

module.exports = { visiblePara, construirSqlDocumentos, construirSqlEquiposDelCliente, filaPublica };
