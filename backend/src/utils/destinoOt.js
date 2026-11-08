// Destino de una orden de trabajo: a donde tiene que llegar el mecanico.
//
// Se toma una "foto" al crear o asignar la OT, para que el destino no cambie a mitad del viaje
// si despues alguien edita la direccion del cliente o la guia.
//
// Precedencia (de la mas especifica a la mas general):
//   1. la solicitud del cliente (si indico otra obra distinta a su empresa)
//   2. la guia de despacho vigente del equipo (donde esta arrendado hoy)
//   3. la ubicacion registrada del cliente (su empresa)
//
// Si la fuente preferida no tiene coordenadas se cae a la siguiente. `origen` lo calcula el
// servidor y nunca se acepta del cliente HTTP.

const { coordenadasDeFila } = require('./geo');

const ORIGENES = ['solicitud', 'guia', 'cliente'];

/**
 * @param {{solicitud?: object|null, guia?: object|null, cliente?: object|null}} fuentes
 *        filas de la base, con `latitud` y `longitud` (NUMERIC llega como string)
 * @returns {{latitud: number, longitud: number, origen: 'solicitud'|'guia'|'cliente'} | null}
 *          null si ninguna fuente tiene coordenadas: la OT sigue valida, solo sin ETA ni ruta.
 */
function elegirDestino({ solicitud = null, guia = null, cliente = null } = {}) {
    const candidatas = [
        ['solicitud', solicitud],
        ['guia', guia],
        ['cliente', cliente],
    ];
    for (const [origen, fila] of candidatas) {
        const coords = coordenadasDeFila(fila);
        if (coords) return { ...coords, origen };
    }
    return null;
}

module.exports = { ORIGENES, elegirDestino };
