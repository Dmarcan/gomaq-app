// Avisos internos (mecanico y gerente) por el patron Outbox: la fila de notificaciones_pendientes se
// inserta con el `client` de la MISMA transaccion del evento, asi que si el evento se revierte el
// aviso tampoco queda. El envio real lo hace el worker; ver encolarNotificacion: sin proveedor no se encola.
//
// Estos helpers no agregan bloqueos: solo leen `usuarios` y insertan en notificaciones_pendientes.
// Los reintentos no duplican avisos porque cada ruta sale antes de encolar cuando el cambio ya estaba
// aplicado (reintento de finalizar, Idempotency-Key de anular, uuid del ajuste, mismo tecnico).

const { OCUPADO } = require('./estadosOt');
const { TIPOS_CON_PUSH } = require('./push');

const TIPOS_AVISO = Object.freeze({
    OT_ASIGNADA: 'ot_asignada',
    OT_REASIGNADA: 'ot_reasignada',
    OT_DISPONIBLE: 'ot_disponible',
    OT_POR_VALORIZAR: 'ot_por_valorizar',
    FACTURA_ANULADA: 'factura_anulada',
    AJUSTE_INVENTARIO: 'ajuste_inventario',
});

// Tipos de aviso interno (para el personal, no para el cliente). El contador de "notificaciones en error"
// del dashboard los deja fuera: hoy todos terminan en error mientras el proveedor sea un stub y solo
// los avisos al cliente deben mover esa alarma.
const TIPOS_INTERNOS = Object.freeze(Object.values(TIPOS_AVISO));

/** Motivos de un conteo que merecen avisar al gerente (una diferencia por conteo normal no). */
const MOTIVOS_AJUSTE_CON_AVISO = Object.freeze(['perdida_robo', 'danio_merma']);

// Porton unico de la cola de salida: solo se encolan los avisos que tienen proveedor real.
//  - correo: solo el de factura (Resend).
//  - push (FCM): ot_asignada, ot_reasignada y ot_disponible, y SOLO si PUSH_HABILITADO=1 en la API. El flag se
//    activa despues de que el worker nuevo (con el canal push) este arriba: un worker antiguo marcaria 'push'
//    como error permanente. Apagarlo es la vuelta atras. Se lee en cada llamada, no al cargar el modulo.
// Un aviso sin proveedor no se encola: terminaria en error y ensuciaria el panel con "Avisos con problemas".
// Para agregar un proveedor se suma su canal y tipo aqui y su plantilla en workers/notificaciones.js.
const TIPOS_CON_ENVIO = Object.freeze(['factura_emitida']);

function pushHabilitado() {
    return process.env.PUSH_HABILITADO === '1';
}

function tieneProveedor(canal, tipo) {
    if (canal === 'email') return TIPOS_CON_ENVIO.includes(tipo);
    if (canal === 'push') return pushHabilitado() && TIPOS_CON_PUSH.includes(tipo);
    return false;
}

/** Encola un aviso si tiene proveedor, con el `client` de la transaccion del evento. Devuelve filas encoladas (0 o 1). */
async function encolarNotificacion(client, { canal, destinatario, payload }) {
    if (!tieneProveedor(canal, payload && payload.tipo)) return 0;
    await client.query(
        `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ($1, $2, $3)`,
        [canal, destinatario, JSON.stringify(payload)]
    );
    return 1;
}

function insertar(client, canal, destinatario, payload) {
    return encolarNotificacion(client, { canal, destinatario, payload });
}

/**
 * Aviso push a un mecanico activo: una fila por cada dispositivo suyo de la app terreno (`destinatario` es el id
 * del dispositivo, no el token). Sin el flag PUSH_HABILITADO, sin dispositivos o con la cuenta inactiva no se
 * encola nada. Devuelve cuantas filas encolo.
 */
async function encolarAMecanico(client, mecanicoId, payload) {
    if (!mecanicoId || !tieneProveedor('push', payload && payload.tipo)) return 0;
    const r = await client.query(
        `SELECT d.id FROM dispositivos_push d JOIN usuarios u ON u.id = d.usuario_id
         WHERE d.usuario_id = $1 AND d.activo AND d.app = 'terreno' AND u.rol = 'mecanico' AND u.estado_cuenta = 'activo'
         ORDER BY d.id`,
        [mecanicoId]
    );
    let encoladas = 0;
    for (const d of r.rows) {
        encoladas += await insertar(client, 'push', String(d.id), { ...payload, usuario_id: Number(mecanicoId) });
    }
    return encoladas;
}

/**
 * Aviso a todos los gerentes activos: un correo y un WhatsApp por cada uno que tenga el dato,
 * igual que encolarAvisoMantencion. Si el gerente es quien ejecuta la accion (`excluirUsuarioId`) no se
 * avisa a si mismo. Devuelve cuantas filas encolo.
 */
async function encolarAGerentes(client, payload, { excluirUsuarioId = null } = {}) {
    const r = await client.query(
        `SELECT email, telefono_whatsapp FROM usuarios
         WHERE rol = 'gerente' AND estado_cuenta = 'activo' AND ($1::int IS NULL OR id <> $1::int) ORDER BY id`,
        [excluirUsuarioId]
    );
    let encoladas = 0;
    for (const gerente of r.rows) {
        if (gerente.email) encoladas += await insertar(client, 'email', gerente.email, payload);
        if (gerente.telefono_whatsapp) encoladas += await insertar(client, 'whatsapp', gerente.telefono_whatsapp, payload);
    }
    return encoladas;
}

/** Codigo del equipo y motivo de una OT, para el texto del aviso. */
async function datosOrden(client, ordenId) {
    const r = await client.query(
        `SELECT ot.id AS orden_trabajo_id, ot.motivo, m.codigo AS maquinaria_codigo
         FROM ordenes_trabajo ot LEFT JOIN maquinarias m ON m.id = ot.maquinaria_id WHERE ot.id = $1`,
        [ordenId]
    );
    return r.rows[0] || { orden_trabajo_id: ordenId, motivo: null, maquinaria_codigo: null };
}

/** La OT quedo asignada a `mecanicoId` (nuevo) y, si lo habia, `anteriorId` ya no la tiene. */
async function avisarAsignacion(client, { ordenId, nuevoId, anteriorId }) {
    const datos = await datosOrden(client, ordenId);
    await encolarAMecanico(client, nuevoId, { tipo: TIPOS_AVISO.OT_ASIGNADA, ...datos });
    if (anteriorId && String(anteriorId) !== String(nuevoId)) {
        await encolarAMecanico(client, anteriorId, { tipo: TIPOS_AVISO.OT_REASIGNADA, ...datos });
    }
}

/**
 * Una OT nueva quedo sin tecnico: aviso push a todos los mecanicos activos que NO esten ocupados (ocupado =
 * tiene una OT propia aceptada, en camino, en terreno o en reparacion) y tengan un dispositivo activo.
 * Una sola consulta, sin N+1. Va con el `client` de la transaccion que crea la OT. Con el flag apagado no
 * consulta ni encola. Devuelve cuantas filas encolo.
 */
async function avisarOtDisponible(client, ordenId) {
    if (!tieneProveedor('push', TIPOS_AVISO.OT_DISPONIBLE)) return 0;
    const datos = await datosOrden(client, ordenId);
    const r = await client.query(
        `SELECT d.id, d.usuario_id FROM dispositivos_push d JOIN usuarios u ON u.id = d.usuario_id
         WHERE d.activo AND d.app = 'terreno' AND u.rol = 'mecanico' AND u.estado_cuenta = 'activo'
           AND NOT EXISTS (SELECT 1 FROM ordenes_trabajo o WHERE o.mecanico_id = u.id AND o.estado::text = ANY($1::text[]))
         ORDER BY d.id`,
        [OCUPADO]
    );
    let encoladas = 0;
    for (const d of r.rows) {
        encoladas += await insertar(client, 'push', String(d.id), { tipo: TIPOS_AVISO.OT_DISPONIBLE, ...datos, usuario_id: d.usuario_id });
    }
    return encoladas;
}

/** Una OT termino su trabajo (o perdio su valorizacion) y espera que el gerente apruebe el monto. */
async function avisarPorValorizar(client, ordenId, causa, { excluirUsuarioId = null } = {}) {
    const datos = await datosOrden(client, ordenId);
    return encolarAGerentes(client, { tipo: TIPOS_AVISO.OT_POR_VALORIZAR, ...datos, causa }, { excluirUsuarioId });
}

/**
 * Se anulo una factura: el gerente debe saber que hay que emitir la nota de credito en el SII. El payload es
 * minimo (folio y orden): ni el monto ni el motivo libre viajan en el aviso; se ven en el historial de la OT.
 */
async function avisarFacturaAnulada(client, { factura, excluirUsuarioId = null }) {
    return encolarAGerentes(client, {
        tipo: TIPOS_AVISO.FACTURA_ANULADA,
        orden_trabajo_id: factura.orden_trabajo_id || null,
        folio: factura.folio,
    }, { excluirUsuarioId });
}

/**
 * Un conteo con perdida o merma real (diferencia NEGATIVA): el gerente lo revisa. Un conteo que suma stock
 * no avisa. El payload no lleva la nota libre, solo el codigo del motivo.
 */
async function avisarAjusteInventario(client, { insumoId, ubicacionId, delta, motivoCodigo, usuarioId }) {
    if (!(Number(delta) < 0) || !MOTIVOS_AJUSTE_CON_AVISO.includes(motivoCodigo)) return 0;
    const insumo = await client.query('SELECT nombre FROM insumos WHERE id = $1', [insumoId]);
    const ubicacion = await client.query('SELECT nombre FROM ubicaciones_stock WHERE id = $1', [ubicacionId]);
    const usuario = await client.query('SELECT nombre FROM usuarios WHERE id = $1', [usuarioId]);
    return encolarAGerentes(client, {
        tipo: TIPOS_AVISO.AJUSTE_INVENTARIO,
        insumo_nombre: insumo.rows[0] ? insumo.rows[0].nombre : null,
        ubicacion_nombre: ubicacion.rows[0] ? ubicacion.rows[0].nombre : null,
        delta: Number(delta), motivo_codigo: motivoCodigo,
        registrado_por: usuario.rows[0] ? usuario.rows[0].nombre : null,
    }, { excluirUsuarioId: usuarioId });
}

/**
 * Avisos con problemas (los que mueven la alarma del dashboard): en error los que van al cliente (los
 * internos no cuentan mientras el proveedor sea un stub) y los pendientes que llevan mas de 10 min
 * vencidos sin que nadie los tome (el worker esta caido). Parametro $1: TIPOS_INTERNOS.
 */
const SQL_AVISOS_EN_ERROR = `(estado = 'error' AND COALESCE(payload->>'tipo', '') <> ALL($1::text[]))`;
const SQL_AVISOS_ATRASADOS = `(estado = 'pendiente' AND intentos < 5 AND proximo_intento < now() - interval '10 minutes')`;
const SQL_AVISOS_PROBLEMAS = `(${SQL_AVISOS_EN_ERROR} OR ${SQL_AVISOS_ATRASADOS})`;

module.exports = {
    SQL_AVISOS_PROBLEMAS, SQL_AVISOS_EN_ERROR, SQL_AVISOS_ATRASADOS,
    TIPOS_AVISO, TIPOS_INTERNOS, MOTIVOS_AJUSTE_CON_AVISO,
    TIPOS_CON_ENVIO, pushHabilitado, tieneProveedor, encolarNotificacion,
    encolarAMecanico, encolarAGerentes,
    avisarAsignacion, avisarOtDisponible, avisarPorValorizar, avisarFacturaAnulada, avisarAjusteInventario,
};
