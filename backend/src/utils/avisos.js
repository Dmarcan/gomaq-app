// Avisos internos (mecanico y gerente) por el patron Outbox: la fila de notificaciones_pendientes se
// inserta con el `client` de la MISMA transaccion del evento, asi que si el evento se revierte el
// aviso tampoco queda. El envio real lo hace el worker (hoy un stub: los avisos terminan en error
// tras los reintentos hasta que se configure el proveedor, igual que los demas).
//
// Estos helpers no agregan bloqueos: solo leen `usuarios` y insertan en notificaciones_pendientes.
// Los reintentos no duplican avisos porque cada ruta sale antes de encolar cuando el cambio ya estaba
// aplicado (reintento de finalizar, Idempotency-Key de anular, uuid del ajuste, mismo tecnico).

const TIPOS_AVISO = Object.freeze({
    OT_ASIGNADA: 'ot_asignada',
    OT_REASIGNADA: 'ot_reasignada',
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

function insertar(client, canal, destinatario, payload) {
    return client.query(
        `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ($1, $2, $3)`,
        [canal, destinatario, JSON.stringify(payload)]
    );
}

/**
 * Aviso a un mecanico: por WhatsApp si tiene telefono, si no por correo, si no no se encola nada.
 * Devuelve cuantas filas encolo (0 o 1).
 */
async function encolarAMecanico(client, mecanicoId, payload) {
    if (!mecanicoId) return 0;
    const r = await client.query(
        `SELECT email, telefono_whatsapp FROM usuarios WHERE id = $1 AND rol = 'mecanico' AND estado_cuenta = 'activo'`,
        [mecanicoId]
    );
    const mecanico = r.rows[0];
    if (!mecanico) return 0;
    if (mecanico.telefono_whatsapp) {
        await insertar(client, 'whatsapp', mecanico.telefono_whatsapp, payload);
        return 1;
    }
    if (mecanico.email) {
        await insertar(client, 'email', mecanico.email, payload);
        return 1;
    }
    return 0;
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
        if (gerente.email) {
            await insertar(client, 'email', gerente.email, payload);
            encoladas++;
        }
        if (gerente.telefono_whatsapp) {
            await insertar(client, 'whatsapp', gerente.telefono_whatsapp, payload);
            encoladas++;
        }
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

module.exports = {
    TIPOS_AVISO, TIPOS_INTERNOS, MOTIVOS_AJUSTE_CON_AVISO,
    encolarAMecanico, encolarAGerentes,
    avisarAsignacion, avisarPorValorizar, avisarFacturaAnulada, avisarAjusteInventario,
};
