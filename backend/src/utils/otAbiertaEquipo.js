// OT abierta (cualquier estado distinto de finalizada) mas reciente de un equipo. El panel la usa
// para avisar al crear una OT nueva. Solo administrativo y gerente: mecanico no la recibe.

const ROLES_CON_OT_ABIERTA = ['administrativo', 'gerente'];

// Una subconsulta que devuelve un objeto JSON {id, estado} o NULL, para la columna `ot_abierta`
const SQL_OT_ABIERTA = `(SELECT json_build_object('id', o.id, 'estado', o.estado)
                          FROM ordenes_trabajo o
                          WHERE o.maquinaria_id = m.id AND o.estado <> 'finalizada'
                          ORDER BY o.id DESC LIMIT 1) AS ot_abierta`;

/** Fragmento SELECT (con coma inicial) para el rol, o cadena vacia si ese rol no la recibe. */
function columnaOtAbierta(rol) {
    return ROLES_CON_OT_ABIERTA.includes(rol) ? `, ${SQL_OT_ABIERTA}` : '';
}

module.exports = { SQL_OT_ABIERTA, ROLES_CON_OT_ABIERTA, columnaOtAbierta };
