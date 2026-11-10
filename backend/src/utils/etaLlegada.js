// Hora estimada de llegada del mecanico, como hora absoluta. La comparten el listado del cliente
// (/mias) y el detalle de la OT para administrativo y gerente. Solo existe mientras la OT esta
// en camino; las columnas internas de la ETA (origen, cupo, ajuste) nunca salen.

const SQL_ETA_LLEGADA_AT = `CASE WHEN ot.estado = 'en_camino' AND ot.eta_segundos IS NOT NULL
                         THEN COALESCE(ot.eta_ajustada_llegada_at,
                                       ot.eta_calculada_at + make_interval(secs => ot.eta_segundos)) END`;

const ROLES_CON_LLEGADA = ['administrativo', 'gerente'];

/**
 * Deja `eta_llegada_at` en la fila solo si quien pide es administrativo o gerente y la OT esta
 * en camino. Para cualquier otro rol la respuesta no gana ningun campo.
 */
function conLlegadaEstimada(fila, rol) {
    const copia = { ...fila };
    if (!(ROLES_CON_LLEGADA.includes(rol) && copia.estado === 'en_camino' && copia.eta_llegada_at)) {
        delete copia.eta_llegada_at;
    }
    return copia;
}

module.exports = { SQL_ETA_LLEGADA_AT, ROLES_CON_LLEGADA, conLlegadaEstimada };
