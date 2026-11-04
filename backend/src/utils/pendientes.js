// Predicados de los "pendientes" que comparten el contador del dashboard y la lista a la que lleva
// cada uno. Una sola definicion: el numero y la lista no pueden discrepar (se prueba comparando el
// contador con el largo de la lista real en test/escritura.test.js y test/integracion.test.js).

/** Solicitudes de asistencia de clientes que nadie atendio (GET /api/solicitudes?estado=pendiente). */
const SQL_SOLICITUDES_POR_ATENDER = `estado = 'pendiente'`;

/** Guias registradas sin PDF (GET /api/maquinarias/guias/recientes?sin_documento=1). `alias` es el de la tabla. */
const sqlGuiasSinDocumento = (alias = '') => `${alias ? alias + '.' : ''}archivo_url IS NULL`;

/** Solicitudes de cuenta de cliente por aprobar (GET /api/usuarios/solicitudes). */
const SQL_CUENTAS_POR_APROBAR = `estado = 'pendiente'`;

/** Existencias negativas por ubicacion (GET /api/insumos/descuadres). */
const SQL_DESCUADRES = `cantidad < 0`;

module.exports = { SQL_SOLICITUDES_POR_ATENDER, sqlGuiasSinDocumento, SQL_CUENTAS_POR_APROBAR, SQL_DESCUADRES };
