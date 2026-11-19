// Reglas de una asistencia pedida por el cliente: gravedad declarada y su efecto en el estado del equipo.
// Funciones puras, con test en test/asistenciaCliente.test.js.
//
// El cliente solo EMPEORA el estado: nunca devuelve un equipo a operativa ni pisa uno que ya esta en mantencion
// (ya lo atiende una orden) o fuera de servicio. Lo que deja queda con origen 'cliente'; el cierre de una orden
// y el panel pueden corregirlo (ver estadoEquipo.js).

const GRAVEDADES = ['sigue_operando', 'parcial', 'fuera_de_servicio'];
const ORDEN_GRAVEDAD = { sigue_operando: 0, parcial: 1, fuera_de_servicio: 2 };
const ESTADO_POR_GRAVEDAD = { parcial: 'parcialmente_operativa', fuera_de_servicio: 'fuera_de_servicio' };

/** Gravedad del cuerpo: ausente es 'sigue_operando' (cliente antiguo); otro valor no es valido. */
function validarGravedad(valor) {
    if (valor === undefined || valor === null || valor === '') return { valida: true, gravedad: 'sigue_operando' };
    if (typeof valor === 'string' && GRAVEDADES.includes(valor)) return { valida: true, gravedad: valor };
    return { valida: false, gravedad: null };
}

/** La mayor de dos gravedades (un detalle puede subirla, nunca bajarla). */
function gravedadMayor(a, b) {
    return ORDEN_GRAVEDAD[b] > ORDEN_GRAVEDAD[a] ? b : a;
}

/** Estado nuevo del equipo por la gravedad declarada, o null si no cambia. */
function estadoPorGravedad({ gravedad, estadoEquipo }) {
    const destino = ESTADO_POR_GRAVEDAD[gravedad];
    if (!destino) return null;
    if (estadoEquipo === 'operativa') return { estado: destino, origen: 'cliente' };
    if (estadoEquipo === 'parcialmente_operativa' && destino === 'fuera_de_servicio') return { estado: destino, origen: 'cliente' };
    return null;
}

/**
 * Asistencia "abierta" de un equipo: la solicitud sigue pendiente, o ya es una orden que no termino.
 * Una rechazada o con la orden finalizada ya no cuenta. Va con el alias `s` de solicitudes y se usa en un
 * LEFT JOIN a ordenes_trabajo (alias `ot`).
 */
const SQL_ASISTENCIA_ABIERTA = "(s.estado = 'pendiente' OR (s.estado = 'convertida' AND ot.estado IS DISTINCT FROM 'finalizada'))";

const ETIQUETA_GRAVEDAD = {
    sigue_operando: 'sigue operando',
    parcial: 'opera parcialmente',
    fuera_de_servicio: 'no funciona (fuera de servicio)',
};

/** Motivo de la OT que nace de una asistencia: lo que escribio el cliente y como dice que esta el equipo. */
function textoMotivo({ descripcion, gravedad }) {
    return `Estado del equipo según el cliente: ${ETIQUETA_GRAVEDAD[gravedad] || ETIQUETA_GRAVEDAD.sigue_operando}.\n\n${descripcion}`;
}

/** Lo que se agrega al motivo cuando el cliente suma un detalle (y avisa si ahora indica algo mas grave). */
function textoDetalle({ texto, gravedadAnterior, gravedadNueva }) {
    const sube = gravedadNueva !== gravedadAnterior;
    return `\n\nDetalle del cliente: ${texto}${sube ? `\nAhora el cliente indica que el equipo ${ETIQUETA_GRAVEDAD[gravedadNueva]}.` : ''}`;
}

/** Estados de la OT en que todavia se puede agregar un detalle: el tecnico aun no la acepto. */
const ESTADOS_OT_CON_DETALLE = ['pendiente', 'asignada'];

module.exports = {
    textoMotivo, textoDetalle, ESTADOS_OT_CON_DETALLE,
    SQL_ASISTENCIA_ABIERTA, validarGravedad, gravedadMayor, estadoPorGravedad };
