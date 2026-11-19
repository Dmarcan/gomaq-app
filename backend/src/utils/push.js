// Reglas puras del aviso push (sin base de datos ni red): que se le dice al telefono, como se clasifica
// un error de FCM y cuando un aviso ya no vale la pena enviarlo.

const TIPOS_CON_PUSH = Object.freeze(['ot_asignada', 'ot_reasignada', 'ot_disponible']);

// un aviso mas viejo que esto ya no sirve (el mecanico lo vio en la app o la OT cambio)
const VIGENCIA_PUSH_MS = 6 * 60 * 60 * 1000;

const TITULOS = Object.freeze({
    ot_asignada: 'Nueva orden asignada',
    ot_reasignada: 'Orden reasignada',
    ot_disponible: 'Orden disponible',
});

/** Codigo del equipo apto para mostrar: texto corto, sin saltos ni caracteres de control. */
function codigoSeguro(valor) {
    if (typeof valor !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const limpio = valor.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 40);
    return limpio || null;
}

/**
 * Mensaje que ve el telefono. LISTA BLANCA estricta: solo el tipo, el numero de OT y el codigo del
 * equipo. Nunca RUT, patente, coordenadas, montos, observaciones ni el nombre del cliente, aunque el
 * payload del aviso los traiga (sirve para correo, no para push).
 * @returns {{titulo:string, cuerpo:string, data:{tipo:string, orden_trabajo_id:string}, tag:string}|null}
 *   null si el tipo no tiene push o el aviso no trae una OT valida.
 */
function armarMensajePush(payload) {
    const p = payload || {};
    const titulo = Object.prototype.hasOwnProperty.call(TITULOS, p.tipo) ? TITULOS[p.tipo] : null;
    const ordenId = Number(p.orden_trabajo_id);
    if (!titulo || !Number.isInteger(ordenId) || ordenId <= 0) return null;
    const codigo = codigoSeguro(p.maquinaria_codigo);
    return {
        titulo,
        cuerpo: codigo ? `OT #${ordenId}, equipo ${codigo}` : `OT #${ordenId}`,
        // los valores de data en FCM son siempre texto
        data: { tipo: p.tipo, orden_trabajo_id: String(ordenId) },
        // el mismo aviso reenviado (al menos una vez) reemplaza al anterior en vez de duplicarse
        tag: `ot-${ordenId}-${p.tipo}`,
    };
}

function errorCodigoFcm(cuerpo) {
    const error = cuerpo && cuerpo.error;
    if (!error) return { codigo: null, mensaje: '' };
    const detalles = Array.isArray(error.details) ? error.details : [];
    const fcm = detalles.find((d) => d && typeof d.errorCode === 'string');
    return { codigo: fcm ? fcm.errorCode : (error.status || null), mensaje: String(error.message || '') };
}

/**
 * Que hacer con una respuesta de error de FCM (API v1).
 * @param {{status:number, cuerpo:object|null, reintentarEn?:number|null}} r  `reintentarEn` en segundos (Retry-After)
 * @returns {{accion:'descartar'|'configuracion'|'reintentar'|'permanente', codigo:string|null, espera?:number}}
 *   descartar: el token ya no sirve (apagar el dispositivo); configuracion: problema de credenciales o del
 *   proyecto (esperar sin gastar intentos); reintentar: saturacion o caida de FCM; permanente: el mensaje es invalido.
 */
function clasificarErrorFcm({ status, cuerpo, reintentarEn = null }) {
    const { codigo, mensaje } = errorCodigoFcm(cuerpo);
    if (codigo === 'UNREGISTERED' || codigo === 'NOT_FOUND' || (!codigo && status === 404)) {
        return { accion: 'descartar', codigo };
    }
    if (codigo === 'INVALID_ARGUMENT') {
        // un argumento invalido por el token se descarta; por cualquier otra cosa el mensaje esta mal armado
        return /token/i.test(mensaje) ? { accion: 'descartar', codigo } : { accion: 'permanente', codigo };
    }
    if (['SENDER_ID_MISMATCH', 'THIRD_PARTY_AUTH_ERROR', 'PERMISSION_DENIED', 'UNAUTHENTICATED'].includes(codigo)
        || status === 401 || status === 403) {
        return { accion: 'configuracion', codigo };
    }
    if (codigo === 'QUOTA_EXCEEDED' || status === 429) {
        return { accion: 'reintentar', codigo, espera: reintentarEn > 0 ? reintentarEn : 60 };
    }
    if (['UNAVAILABLE', 'INTERNAL'].includes(codigo) || status === 503 || status >= 500) {
        return { accion: 'reintentar', codigo, espera: reintentarEn > 0 ? reintentarEn : 30 };
    }
    return { accion: 'permanente', codigo };
}

/**
 * Motivo por el que un aviso push ya no debe enviarse, o null si sigue vigente.
 * @param {object} e
 * @param {{tipo?:string, usuario_id?:number, created_at?:Date|string}} e.aviso
 * @param {object|null} e.dispositivo  {activo, usuario_id, estado_cuenta, sesion_id, sesion_revocada_at, sesion_expira_at} o null si no existe
 * @param {boolean} [e.otSinAsignar]   solo para ot_disponible: la OT sigue pendiente y sin tecnico
 */
function motivoDescarte({ aviso, dispositivo, otSinAsignar = true }, ahora = new Date()) {
    if (!dispositivo) return 'El dispositivo ya no existe';
    if (!dispositivo.activo) return 'El dispositivo esta desactivado';
    if (aviso.usuario_id !== undefined && aviso.usuario_id !== null && Number(aviso.usuario_id) !== Number(dispositivo.usuario_id)) {
        return 'El dispositivo ahora es de otro usuario';
    }
    if (dispositivo.estado_cuenta !== 'activo') return 'La cuenta ya no esta activa';
    if (dispositivo.sesion_id) {
        if (dispositivo.sesion_revocada_at) return 'La sesion del dispositivo fue cerrada';
        if (dispositivo.sesion_expira_at && new Date(dispositivo.sesion_expira_at).getTime() <= ahora.getTime()) {
            return 'La sesion del dispositivo vencio';
        }
    }
    const creado = aviso.created_at ? new Date(aviso.created_at).getTime() : NaN;
    if (Number.isFinite(creado) && ahora.getTime() - creado > VIGENCIA_PUSH_MS) return 'El aviso tiene mas de 6 horas';
    if (aviso.tipo === 'ot_disponible' && !otSinAsignar) return 'La orden ya fue tomada';
    return null;
}

module.exports = { TIPOS_CON_PUSH, VIGENCIA_PUSH_MS, armarMensajePush, clasificarErrorFcm, motivoDescarte };
