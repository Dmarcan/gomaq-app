// Los avisos push que cada usuario puede encender o apagar en "Mi perfil y mis avisos" (RF-06). Logica pura, sin
// base de datos: lo que un rol puede configurar sale de DESTINOS_PUSH (utils/push.js), asi un tipo nuevo de aviso
// aparece solo para los roles a los que se envia.
//
// - Un aviso apagado se guarda en `usuarios.avisos_silenciados` (migracion 049): vacio = recibe todos.
// - `mantencion_proxima` sigue gobernado por `usuarios.recibe_alertas_mantencion` (migracion 012; solo quienes lo
//   encendieron lo reciben): aqui es un interruptor mas, pero su valor vive en esa columna.
// - El correo de la factura al cliente no es un aviso push: no se configura aqui.

const { DESTINOS_PUSH } = require('./push');

const TIPO_MANTENCION = 'mantencion_proxima';

// Titulo y explicacion de cada tipo, tal como los lee la persona. El orden es el de la pantalla.
const CATALOGO = Object.freeze([
    ['ot_asignada', 'Orden asignada', 'Te asignan una orden de trabajo.'],
    ['ot_reasignada', 'Orden reasignada', 'Una orden que tenías pasa a otro técnico.'],
    ['ot_disponible', 'Orden disponible', 'Hay una orden nueva sin técnico y tú no tienes otra en curso.'],
    ['ot_por_valorizar', 'Orden por valorizar', 'Una reparación terminó y espera que se apruebe su valorización.'],
    ['asistencia_nueva', 'Nueva asistencia', 'Un cliente pidió asistencia para uno de sus equipos.'],
    [TIPO_MANTENCION, 'Mantención próxima', 'Un equipo se acerca a las horas de su mantención preventiva.'],
    ['factura_anulada', 'Factura anulada', 'Se anuló una factura.'],
    ['ajuste_inventario', 'Pérdida de inventario', 'Un conteo de inventario registró una pérdida o merma.'],
    ['mecanico_asignado', 'Técnico asignado', 'Tu equipo tiene un técnico asignado.'],
    ['ot_finalizada', 'Orden finalizada', 'Una orden de trabajo de tu empresa terminó.'],
].map(([tipo, titulo, descripcion]) => Object.freeze({ tipo, titulo, descripcion })));

/** Los avisos que ese rol puede recibir (y por tanto configurar), en el orden de la pantalla. */
function avisosDelRol(rol) {
    return CATALOGO.filter((a) => DESTINOS_PUSH[a.tipo] && DESTINOS_PUSH[a.tipo].roles.includes(rol));
}

/**
 * La lista para la pantalla: cada aviso del rol con `activo` (true si lo recibe).
 * @param {string} rol
 * @param {{avisos_silenciados?: string[], recibe_alertas_mantencion?: boolean}} usuario
 */
function armarAvisos(rol, usuario) {
    const silenciados = new Set((usuario && usuario.avisos_silenciados) || []);
    return avisosDelRol(rol).map((a) => ({
        ...a,
        activo: a.tipo === TIPO_MANTENCION ? Boolean(usuario && usuario.recibe_alertas_mantencion) : !silenciados.has(a.tipo),
    }));
}

/**
 * Valida el cambio que manda la pantalla: un objeto { tipo: true|false } solo con avisos de su rol.
 * Devuelve { cambios } (el mismo objeto, ya validado) o { error } para responder 400.
 */
function validarCambioAvisos(rol, avisos) {
    if (avisos === null || typeof avisos !== 'object' || Array.isArray(avisos)) {
        return { error: 'avisos debe ser un objeto con el tipo de aviso y true o false' };
    }
    const permitidos = new Set(avisosDelRol(rol).map((a) => a.tipo));
    for (const [tipo, valor] of Object.entries(avisos)) {
        if (!permitidos.has(tipo)) return { error: `El aviso "${tipo}" no existe para tu perfil` };
        if (typeof valor !== 'boolean') return { error: `El aviso "${tipo}" debe ser true o false` };
    }
    return { cambios: avisos };
}

/**
 * Aplica un cambio ya validado: devuelve los silenciados nuevos (sin repetidos y en orden estable) y, si el cambio
 * toca la mantencion, el nuevo valor de `recibe_alertas_mantencion` (undefined si no lo toca).
 */
function aplicarCambioAvisos(silenciadosActuales, cambios) {
    const silenciados = new Set(silenciadosActuales || []);
    let recibeMantencion;
    for (const [tipo, activo] of Object.entries(cambios)) {
        if (tipo === TIPO_MANTENCION) {
            recibeMantencion = activo;
        } else if (activo) {
            silenciados.delete(tipo);
        } else {
            silenciados.add(tipo);
        }
    }
    return { avisosSilenciados: [...silenciados].sort(), recibeMantencion };
}

module.exports = { CATALOGO, avisosDelRol, armarAvisos, validarCambioAvisos, aplicarCambioAvisos };
