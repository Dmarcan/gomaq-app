// Ciclo de vida de una Orden de Trabajo.
//
//   pendiente -> asignada -> aceptada -> en_camino -> en_terreno <-> en_reparacion -> finalizada
//
// aceptada y en_camino (migracion 018) son el viaje del mecanico: acepta el trabajo, sale hacia el
// destino, y al llegar pulsa Iniciar (en_terreno). Un APK anterior sigue funcionando: puede pasar
// de asignada directo a en_terreno.
//
// Ninguna ruta puede reabrir una OT finalizada: sin esta regla se podia reasignar a "asignada", reabrirla
// con /diagnostico o cerrarla dos veces (reescribia la fecha de cierre y mandaba otro aviso de cierre).
//
// Funciones puras: la regla queda testeable sin base de datos (ver test/estadosOt.test.js).

const FINALIZADA = 'finalizada';
const EN_CURSO = ['en_terreno', 'en_reparacion'];
// estados del viaje, que el mecanico fija en orden y no puede retroceder
const VIAJE = ['aceptada', 'en_camino'];
// el mecanico esta "ocupado" (no se le ofrecen OT nuevas por push) mientras tenga una propia en alguno de estos
const OCUPADO = ['aceptada', 'en_camino', 'en_terreno', 'en_reparacion'];

// posicion en el ciclo, para saber si un cambio de estado es un avance o un reintento atrasado
const POSICION = { pendiente: 0, asignada: 1, aceptada: 2, en_camino: 3, en_terreno: 4, en_reparacion: 4, finalizada: 5 };

const ESTADOS = Object.keys(POSICION);
// la pestana "En curso" de Ordenes del panel: ya tienen tecnico y todavia no terminan
const EN_CURSO_PANEL = ['asignada', 'aceptada', 'en_camino', 'en_terreno', 'en_reparacion'];

/**
 * Lista de estados de un filtro (`?estado=asignada,aceptada`): devuelve { estados } o { error }.
 * Un estado desconocido o una lista vacia se rechazan.
 */
function parsearEstados(texto) {
    if (typeof texto !== 'string') return { error: 'Estado inválido' };
    const estados = texto.split(',').map((e) => e.trim());
    if (estados.some((e) => !ESTADOS.includes(e))) {
        return { error: 'Estado inválido. Valores posibles: ' + ESTADOS.join(', ') };
    }
    return { estados: [...new Set(estados)] };
}

/**
 * Estado que queda al asignar (o reasignar) un mecanico, o null si ya no se puede.
 *
 * Reasignar una OT en curso es valido (el mecanico se enfermo, se cambia de turno): cambia el
 * tecnico pero la OT no retrocede a "asignada", porque el trabajo ya empezo. Una OT en el viaje
 * (aceptada o en camino) conserva su estado si el tecnico es el mismo (un doble clic no debe
 * hacerla retroceder); con otro tecnico vuelve a "asignada", porque el nuevo aun no la acepto.
 */
function estadoTrasAsignar(actual, mismoTecnico = false) {
    if (actual === FINALIZADA) return null;
    if (EN_CURSO.includes(actual)) return actual;
    if (VIAJE.includes(actual) && mismoTecnico) return actual;
    return 'asignada';
}

/** El mecanico solo modifica una OT mientras no este cerrada. */
function mecanicoPuedeEditar(estado) {
    return estado !== FINALIZADA;
}

/**
 * Que hacer cuando el mecanico pide pasar la OT a `nuevo` con /diagnostico.
 *
 * - 'cambiar': es un avance valido.
 * - 'sin_cambio': la OT ya esta en ese estado o mas adelante. Es lo normal en un reintento de la
 *   cola offline (la respuesta se perdio y el cambio ya se aplico) o cuando llegan fuera de orden
 *   dos cambios encolados; se responde bien sin tocar el estado, para no gastar reintentos.
 * - 'rechazar': la OT esta cerrada, no es un estado que el mecanico fije, o aun no tiene mecanico.
 */
function evaluarCambioEstado(actual, nuevo) {
    if (actual === FINALIZADA) return 'rechazar';
    if (!EN_CURSO.includes(nuevo) && !VIAJE.includes(nuevo)) return 'rechazar';
    if (actual === 'pendiente') return 'rechazar';
    if (actual === nuevo) return 'sin_cambio';
    // alternar entre terreno y reparacion es libre; llegar a terreno vale desde cualquier punto
    // del viaje (un APK anterior salta de asignada a en_terreno)
    if (EN_CURSO.includes(nuevo)) return 'cambiar';
    return POSICION[actual] >= POSICION[nuevo] ? 'sin_cambio' : 'cambiar';
}

/** Estados a los que el mecanico puede mover la OT con /diagnostico. */
function puedeCambiarEstadoA(actual, nuevo) {
    return evaluarCambioEstado(actual, nuevo) !== 'rechazar';
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

module.exports = {
    ESTADOS, EN_CURSO_PANEL, parsearEstados, FINALIZADA, VIAJE, EN_CURSO, OCUPADO, estadoTrasAsignar, mecanicoPuedeEditar, puedeCambiarEstadoA, evaluarCambioEstado, evaluarCierre,
};
