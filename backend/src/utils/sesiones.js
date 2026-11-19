// Reglas puras de las sesiones guardadas en la base (tabla sesiones, migracion 036): generar el token,
// guardar solo su hash y decidir si una sesion sigue valiendo. Sin consultas ni red.

const crypto = require('node:crypto');

const PREFIJO_TOKEN = 'gs1_';
const APPS = ['panel', 'terreno', 'otro'];

// Duraciones. La app del mecanico trabaja sin conexion y debe poder sincronizar tras dias sin senal, y a
// administrativo y gerente no se les pide iniciar sesion a cada rato: 30 dias como tope y 14 sin usarla.
const DURACION_ABSOLUTA_DIAS = 30;
const INACTIVIDAD_MINUTOS = 14 * 24 * 60;
// ultimo_uso_at se actualiza como maximo cada tanto, para no escribir en la base en cada peticion
const REFRESCO_USO_MINUTOS = 5;
const MAX_SESIONES_ACTIVAS = 20;

/** Token nuevo: prefijo + 32 bytes aleatorios en base64url. */
function generarToken(aleatorio = crypto.randomBytes) {
    return PREFIJO_TOKEN + aleatorio(32).toString('base64url');
}

/** Lo que parece un token de sesion (el resto de los tokens son JWT antiguos). */
function esTokenDeSesion(token) {
    return typeof token === 'string' && token.startsWith(PREFIJO_TOKEN) && token.length > PREFIJO_TOKEN.length && token.length <= 200;
}

/** SHA-256 en hexadecimal: es lo unico que se guarda. */
function hashToken(token) {
    return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** 'panel', 'terreno' u 'otro' (cualquier otra cosa que mande el cliente). */
function normalizarApp(app) {
    return APPS.includes(app) ? app : 'otro';
}

/** Vencimiento absoluto de una sesion que se crea ahora. */
function vencimientoAbsoluto(ahora = new Date()) {
    return new Date(ahora.getTime() + DURACION_ABSOLUTA_DIAS * 24 * 60 * 60 * 1000);
}

/**
 * Decide si una fila de sesiones sigue valiendo.
 * @returns {'ok'|'revocada'|'vencida'|'inactiva'}
 */
function estadoSesion(fila, ahora = new Date()) {
    if (!fila) return 'revocada';
    if (fila.revocada_at) return 'revocada';
    const t = ahora.getTime();
    if (new Date(fila.expira_at).getTime() <= t) return 'vencida';
    if (new Date(fila.ultimo_uso_at).getTime() + Number(fila.inactividad_min) * 60 * 1000 <= t) return 'inactiva';
    return 'ok';
}

module.exports = {
    APPS, DURACION_ABSOLUTA_DIAS, INACTIVIDAD_MINUTOS, REFRESCO_USO_MINUTOS, MAX_SESIONES_ACTIVAS,
    generarToken, esTokenDeSesion, hashToken, normalizarApp, vencimientoAbsoluto, estadoSesion,
};
