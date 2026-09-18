// Ciclo de vida de una Orden de Trabajo.
//
//   pendiente -> asignada -> en_terreno <-> en_reparacion -> finalizada
//
// Hallazgo de la segunda auditoria: ninguna ruta revisaba el estado. Una OT finalizada podia
// volver a "asignada" al reasignarla, el mecanico podia reabrirla con /diagnostico, y cerrarla
// dos veces reescribia la fecha de cierre y le mandaba al cliente un segundo aviso de cierre.
//
// Funciones puras: la regla queda testeable sin base de datos (ver test/estadosOt.test.js).

const FINALIZADA = 'finalizada';
const EN_CURSO = ['en_terreno', 'en_reparacion'];

/**
 * Estado que queda al asignar (o reasignar) un mecanico, o null si ya no se puede.
 *
 * Reasignar una OT en curso es valido (el mecanico se enfermo, se cambia de turno): cambia el
 * tecnico pero la OT no retrocede a "asignada", porque el trabajo ya empezo.
 */
function estadoTrasAsignar(actual) {
    if (actual === FINALIZADA) return null;
    if (EN_CURSO.includes(actual)) return actual;
    return 'asignada';
}

/** El mecanico solo modifica una OT mientras no este cerrada. */
function mecanicoPuedeEditar(estado) {
    return estado !== FINALIZADA;
}

/** Estados a los que el mecanico puede mover la OT con /diagnostico. */
function puedeCambiarEstadoA(actual, nuevo) {
    if (actual === FINALIZADA) return false;
    return EN_CURSO.includes(nuevo);
}

/**
 * Cierre de la OT. Cerrar una ya cerrada no es un error: es un reintento de la cola offline y
 * se responde bien, pero sin volver a cerrar ni a avisar.
 */
function evaluarCierre(estado) {
    if (estado === FINALIZADA) return { permitido: true, yaFinalizada: true };
    if (estado === 'pendiente') return { permitido: false, yaFinalizada: false };
    return { permitido: true, yaFinalizada: false };
}

module.exports = { FINALIZADA, estadoTrasAsignar, mecanicoPuedeEditar, puedeCambiarEstadoA, evaluarCierre };
