// Piezas que comparten los routers de insumos.

const { esIdPositivo } = require('../../utils/auditoriaLinea');

/** Id escrito en el cuerpo de una peticion: numero entero positivo o texto de digitos (no arreglos, ni booleanos). */
const idDeCuerpoValido = (v) => (typeof v === 'number'
    ? Number.isInteger(v) && v > 0 && v <= 2147483647
    : typeof v === 'string' && esIdPositivo(v));

/** La bodega central: destino de las compras y origen de lo que se carga a los furgones. */
async function bodegaCentral(client) {
    const r = await client.query("SELECT id FROM ubicaciones_stock WHERE tipo = 'bodega' ORDER BY id LIMIT 1");
    return r.rows[0] ? r.rows[0].id : null;
}

/** Ubicacion de stock del mecanico: el furgon de su vehiculo asignado. */
async function furgonDe(client, usuarioId) {
    const r = await client.query(
        `SELECT u.id FROM ubicaciones_stock u
         JOIN vehiculos v ON v.id = u.vehiculo_id
         WHERE v.usuario_id = $1 AND u.activa = true AND v.activo = true
         LIMIT 1`,
        [usuarioId]
    );
    return r.rows[0] ? r.rows[0].id : null;
}

/**
 * Mueve stock en una ubicacion y deja `insumos.stock_actual` como el total de todas ellas.
 *
 * Mantener `stock_actual` derivado, en vez de borrarlo, deja intacta la pantalla de Insumos
 * del panel y `GET /api/insumos` - mismo criterio que se uso con ordenes_trabajo.facturable.
 *
 * La cantidad puede quedar negativa: si el mecanico instalo un repuesto que el sistema no
 * tenia registrado en su furgon, bloquearlo solo haria que el dato se pierda.
 */
async function moverStock(client, { ubicacionId, insumoId, delta }) {
    // Orden de bloqueo: SIEMPRE el insumo y despues su fila de stock_ubicacion. stock_actual es la
    // suma de todas las ubicaciones del insumo: sin este candado, dos movimientos del mismo insumo
    // en ubicaciones distintas calculaban la suma con datos viejos y uno pisaba al otro (en READ
    // COMMITTED). FOR NO KEY UPDATE y no FOR UPDATE: los INSERT de movimientos_insumo toman KEY SHARE
    // sobre el insumo por la clave foranea y un FOR UPDATE chocaria con ellos (deadlock).
    await client.query('SELECT 1 FROM insumos WHERE id = $1 FOR NO KEY UPDATE', [insumoId]);
    await client.query(
        `INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad)
         VALUES ($1, $2, $3)
         ON CONFLICT (ubicacion_id, insumo_id)
         DO UPDATE SET cantidad = stock_ubicacion.cantidad + EXCLUDED.cantidad`,
        [ubicacionId, insumoId, delta]
    );
    await client.query(
        `UPDATE insumos SET stock_actual = COALESCE(
            (SELECT SUM(cantidad) FROM stock_ubicacion WHERE insumo_id = $1), 0
         ) WHERE id = $1`,
        [insumoId]
    );
}

module.exports = { idDeCuerpoValido, bodegaCentral, furgonDe, moverStock };
