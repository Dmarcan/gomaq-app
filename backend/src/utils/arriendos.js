// Lectura de arriendos desde las guias: una sola definicion de "arriendo" que comparten
// /pendientes, /arriendos-en-curso y la propuesta de periodo.
//
// Un arriendo es un despacho no fallido. Lo cierra la siguiente guia no fallida del mismo equipo
// (orden por fecha e id):
//   - una recepcion: el arriendo termina en guias.fin_cobro (fijado al registrarla con la hora de corte
//     de ese momento: el mismo dia si ocurre desde el corte, el dia anterior si ocurre antes);
//   - otro despacho: cierre implicito, con el aviso `falta_recepcion` (no deberia pasar; si pasa, el
//     segundo es otro arriendo, de otro cliente). Termina el dia anterior al inicio_cobro guardado del
//     segundo despacho, asi el dia del cambio se cobra a uno solo (al nuevo si el cambio fue antes del
//     corte, al anterior si fue desde el corte) aunque la configuracion cambie despues;
//   - ninguna: el arriendo sigue en curso.
// Una recepcion sin despacho antes (o precedida por otra recepcion) no es un arriendo y se ignora.

const { finCobroDia, inicioCobroDia, sumarDias } = require('./diasArriendo');
const { proponerPeriodo, resumirArriendoEnCurso } = require('./periodosArriendo');

const SQL_ARRIENDOS = `
    WITH ordenadas AS (
        SELECT g.id, g.maquinaria_id, g.tipo, g.fecha, g.cliente_id, g.inicio_cobro,
               LEAD(g.id) OVER w AS sig_id,
               LEAD(g.tipo) OVER w AS sig_tipo,
               LEAD(g.fecha) OVER w AS sig_fecha,
               to_char(LEAD(g.fin_cobro) OVER w, 'YYYY-MM-DD') AS sig_fin_cobro,
               to_char(LEAD(g.inicio_cobro) OVER w, 'YYYY-MM-DD') AS sig_inicio_cobro
        FROM guias g
        WHERE g.fallido = false
        WINDOW w AS (PARTITION BY g.maquinaria_id ORDER BY g.fecha, g.id)
    )
    SELECT o.id AS guia_despacho_id, o.maquinaria_id, m.codigo AS maquinaria_codigo,
           o.cliente_id, c.nombre AS cliente_nombre, c.email AS cliente_email,
           o.fecha AS fecha_despacho,
           to_char(COALESCE(o.inicio_cobro, gomaq_inicio_cobro(o.fecha, $1)), 'YYYY-MM-DD') AS inicio_cobro,
           CASE WHEN o.sig_tipo = 'recepcion' THEN o.sig_id END AS guia_recepcion_id,
           o.sig_tipo, o.sig_fecha AS fecha_fin, o.sig_fin_cobro, o.sig_inicio_cobro,
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

/**
 * Ultimo dia del arriendo, o null si sigue en curso. Sale de lo que quedo GUARDADO al registrar la
 * guia que lo cierra, para que cambiar la hora de corte despues no deje huecos ni dias dobles:
 *   - recepcion: guias.fin_cobro (migracion 028);
 *   - despacho siguiente: el dia anterior a su inicio_cobro guardado (complemento exacto del inicio).
 * Si falta el dato guardado (guias anteriores a la migracion sin relleno), recalcula con la hora de corte.
 */
function finDelArriendo(fila, horaCorte) {
    if (!fila.sig_tipo) return null;
    if (fila.sig_tipo === 'recepcion') {
        return fila.sig_fin_cobro || finCobroDia(fila.fecha_fin, horaCorte);
    }
    return sumarDias(fila.sig_inicio_cobro || inicioCobroDia(fila.fecha_fin, horaCorte), -1);
}

/**
 * Arriendos con su estado de facturacion y la propuesta del proximo periodo.
 * Filtros opcionales: despachoId, recepcionId (la que lo cierra), maquinariaId.
 */
async function cargarArriendos(db, config, { despachoId = null, recepcionId = null, maquinariaId = null } = {}) {
    const r = await db.query(SQL_ARRIENDOS, [config.hora_corte_despacho, despachoId, recepcionId, maquinariaId]);
    return r.rows.map((fila) => {
        const fin = finDelArriendo(fila, config.hora_corte_despacho);
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

/**
 * Arriendos cerrados con algo que facturar: la lista "Por facturar". Incluye el facturado de mas
 * (recepcion registrada con fecha anterior a lo ya facturado), que se muestra con su aviso.
 */
function filtrarPorFacturar(todos) {
    return todos.filter((a) => !a.en_curso && (!a.nada_que_facturar || a.facturado_de_mas));
}

/** Resumen de un arriendo en curso: desde cuando, dias, periodos sin facturar y proximo corte. */
function resumenEnCurso(a, config) {
    return resumirArriendoEnCurso({
        inicioCobro: a.inicio_cobro,
        ultimoPeriodoHasta: a.facturado_hasta,
        hoy: a.hoy,
        diaFacturacion: config.dia_facturacion,
        corteCierraPeriodo: config.corte_cierra_periodo,
    });
}

/** Arriendos en curso que ya cumplieron algun corte sin facturar (el "aviso" de la pestana). */
function filtrarConAviso(todos, config) {
    return todos.filter((a) => a.en_curso && resumenEnCurso(a, config).aviso);
}

module.exports = { SQL_ARRIENDOS, cargarArriendos, finDelArriendo, filtrarPorFacturar, resumenEnCurso, filtrarConAviso };
