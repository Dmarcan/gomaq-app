// Cliente actual de un equipo (maquinarias.cliente_id), derivado de sus guias.
//
// Fuente de verdad: la guia mas reciente POR FECHA (desempate por id), sin contar las fallidas.
// Si es un despacho, el equipo esta con el cliente de esa guia; si es una recepcion, esta libre.
// Es el mismo orden que usa la facturacion (utils/arriendos.js: ORDER BY fecha, id), asi el panel
// y el cobro nunca discrepan.
//
// Antes cada guia pisaba maquinarias.cliente_id segun el orden de LLEGADA: una recepcion
// atrasada (con fecha anterior a un despacho ya registrado) dejaba el equipo sin cliente, y dos
// despachos simultaneos a clientes distintos quedaban con el del ultimo UPDATE y no el de la
// guia mas reciente.
//
// Estas funciones asumen que quien llama ya tiene bloqueada la fila del equipo en la misma
// transaccion (FOR NO KEY UPDATE), que es lo que serializa a los escritores.

/** Guia vigente de un equipo: la mas reciente por fecha que no es fallida. */
const SQL_GUIA_VIGENTE = `
    SELECT g.tipo, g.cliente_id
    FROM guias g
    WHERE g.maquinaria_id = $1 AND g.fallido = false
    ORDER BY g.fecha DESC, g.id DESC
    LIMIT 1`;

/** Cliente que corresponde a un equipo segun su guia vigente (null si esta libre). */
function clienteSegunGuia(guia) {
    return guia && guia.tipo === 'despacho' ? guia.cliente_id : null;
}

/**
 * Deja maquinarias.cliente_id igual a lo que dicen las guias. Se llama despues de insertar una
 * guia no fallida, asi que siempre hay al menos una.
 */
async function recalcularClienteEquipo(client, maquinariaId) {
    const r = await client.query(SQL_GUIA_VIGENTE, [maquinariaId]);
    if (r.rows.length === 0) return null;
    const cliente = clienteSegunGuia(r.rows[0]);
    await client.query('UPDATE maquinarias SET cliente_id = $1 WHERE id = $2', [cliente, maquinariaId]);
    return cliente;
}

/**
 * Cliente con el que estaba el equipo en un instante: el de la ultima guia no fallida con fecha
 * igual o anterior. Es lo que se guarda en una recepcion como cliente de la guia. Sin guias
 * anteriores (equipo cargado a mano) se usa el cliente actual del equipo.
 */
async function clienteAlMomento(client, maquinariaId, fecha, clienteActual) {
    const r = await client.query(
        `SELECT g.tipo, g.cliente_id
         FROM guias g
         WHERE g.maquinaria_id = $1 AND g.fallido = false AND g.fecha <= COALESCE($2::timestamptz, now())
         ORDER BY g.fecha DESC, g.id DESC
         LIMIT 1`,
        [maquinariaId, fecha || null]
    );
    if (r.rows.length === 0) return clienteActual;
    return clienteSegunGuia(r.rows[0]);
}

module.exports = { SQL_GUIA_VIGENTE, clienteSegunGuia, recalcularClienteEquipo, clienteAlMomento };
