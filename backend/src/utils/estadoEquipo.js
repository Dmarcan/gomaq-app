// Estado del equipo derivado de sus ordenes de trabajo (bloque 3).
//
// El estado de la maquinaria puede cambiarlo la orden (al llegar el mecanico a terreno y al cerrar),
// el mecanico (al cerrar dice como queda el equipo) o el panel (a mano). `estado_origen` guarda
// quien lo fijo por ultima vez: 'ot', 'mecanico' o 'panel'. NULL es un estado fijado antes de la
// migracion 024, cuando solo lo escribia PATCH /estado, y se trata como manual (del panel).
//
// Funciones puras: la regla queda testeable sin base de datos (ver test/estadoEquipo.test.js).
// "Abierta" quiere decir en_terreno o en_reparacion (ver estadosOt.EN_CURSO).

const ESTADOS_EQUIPO = ['operativa', 'en_mantencion', 'fuera_de_servicio'];
// lo que puede pedir el mecanico al cerrar una orden
const ESTADOS_CIERRE = ['operativa', 'fuera_de_servicio'];
const ORIGENES_ESTADO = ['ot', 'mecanico', 'panel'];

/** `estado_equipo` del cierre: ausente (APK antiguo) es valido; otro valor no. */
function validarEstadoEquipoCierre(valor) {
    if (valor === undefined || valor === null || valor === '') return { valido: true, estado: null };
    if (typeof valor === 'string' && ESTADOS_CIERRE.includes(valor)) return { valido: true, estado: valor };
    return { valido: false, estado: null };
}

/**
 * Estado que deja la ENTRADA de una orden a trabajo (llega a terreno por primera vez): un equipo
 * operativo pasa a en_mantencion por la orden. Cualquier otro estado se respeta: un en_mantencion
 * o un fuera_de_servicio puestos a mano no se tocan. Devuelve null si no hay cambio.
 */
function estadoTrasEntrada({ estadoEquipo }) {
    if (estadoEquipo === 'operativa') return { estado: 'en_mantencion', origen: 'ot' };
    return null;
}

/**
 * Estado que deja el CIERRE de una orden.
 *
 *   pedido            lo que indico el mecanico ('operativa' | 'fuera_de_servicio' | null si no lo indico)
 *   otrasAbiertas     otras ordenes abiertas del mismo equipo, sin contar la que se cierra
 *   estadoEquipo      estado actual del equipo
 *   origenEstado      quien lo fijo ('ot' | 'mecanico' | 'panel' | null)
 *
 * - fuera_de_servicio del mecanico se aplica siempre: es la informacion mas nueva y mas grave.
 * - operativa solo si no quedan otras ordenes abiertas y el estado no lo puso el panel a mano.
 * - sin pedido (APK antiguo): vuelve a operativa solo si el equipo estaba en mantencion POR LA ORDEN
 *   y no quedan otras; nunca pisa un estado del panel.
 * Devuelve { estado, origen } o null si no hay cambio.
 */
function estadoTrasCierre({ pedido, otrasAbiertas, estadoEquipo, origenEstado }) {
    if (pedido === 'fuera_de_servicio') return { estado: 'fuera_de_servicio', origen: 'mecanico' };
    const manual = origenEstado !== 'ot' && origenEstado !== 'mecanico';
    if (pedido === 'operativa') {
        if (otrasAbiertas > 0 || manual || estadoEquipo === 'operativa') return null;
        return { estado: 'operativa', origen: 'mecanico' };
    }
    if (otrasAbiertas === 0 && estadoEquipo === 'en_mantencion' && origenEstado === 'ot') {
        return { estado: 'operativa', origen: 'ot' };
    }
    return null;
}

/**
 * Origen comercial de una orden: 'externo' si el cliente tiene ejecutivo (se lo trajo un vendedor),
 * 'directo' si no (sin ejecutivo o sin cliente). No se recalculan las ordenes anteriores.
 */
function origenPorEjecutivo(ejecutivoId) {
    return ejecutivoId === null || ejecutivoId === undefined ? 'directo' : 'externo';
}

// ---------------------------------------------------------------------------------------------
// Acceso a la base. Reciben el cliente de la transaccion en curso. Orden de bloqueo: primero la
// fila de la orden (ya tomada por quien llama) y despues la del equipo, nunca al reves; guias.js y
// horometro.js actualizan el equipo sin bloquear la orden, asi que no se forma un ciclo.
// ---------------------------------------------------------------------------------------------

/** Una orden llega a terreno por primera vez: un equipo operativo pasa a en_mantencion. */
async function aplicarEntradaEquipo(client, maquinariaId) {
    const r = await client.query('SELECT estado, estado_origen FROM maquinarias WHERE id = $1 FOR UPDATE', [maquinariaId]);
    if (r.rows.length === 0) return null;
    const cambio = estadoTrasEntrada({ estadoEquipo: r.rows[0].estado });
    if (!cambio) return null;
    await client.query('UPDATE maquinarias SET estado = $1, estado_origen = $2 WHERE id = $3', [cambio.estado, cambio.origen, maquinariaId]);
    return { anterior: r.rows[0].estado, nuevo: cambio.estado };
}

/**
 * Se cierra una orden: aplica lo que corresponda al equipo. La fila del equipo se bloquea ANTES de
 * contar las otras ordenes abiertas: sin eso, dos cierres simultaneos del mismo equipo se verian
 * mutuamente como abiertas y el equipo quedaria en mantencion para siempre.
 * Devuelve el estado anterior y el nuevo del equipo (iguales si no hubo cambio).
 */
async function aplicarCierreEquipo(client, maquinariaId, ordenId, pedido) {
    const r = await client.query('SELECT estado, estado_origen FROM maquinarias WHERE id = $1 FOR UPDATE', [maquinariaId]);
    if (r.rows.length === 0) return { anterior: null, nuevo: null };
    const otras = await client.query(
        `SELECT count(*)::int AS n FROM ordenes_trabajo
         WHERE maquinaria_id = $1 AND id <> $2 AND estado IN ('en_terreno', 'en_reparacion')`,
        [maquinariaId, ordenId]);
    const { estado, estado_origen: origenEstado } = r.rows[0];
    const cambio = estadoTrasCierre({ pedido, otrasAbiertas: otras.rows[0].n, estadoEquipo: estado, origenEstado });
    if (cambio) {
        await client.query('UPDATE maquinarias SET estado = $1, estado_origen = $2 WHERE id = $3', [cambio.estado, cambio.origen, maquinariaId]);
    }
    return { anterior: estado, nuevo: cambio ? cambio.estado : estado };
}

/** Origen comercial de una orden segun el cliente que queda en ella. */
async function origenDeCliente(db, clienteId) {
    if (!clienteId) return 'directo';
    const r = await db.query('SELECT ejecutivo_id FROM clientes WHERE id = $1', [clienteId]);
    return origenPorEjecutivo(r.rows[0] ? r.rows[0].ejecutivo_id : null);
}

module.exports = {
    ESTADOS_EQUIPO, ESTADOS_CIERRE, ORIGENES_ESTADO,
    validarEstadoEquipoCierre, estadoTrasEntrada, estadoTrasCierre, origenPorEjecutivo,
    aplicarEntradaEquipo, aplicarCierreEquipo, origenDeCliente,
};
