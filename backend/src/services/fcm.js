// Envio de avisos push por la API HTTP v1 de Firebase Cloud Messaging, sin firebase-admin:
//   1. la cuenta de servicio (JSON en base64 en FCM_CUENTA_SERVICIO, solo en gomaq-worker) firma un JWT RS256
//      con node:crypto;
//   2. el JWT se canjea en oauth2.googleapis.com por un token de acceso (se guarda en memoria ~50 min);
//   3. con ese token se llama a https://fcm.googleapis.com/v1/projects/<id>/messages:send.
// La clave privada nunca se escribe en el repo ni en los logs. `fetchFn` se inyecta solo en pruebas.

const crypto = require('node:crypto');
const { clasificarErrorFcm } = require('../utils/push');

// fijo a proposito: el JWT firmado solo se envia a Google, diga lo que diga el JSON de la cuenta
const URL_TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPE_FCM = 'https://www.googleapis.com/auth/firebase.messaging';
// el token de Google dura 1 h; se renueva antes
const VIDA_TOKEN_MS = 50 * 60 * 1000;
const ESPERA_CONFIGURACION_SEGUNDOS = 3600;
// FCM descarta el mensaje si no logra entregarlo en este plazo (el aviso pierde sentido pasadas 6 h)
const TTL_SEGUNDOS = 6 * 60 * 60;

let cache = { clave: null, accessToken: null, vence: 0 };

function limpiarCacheToken() {
    cache = { clave: null, accessToken: null, vence: 0 };
}

/** Error que no es de la fila sino de la configuracion: el worker espera sin gastar intentos. */
function errorConfiguracion(mensaje) {
    return Object.assign(new Error(mensaje), { reintentarEnSegundos: ESPERA_CONFIGURACION_SEGUNDOS });
}

/**
 * Lee la cuenta de servicio de FCM_CUENTA_SERVICIO (JSON en base64). Sin ella, o si esta mal formada, lanza
 * errorConfiguracion. Solo devuelve lo necesario (no deja pasar el resto del JSON).
 */
function leerCuentaServicio(env = process.env) {
    const crudo = env.FCM_CUENTA_SERVICIO;
    if (!crudo) throw errorConfiguracion('Falta FCM_CUENTA_SERVICIO en el worker');
    let json;
    try {
        json = JSON.parse(Buffer.from(String(crudo).trim(), 'base64').toString('utf8'));
    } catch (_) {
        throw errorConfiguracion('FCM_CUENTA_SERVICIO no es un JSON en base64');
    }
    const { client_email: clientEmail, private_key: privateKey, project_id: projectId } = json || {};
    if (![clientEmail, privateKey, projectId].every((v) => typeof v === 'string' && v)) {
        throw errorConfiguracion('FCM_CUENTA_SERVICIO no trae client_email, private_key y project_id');
    }
    return { clientEmail, privateKey, projectId };
}

const base64url = (valor) => Buffer.from(valor).toString('base64url');

/** JWT RS256 con el que la cuenta de servicio pide su token de acceso. */
function firmarJwt(cuenta, ahoraMs = Date.now()) {
    const iat = Math.floor(ahoraMs / 1000);
    const cabecera = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(JSON.stringify({ iss: cuenta.clientEmail, scope: SCOPE_FCM, aud: URL_TOKEN, iat, exp: iat + 3600 }));
    const firma = crypto.createSign('RSA-SHA256').update(`${cabecera}.${claims}`).sign(cuenta.privateKey).toString('base64url');
    return `${cabecera}.${claims}.${firma}`;
}

/** `reintentarEnSegundos` desde Retry-After (en segundos) si la respuesta lo trae. */
function esperaDe(respuesta) {
    const valor = respuesta.headers && typeof respuesta.headers.get === 'function' ? Number(respuesta.headers.get('retry-after')) : NaN;
    return Number.isFinite(valor) && valor > 0 ? { reintentarEnSegundos: Math.ceil(valor) } : {};
}

async function obtenerAccessToken(cuenta, { fetchFn, signal, ahora, forzar }) {
    if (!forzar && cache.clave === cuenta.clientEmail && cache.accessToken && cache.vence > ahora()) return cache.accessToken;
    let jwt;
    try {
        jwt = firmarJwt(cuenta, ahora());
    } catch (_) {
        throw errorConfiguracion('La clave privada de FCM_CUENTA_SERVICIO no es valida');
    }
    const respuesta = await fetchFn(URL_TOKEN, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
    });
    if (!respuesta.ok) {
        // 4xx del canje = credenciales malas; 5xx o 429 = Google con problemas (se reintenta como cualquier fallo)
        if (respuesta.status >= 400 && respuesta.status < 500 && respuesta.status !== 429) {
            throw errorConfiguracion(`Google rechazo la cuenta de servicio de FCM (HTTP ${respuesta.status})`);
        }
        throw Object.assign(new Error(`No se pudo obtener el token de Google (HTTP ${respuesta.status})`), esperaDe(respuesta));
    }
    const datos = await respuesta.json().catch(() => ({}));
    if (!datos.access_token) throw new Error('Google no entrego access_token');
    cache = { clave: cuenta.clientEmail, accessToken: datos.access_token, vence: ahora() + VIDA_TOKEN_MS };
    return datos.access_token;
}

/** Cuerpo de POST messages:send a partir del mensaje de utils/push.js (ya en lista blanca). */
function armarCuerpoFcm(token, mensaje) {
    return {
        message: {
            token,
            notification: { title: mensaje.titulo, body: mensaje.cuerpo },
            data: mensaje.data,
            android: { priority: 'HIGH', ttl: `${TTL_SEGUNDOS}s`, notification: { tag: mensaje.tag } },
            webpush: { headers: { Urgency: 'high', TTL: String(TTL_SEGUNDOS) }, notification: { tag: mensaje.tag } },
        },
    };
}

/**
 * Envia un mensaje a un token de dispositivo.
 * Errores (con `message` sin datos sensibles):
 *  - `descartar: true`: el token no sirve (UNREGISTERED y similares).
 *  - `reintentarEnSegundos`: credenciales o proyecto mal (1 h) o FCM saturado (429/503, Retry-After).
 *  - `permanente: true`: el mensaje esta mal armado, reintentar no lo arregla.
 * @param {object} p
 * @param {{clientEmail:string, privateKey:string, projectId:string}} p.cuenta  de leerCuentaServicio
 * @param {string} p.token
 * @param {{titulo:string, cuerpo:string, data:object, tag:string}} p.mensaje  de armarMensajePush
 * @param {AbortSignal} p.signal
 * @param {Function} [p.fetchFn]  solo para pruebas
 * @param {Function} [p.ahora]    solo para pruebas (milisegundos)
 * @returns {Promise<string|null>} nombre del mensaje en FCM
 */
async function enviarPushFcm({ cuenta, token, mensaje, signal, fetchFn = fetch, ahora = Date.now }) {
    const url = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(cuenta.projectId)}/messages:send`;
    const llamar = async (forzar) => {
        const accessToken = await obtenerAccessToken(cuenta, { fetchFn, signal, ahora, forzar });
        return fetchFn(url, {
            method: 'POST',
            signal,
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(armarCuerpoFcm(token, mensaje)),
        });
    };
    let respuesta = await llamar(false);
    if (respuesta.status === 401) {
        // el token de acceso pudo vencer antes de lo previsto: se pide uno nuevo y se reintenta una vez
        limpiarCacheToken();
        respuesta = await llamar(true);
    }
    if (respuesta.ok) {
        const datos = await respuesta.json().catch(() => ({}));
        return datos.name || null;
    }
    let cuerpo = null;
    try { cuerpo = await respuesta.json(); } catch (_) { /* sin JSON */ }
    const espera = esperaDe(respuesta).reintentarEnSegundos || null;
    const c = clasificarErrorFcm({ status: respuesta.status, cuerpo, reintentarEn: espera });
    const textoError = `FCM respondio ${respuesta.status}${c.codigo ? ` (${c.codigo})` : ''}`;
    if (c.accion === 'descartar') throw Object.assign(new Error(textoError), { descartar: true });
    if (c.accion === 'configuracion') throw errorConfiguracion(textoError);
    if (c.accion === 'reintentar') throw Object.assign(new Error(textoError), { reintentarEnSegundos: c.espera });
    throw Object.assign(new Error(textoError), { permanente: true });
}

module.exports = {
    enviarPushFcm, leerCuentaServicio, firmarJwt, limpiarCacheToken, errorConfiguracion,
    URL_TOKEN, SCOPE_FCM,
};
