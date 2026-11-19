// Historial de eventos de la orden de trabajo (tabla ordenes_eventos, migracion 020).
//
// Cada ruta que crea, asigna, toma, avanza, cierra, valoriza o cambia las lineas y la factura de una OT
// deja un evento en la MISMA transaccion que el cambio, para que el historial nunca diga algo distinto de
// lo que paso. La tabla es de solo insercion (triggers en la migracion).
//
// Orden del historial: se ordena por id (orden de escritura), con la creacion siempre primero.
// ocurrio_en es la hora que se muestra, pero no ordena: la hora de un telefono con el reloj mal daria
// cadenas "de X a Y" incoherentes. registrado_en tampoco: es la hora de inicio de la transaccion y puede
// invertir dos operaciones casi simultaneas.
//
// IMPORTANTE: el id solo sigue el orden real mientras TODO evento se escriba con la fila de la OT
// bloqueada (FOR UPDATE, o un UPDATE de esa fila en la misma transaccion).
//
// Las funciones de armado son puras (test/eventosOt.test.js); solo registrarEvento toca la base.

const { UUID } = require('./validacion');
const { TOLERANCIA_FUTURO_MS } = require('./tiempo');

const TIPOS_EVENTO = [
    'creacion', 'asignacion', 'toma', 'cambio_estado', 'cierre', 'valorizacion',
    'linea_agregada', 'linea_modificada', 'linea_anulada', 'factura_cargada', 'factura_anulada',
];
const ORIGENES_EVENTO = ['terreno', 'panel', 'sistema', 'migracion'];

// una diferencia mayor entre ocurrio_en y registrado_en marca el evento como sincronizado tarde
const MINUTOS_SINCRONIZADO_TARDE = 10;

function esTipoValido(tipo) {
    return TIPOS_EVENTO.includes(tipo);
}

/** Convierte a Date; null si no hay valor o no es una fecha. */
function aFecha(valor) {
    if (valor === undefined || valor === null || valor === '') return null;
    const fecha = valor instanceof Date ? valor : new Date(valor);
    return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/**
 * La hora de un evento es dudosa si esta en el futuro (mas alla de 2 minutos de margen) o es
 * anterior a la creacion de la OT: el reloj del telefono estaba mal. Sin hora (se usa la del
 * servidor) no hay nada que dudar.
 *
 * Una OT que nacio por sincronizacion (la creo el mecanico sin senal, uuid_cliente no nulo) tiene
 * como fecha de creacion la hora en que llego al servidor, y sus eventos llevan la hora real del
 * telefono, anterior a esa fecha: ahi la comparacion con la creacion no vale y solo cuenta el futuro.
 */
function esHoraDudosa(ocurrioEn, creadaEn, ahora = new Date(), { nacioPorSincronizacion = false } = {}) {
    const ocurrio = aFecha(ocurrioEn);
    if (!ocurrio) return false;
    if (ocurrio.getTime() > ahora.getTime() + TOLERANCIA_FUTURO_MS) return true;
    if (nacioPorSincronizacion) return false;
    const creada = aFecha(creadaEn);
    return Boolean(creada && ocurrio.getTime() < creada.getTime());
}

/**
 * El uuid de la tarea de la cola offline, o null. Este valor nunca hace fallar la ruta: uno
 * malformado se ignora (el evento se registra sin idempotencia), porque el cast de Postgres
 * daria un 500 y el cambio de la OT ya es valido por si solo.
 */
function leerUuidTarea(valor) {
    return typeof valor === 'string' && UUID.test(valor) ? valor.toLowerCase() : null;
}

/**
 * Arma el objeto evento listo para insertar. Lanza si el tipo o el origen no existen, que es un
 * error de programacion y no del usuario.
 *
 *   ordenId, tipo, origen            obligatorios
 *   estadoAnterior, estadoNuevo      estado_orden, si el evento mueve el estado
 *   usuario                          { id, rol } de req.user; omitido en eventos del sistema
 *   ocurrioEn                        hora del dispositivo; omitida = la del servidor
 *   creadaEn                         fecha_creacion de la OT, para detectar la hora dudosa
 *   nacioPorSincronizacion           la OT se creo en terreno (uuid_cliente no nulo): no se compara
 *                                    con su fecha de creacion
 *   uuidCliente                      uuid de la tarea de la cola offline
 *   aplicado                         false si el cambio llego atrasado y no se aplico
 *   detalle                          objeto libre (mecanico anterior y nuevo, valorizacion, etc.)
 */
function construirEvento({
    ordenId, tipo, origen, estadoAnterior = null, estadoNuevo = null, usuario = null,
    ocurrioEn = null, creadaEn = null, uuidCliente = null, aplicado = true, detalle = null,
    nacioPorSincronizacion = false, ahora = new Date(),
}) {
    if (!Number.isInteger(Number(ordenId)) || Number(ordenId) <= 0) throw new Error('Evento sin orden de trabajo valida');
    if (!esTipoValido(tipo)) throw new Error(`Tipo de evento desconocido: ${tipo}`);
    if (!ORIGENES_EVENTO.includes(origen)) throw new Error(`Origen de evento desconocido: ${origen}`);
    const ocurrio = aFecha(ocurrioEn);
    return {
        ordenId: Number(ordenId),
        tipo,
        estadoAnterior: estadoAnterior || null,
        estadoNuevo: estadoNuevo || null,
        usuarioId: usuario && usuario.id ? usuario.id : null,
        rol: usuario && usuario.rol ? usuario.rol : null,
        ocurrioEn: ocurrio ? ocurrio.toISOString() : null,
        origen,
        uuidCliente: uuidCliente || null,
        aplicado: aplicado !== false,
        horaDudosa: esHoraDudosa(ocurrio, creadaEn, ahora, { nacioPorSincronizacion }),
        detalle: detalle === null || detalle === undefined ? null : detalle,
    };
}

/**
 * Inserta el evento con el cliente de la transaccion en curso. ON CONFLICT DO NOTHING: si la
 * tarea de la cola offline ya dejo su evento (mismo uuid_cliente y tipo), el reintento no da
 * error ni aborta la transaccion. Devuelve true si inserto y false si ya estaba.
 */
async function registrarEvento(client, evento) {
    const r = await client.query(
        `INSERT INTO ordenes_eventos
             (orden_trabajo_id, tipo, estado_anterior, estado_nuevo, usuario_id, rol, ocurrio_en,
              origen, uuid_cliente, aplicado, hora_dudosa, detalle)
         VALUES ($1, $2, $3::estado_orden, $4::estado_orden, $5, $6, COALESCE($7::timestamptz, now()),
                 $8, $9, $10, $11, $12)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
            evento.ordenId, evento.tipo, evento.estadoAnterior, evento.estadoNuevo, evento.usuarioId,
            evento.rol, evento.ocurrioEn, evento.origen, evento.uuidCliente, evento.aplicado,
            evento.horaDudosa, evento.detalle === null ? null : JSON.stringify(evento.detalle),
        ]
    );
    return r.rows.length > 0;
}

/** Construye y registra en un paso; es lo que usan las rutas. */
async function dejarEvento(client, datos) {
    return registrarEvento(client, construirEvento(datos));
}

/**
 * Que hacer con el evento de un PATCH /:id/diagnostico.
 *
 *   cambio          resultado de evaluarCambioEstado ('cambiar' | 'sin_cambio'; 'rechazar' ya salio)
 *   estadoActual    estado de la OT antes del cambio
 *   estadoPedido    estado que pidio el mecanico (null si el diagnostico no trae estado)
 *   uuid            uuid de la tarea de la cola, o null
 *
 * Un cambio aplicado se registra con aplicado = true. Uno atrasado (sin_cambio) se registra con
 * aplicado = false para saber que el mecanico lo hizo aunque no moviera nada. Sin uuid, repetir
 * exactamente el estado actual es un reintento puro y no se registra: no hay forma de reconocerlo
 * y duplicaria el evento. Con uuid el ON CONFLICT ya evita el duplicado.
 *
 * Ojo: un diagnostico atrasado SIN uuid se registraria de nuevo (aplicado = false) en cada
 * reintento, porque nada permite reconocerlo. Hoy no ocurre: el APK siempre manda el uuid de la
 * tarea (body.uuid); solo un cliente que no lo mande tendria ese efecto.
 */
function decidirEventoDiagnostico({ cambio, estadoActual, estadoPedido, uuid = null }) {
    if (!estadoPedido) return { registrar: false, aplicado: false };
    if (cambio === 'cambiar') return { registrar: true, aplicado: true };
    if (cambio !== 'sin_cambio') return { registrar: false, aplicado: false };
    return { registrar: Boolean(uuid) || estadoActual !== estadoPedido, aplicado: false };
}

/** El tecnico que se asigna ya es el de la OT (doble clic). Sin tecnico anterior, nunca. */
function esMismoTecnico(mecanicoAnteriorId, mecanicoNuevoId) {
    return mecanicoAnteriorId != null && Number(mecanicoAnteriorId) === Number(mecanicoNuevoId);
}

/**
 * Que hacer con el evento de PATCH /:id/asignar.
 *
 * Un doble clic (mismo tecnico y mismo estado) no cambia nada y no deja evento. Es reasignacion
 * solo si ya habia un mecanico y es otro. reinicioViaje: el nuevo tecnico no hizo el viaje del
 * anterior, asi que se borran sus horas de aceptado y en camino.
 */
function decidirEventoAsignacion({ estadoActual, estadoNuevo, mecanicoAnteriorId, mecanicoNuevoId }) {
    const mismoTecnico = esMismoTecnico(mecanicoAnteriorId, mecanicoNuevoId);
    return {
        registrar: !mismoTecnico || estadoNuevo !== estadoActual,
        reasignacion: mecanicoAnteriorId != null && !mismoTecnico,
        reinicioViaje: estadoNuevo === 'asignada' && ['aceptada', 'en_camino'].includes(estadoActual),
    };
}

/** Un evento se sincronizo tarde si llego al servidor mas de 10 minutos despues de ocurrir. */
function sincronizadoTarde(ocurrioEn, registradoEn) {
    const ocurrio = aFecha(ocurrioEn);
    const registrado = aFecha(registradoEn);
    if (!ocurrio || !registrado) return false;
    return registrado.getTime() - ocurrio.getTime() > MINUTOS_SINCRONIZADO_TARDE * 60 * 1000;
}

module.exports = {
    TIPOS_EVENTO, ORIGENES_EVENTO,
    TOLERANCIA_FUTURO_MS, decidirEventoDiagnostico, decidirEventoAsignacion, esMismoTecnico,
    esTipoValido, esHoraDudosa, leerUuidTarea, construirEvento, registrarEvento, dejarEvento, sincronizadoTarde,
};
