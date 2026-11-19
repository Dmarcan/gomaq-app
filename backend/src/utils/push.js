// Reglas puras del aviso push (sin base de datos ni red): que se le dice al telefono, como se clasifica
// un error de FCM y cuando un aviso ya no vale la pena enviarlo.

// Quien recibe cada tipo de push. La app del dispositivo y el rol del usuario se revisan al encolar
// (utils/avisos.js) y otra vez justo antes de enviar (workers/notificaciones.js, motivoDescarte): un telefono
// de la app terreno nunca recibe avisos de gerencia ni del cliente, y el panel nunca los del mecanico.
//  - terreno / mecanico: lo que pasa con sus ordenes.
//  - panel / gerente y administrativo: avisos de la oficina. Los de dinero e inventario (factura anulada,
//    ajuste de inventario) son solo del gerente; el resto llega tambien al administrativo.
//  - panel / cliente: dos avisos sobre SUS ordenes, solo con titulo corto y el numero de OT.
const DESTINOS_PUSH = Object.freeze({
    ot_asignada: { app: 'terreno', roles: ['mecanico'] },
    ot_reasignada: { app: 'terreno', roles: ['mecanico'] },
    ot_disponible: { app: 'terreno', roles: ['mecanico'] },
    ot_por_valorizar: { app: 'panel', roles: ['gerente', 'administrativo'] },
    asistencia_nueva: { app: 'panel', roles: ['gerente', 'administrativo'] },
    mantencion_proxima: { app: 'panel', roles: ['gerente', 'administrativo'] },
    factura_anulada: { app: 'panel', roles: ['gerente'] },
    ajuste_inventario: { app: 'panel', roles: ['gerente'] },
    mecanico_asignado: { app: 'panel', roles: ['cliente'] },
    ot_finalizada: { app: 'panel', roles: ['cliente'] },
});

const TIPOS_CON_PUSH = Object.freeze(Object.keys(DESTINOS_PUSH));

/** App y roles que pueden recibir un tipo de push, o null si el tipo no tiene push. */
function destinoPush(tipo) {
    return Object.prototype.hasOwnProperty.call(DESTINOS_PUSH, tipo) ? DESTINOS_PUSH[tipo] : null;
}

// un aviso mas viejo que esto ya no sirve (el mecanico lo vio en la app o la OT cambio)
const VIGENCIA_PUSH_MS = 6 * 60 * 60 * 1000;

// Texto de cada tipo. Los de OT dicen "OT #id, equipo codigo"; los que no tienen OT llevan su propio texto.
const TITULOS = Object.freeze({
    ot_asignada: 'Nueva orden asignada',
    ot_reasignada: 'Orden reasignada',
    ot_disponible: 'Orden disponible',
    ot_por_valorizar: 'Orden por valorizar',
    asistencia_nueva: 'Nueva asistencia solicitada',
    mecanico_asignado: 'Tu equipo tiene tecnico asignado',
    ot_finalizada: 'Tu orden de trabajo finalizo',
    factura_anulada: 'Factura anulada',
    ajuste_inventario: 'Ajuste de inventario con perdida',
    mantencion_proxima: 'Mantencion proxima',
});
const TIPOS_SIN_OT = Object.freeze(['factura_anulada', 'ajuste_inventario', 'mantencion_proxima']);

function enteroPositivo(valor) {
    const n = Number(valor);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/** Codigo del equipo apto para mostrar: texto corto, sin saltos ni caracteres de control. */
function codigoSeguro(valor) {
    if (typeof valor !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const limpio = valor.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 40);
    return limpio || null;
}

/**
 * Mensaje que ve el telefono. LISTA BLANCA estricta: solo el tipo, el numero de OT y el codigo del equipo
 * (y, en los avisos de gerencia sin OT, el folio de la factura o el equipo de la mantencion). Nunca RUT,
 * patente, coordenadas, montos, observaciones, nombre del mecanico ni del cliente, aunque el payload del
 * aviso los traiga (sirve para correo, no para push).
 * @returns {{titulo:string, cuerpo:string, data:object, tag:string|undefined}|null}
 *   null si el tipo no tiene push o el aviso no trae los datos que su texto necesita.
 */
function armarMensajePush(payload) {
    const p = payload || {};
    const tipo = p.tipo;
    if (!Object.prototype.hasOwnProperty.call(TITULOS, tipo)) return null;
    const titulo = TITULOS[tipo];
    if (TIPOS_SIN_OT.includes(tipo)) return armarMensajeSinOt(tipo, titulo, p);
    const ordenId = enteroPositivo(p.orden_trabajo_id);
    if (!ordenId) return null;
    const codigo = codigoSeguro(p.maquinaria_codigo);
    return {
        titulo,
        cuerpo: codigo ? `OT #${ordenId}, equipo ${codigo}` : `OT #${ordenId}`,
        // los valores de data en FCM son siempre texto
        data: { tipo, orden_trabajo_id: String(ordenId) },
        // el mismo aviso reenviado (al menos una vez) reemplaza al anterior en vez de duplicarse
        tag: `ot-${ordenId}-${tipo}`,
    };
}

/** Avisos de gerencia que no cuelgan de una OT: factura anulada, ajuste de inventario y mantencion proxima. */
function armarMensajeSinOt(tipo, titulo, p) {
    if (tipo === 'factura_anulada') {
        const folio = codigoSeguro(p.folio);
        const ordenId = enteroPositivo(p.orden_trabajo_id);
        const partes = [folio ? `Folio ${folio}` : null, ordenId ? `OT #${ordenId}` : null].filter(Boolean);
        const data = { tipo };
        if (ordenId) data.orden_trabajo_id = String(ordenId);
        return {
            titulo,
            cuerpo: partes.length ? partes.join(', ') : 'Revisa la factura anulada',
            data,
            tag: ordenId ? `ot-${ordenId}-${tipo}` : undefined,
        };
    }
    if (tipo === 'ajuste_inventario') {
        // sin insumo, cantidades ni nombre de quien registro: se ve en Inventario
        return { titulo, cuerpo: 'Revisa el conteo en Inventario', data: { tipo }, tag: undefined };
    }
    // mantencion_proxima
    const maquinariaId = enteroPositivo(p.maquinaria_id);
    if (!maquinariaId) return null;
    const codigo = codigoSeguro(p.maquinaria_codigo);
    return {
        titulo: p.vencida === true ? 'Mantencion vencida' : titulo,
        cuerpo: codigo ? `Equipo ${codigo}` : `Equipo #${maquinariaId}`,
        data: { tipo, maquinaria_id: String(maquinariaId) },
        tag: `maquinaria-${maquinariaId}-${tipo}`,
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
 * @param {object|null} e.dispositivo  {activo, usuario_id, estado_cuenta, avisos_silenciados, sesion_id, sesion_revocada_at, sesion_expira_at} o null si no existe
 * @param {boolean} [e.otSinAsignar]   solo para ot_disponible: la OT sigue pendiente y sin tecnico
 */
function motivoDescarte({ aviso, dispositivo, otSinAsignar = true }, ahora = new Date()) {
    if (!dispositivo) return 'El dispositivo ya no existe';
    if (!dispositivo.activo) return 'El dispositivo esta desactivado';
    if (aviso.usuario_id !== undefined && aviso.usuario_id !== null && Number(aviso.usuario_id) !== Number(dispositivo.usuario_id)) {
        return 'El dispositivo ahora es de otro usuario';
    }
    if (dispositivo.estado_cuenta !== 'activo') return 'La cuenta ya no esta activa';
    // el usuario puede apagar el tipo (Mi perfil y mis avisos) despues de que el aviso se encolo
    if (Array.isArray(dispositivo.avisos_silenciados) && dispositivo.avisos_silenciados.includes(aviso.tipo)) {
        return 'El usuario silencio este aviso';
    }
    // el destino se revisa de nuevo con los datos de ahora: la app, el rol y (avisos al cliente) la empresa
    const destino = destinoPush(aviso.tipo);
    if (!destino) return 'El tipo de aviso no tiene push';
    if (dispositivo.app !== destino.app) return 'El dispositivo es de otra app';
    if (!destino.roles.includes(dispositivo.rol)) return 'El usuario ya no tiene el rol que corresponde';
    if (aviso.cliente_id !== undefined && aviso.cliente_id !== null && Number(aviso.cliente_id) !== Number(dispositivo.cliente_id)) {
        return 'El usuario ya no es de la empresa de la orden';
    }
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

module.exports = { TIPOS_CON_PUSH, DESTINOS_PUSH, destinoPush, VIGENCIA_PUSH_MS, armarMensajePush, clasificarErrorFcm, motivoDescarte };
