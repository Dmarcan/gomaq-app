// Reintentos sin duplicados desde la cola offline del movil (migracion 015).
//
// La app reintenta una tarea cuando no recibe respuesta, pero el servidor puede haberla guardado
// y perdido solo la respuesta. Cada tarea trae un UUID generado en el telefono: si ya existe una
// fila con ese UUID, la tarea ya se hizo y se devuelve esa fila en vez de crear otra.

const { UUID } = require('./validacion');

/**
 * Lee `uuid_cliente` del cuerpo. Es opcional (el panel y los APK anteriores no lo envian), pero
 * si viene tiene que ser un UUID: un valor malformado haria fallar el cast de Postgres con un 500.
 */
function leerUuidCliente(body) {
    const valor = body ? body.uuid_cliente : undefined;
    if (valor === undefined || valor === null || valor === '') return { valido: true, uuid: null };
    if (typeof valor !== 'string' || !UUID.test(valor)) return { valido: false, uuid: null };
    return { valido: true, uuid: valor.toLowerCase() };
}

// Tablas que aceptan uuid_cliente. Lista cerrada: el nombre de la tabla se interpola en el SQL.
const TABLAS = new Set([
    'movimientos_insumo', 'tramos_trabajo', 'lecturas_horometro',
    'evidencias_fotograficas', 'ordenes_trabajo', 'guias',
]);

/** La fila ya creada con ese UUID, o null. */
async function buscarPorUuid(db, tabla, uuid) {
    if (!uuid) return null;
    if (!TABLAS.has(tabla)) throw new Error(`Tabla sin uuid_cliente: ${tabla}`);
    const r = await db.query(`SELECT * FROM ${tabla} WHERE uuid_cliente = $1`, [uuid]);
    return r.rows[0] || null;
}

/**
 * Dos reintentos que llegan a la vez pasan los dos por buscarPorUuid sin encontrar nada, y el
 * segundo choca con el UNIQUE al insertar. Ese choque tambien significa "ya estaba hecho".
 */
function esUuidDuplicado(err) {
    return Boolean(err && err.code === '23505' && String(err.constraint || '').includes('uuid_cliente'));
}

module.exports = { leerUuidCliente, buscarPorUuid, esUuidDuplicado };
