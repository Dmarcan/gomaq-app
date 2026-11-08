// Fija el destino de una orden de trabajo (la "foto" de a donde tiene que llegar el mecanico).
//
// Se llama al crear la OT, al tomarla o asignarla y al convertir una solicitud. NUNCA mientras el
// mecanico ya va en camino: el destino no debe cambiar a mitad del viaje (la reasignacion reinicia
// el viaje, ver estadoTrasAsignar, y recien ahi se vuelve a fijar).
//
// La eleccion misma es una regla pura (utils/destinoOt.js); aqui solo se leen las fuentes.
// Una OT sin ninguna fuente con coordenadas queda sin destino: sigue siendo valida, solo que sin
// ruta ni hora estimada (el mecanico ve la direccion en texto).

const { elegirDestino } = require('./destinoOt');

/**
 * @param {object} db cliente de pg (idealmente el de la transaccion en curso)
 * @param {number|string} ordenId
 * @returns {Promise<{latitud:number, longitud:number, origen:string}|null>} el destino fijado
 */
async function fijarDestinoOt(db, ordenId) {
    const ot = (await db.query(
        'SELECT id, cliente_id, maquinaria_id FROM ordenes_trabajo WHERE id = $1',
        [ordenId]
    )).rows[0];
    if (!ot) return null;

    // la solicitud del cliente que dio origen a la OT (si indico otra obra)
    const solicitud = (await db.query(
        `SELECT latitud, longitud FROM solicitudes
         WHERE orden_trabajo_id = $1 AND latitud IS NOT NULL ORDER BY id DESC LIMIT 1`,
        [ot.id]
    )).rows[0] || null;

    // la guia vigente: la ultima no fallida del equipo, solo si es un despacho (equipo en arriendo)
    // y es del mismo cliente de la OT
    const ultimaGuia = (await db.query(
        `SELECT tipo, cliente_id, latitud, longitud FROM guias
         WHERE maquinaria_id = $1 AND fallido = false ORDER BY fecha DESC, id DESC LIMIT 1`,
        [ot.maquinaria_id]
    )).rows[0] || null;
    const guia = ultimaGuia && ultimaGuia.tipo === 'despacho'
        && (ot.cliente_id === null || ultimaGuia.cliente_id === ot.cliente_id)
        ? ultimaGuia : null;

    const cliente = ot.cliente_id
        ? (await db.query('SELECT latitud, longitud FROM clientes WHERE id = $1', [ot.cliente_id])).rows[0] || null
        : null;

    const destino = elegirDestino({ solicitud, guia, cliente });
    await db.query(
        'UPDATE ordenes_trabajo SET destino_lat = $1, destino_lng = $2, destino_origen = $3 WHERE id = $4',
        [destino ? destino.latitud : null, destino ? destino.longitud : null, destino ? destino.origen : null, ot.id]
    );
    return destino;
}

module.exports = { fijarDestinoOt };
