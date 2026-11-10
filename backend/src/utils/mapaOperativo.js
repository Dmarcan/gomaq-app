// Mapa operativo: arma lo que ven el administrativo y el gerente (equipos arrendados, equipos en
// bodega y furgones en camino) a partir de filas de la base.
//
// Reglas puras, sin consultas: la ruta solo lee y llama aqui. Por privacidad cada campo se copia
// a mano (nunca `...fila`): una columna nueva en una consulta no llega al mapa por accidente.
// Quedan fuera a proposito: RUT, correo y telefono de clientes y mecanicos, la precision del GPS,
// el origen y las consultas de la ETA, el destino de la OT y cualquier historial de posiciones.
// `quieto_desde` es solo una hora (desde cuando el furgon no se mueve), no un historial.
// El cliente y el mecanico no tienen acceso a esta ruta.

const { coordenadasDeFila } = require('./geo');

/**
 * Donde dibujar un equipo.
 * - En arriendo: la guia de despacho vigente (si es del mismo cliente) y, si no tiene coordenadas,
 *   la ubicacion del cliente. Es la misma precedencia que el destino de una OT (destinoOt.js).
 * - En bodega: las coordenadas de la bodega, si estan cargadas.
 * @returns {{latitud:number, longitud:number, origen:'guia'|'cliente'|'bodega'}|null}
 */
function ubicacionEquipo({ situacion, guia = null, cliente = null, bodega = null }) {
    if (situacion === 'bodega') {
        const c = coordenadasDeFila(bodega);
        return c ? { ...c, origen: 'bodega' } : null;
    }
    const g = coordenadasDeFila(guia);
    if (g) return { ...g, origen: 'guia' };
    const c = coordenadasDeFila(cliente);
    return c ? { ...c, origen: 'cliente' } : null;
}

/**
 * Una fila de equipo (maquinaria + cliente + ultima guia no fallida) como la ve el mapa.
 * La guia solo cuenta si es un despacho y es del cliente que hoy tiene el equipo.
 */
function armarEquipo(fila, { bodega, idsConAlerta }) {
    const situacion = fila.cliente_id !== null && fila.cliente_id !== undefined ? 'arrendado' : 'bodega';
    const guiaVigente = fila.g_tipo === 'despacho' && fila.g_cliente_id === fila.cliente_id
        ? { latitud: fila.g_lat, longitud: fila.g_lng }
        : null;
    const ubicacion = ubicacionEquipo({
        situacion,
        guia: guiaVigente,
        cliente: { latitud: fila.c_lat, longitud: fila.c_lng },
        bodega,
    });
    return {
        id: fila.id,
        codigo: fila.codigo,
        tipo: fila.tipo,
        marca: fila.marca || null,
        modelo: fila.modelo || null,
        estado: fila.estado,
        situacion,
        cliente: situacion === 'arrendado' ? { id: fila.cliente_id, nombre: fila.cliente_nombre } : null,
        direccion: situacion === 'arrendado' ? (fila.direccion || null) : null,
        latitud: ubicacion ? ubicacion.latitud : null,
        longitud: ubicacion ? ubicacion.longitud : null,
        origen_ubicacion: ubicacion ? ubicacion.origen : null,
        alerta_mantencion: idsConAlerta.has(fila.id),
        // la OT abierta del equipo, solo para decirlo en su ficha: sin destino ni ETA
        orden_abierta: fila.ot_id
            ? { id: fila.ot_id, estado: fila.ot_estado, mecanico_nombre: fila.ot_mecanico || null }
            : null,
    };
}

/**
 * Un furgon en camino. Si todavia no llego ninguna posicion (o el mecanico va en Maps sin que la app
 * haya podido enviarla), las coordenadas son null y el panel lo lista sin icono. `posicion_at` es la
 * hora en que el telefono tomo la posicion: el panel muestra "hace X min" y no se oculta nunca.
 */
function armarFurgon(fila) {
    const pos = coordenadasDeFila(fila);
    const tieneEta = fila.eta_llegada_at !== null && fila.eta_llegada_at !== undefined;
    return {
        orden_trabajo_id: fila.orden_trabajo_id,
        mecanico_nombre: fila.mecanico_nombre || null,
        vehiculo: fila.vehiculo_patente
            ? { patente: fila.vehiculo_patente, marca: fila.vehiculo_marca || null, modelo: fila.vehiculo_modelo || null }
            : null,
        cliente_nombre: fila.cliente_nombre || null,
        maquinaria_id: fila.maquinaria_id === undefined ? null : fila.maquinaria_id,
        maquinaria_codigo: fila.maquinaria_codigo,
        latitud: pos ? pos.latitud : null,
        longitud: pos ? pos.longitud : null,
        posicion_at: pos ? (fila.posicion_at || null) : null,
        // desde cuando no se mueve de ese punto: el panel lo usa para decir "detenido" y no "sin senal"
        quieto_desde: pos ? (fila.quieto_desde || null) : null,
        eta_llegada_at: tieneEta ? fila.eta_llegada_at : null,
        eta_aproximada: tieneEta ? fila.eta_fuente !== 'ors' : null,
    };
}

/** La bodega como la ve el mapa; null si ni siquiera existe la fila. */
function armarBodega(fila) {
    if (!fila) return null;
    const c = coordenadasDeFila(fila);
    return {
        id: fila.id,
        nombre: fila.nombre,
        latitud: c ? c.latitud : null,
        longitud: c ? c.longitud : null,
    };
}

/**
 * @param {{ahora?:Date, bodega:object|null, equipos:object[], furgones:object[], alertas:{id:number}[]}} datos
 */
function armarRespuestaMapa({ ahora = new Date(), bodega, equipos, furgones, alertas = [] }) {
    const idsConAlerta = new Set(alertas.map((a) => a.id));
    return {
        generado_at: ahora.toISOString(),
        bodega: armarBodega(bodega),
        equipos: equipos.map((e) => armarEquipo(e, { bodega, idsConAlerta })),
        furgones: furgones.map(armarFurgon),
    };
}

module.exports = { ubicacionEquipo, armarEquipo, armarFurgon, armarBodega, armarRespuestaMapa };
