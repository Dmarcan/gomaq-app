// Convierte una respuesta de error de Resend en un Error que entiende planificarReintento
// (utils/reintentosNotificacion.js). Funcion pura: no hace red.
//
// - `reintentarEnSegundos`: se reprograma sin gastar intento (limites, o configuracion por arreglar).
// - `permanente`: no tiene sentido reintentar; la fila pasa a 'error' de inmediato.
// - sin ninguna de las dos: error transitorio comun, con backoff.

const ESPERA_CONFIGURACION_SEGUNDOS = 3600;

function segundosHastaMedianocheUtc(ahora) {
    const siguiente = Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate() + 1);
    return Math.max(1, Math.ceil((siguiente - ahora.getTime()) / 1000));
}

function leerEncabezado(headers, nombre) {
    if (!headers) return null;
    if (typeof headers.get === 'function') return headers.get(nombre);
    return headers[nombre] ?? headers[nombre.toLowerCase()] ?? null;
}

function errorDeResend({ status, cuerpo, headers, ahora = new Date() }) {
    const nombre = (cuerpo && cuerpo.name) || '';
    const mensaje = (cuerpo && cuerpo.message) || '';
    const texto = `Resend ${status}${nombre ? ` ${nombre}` : ''}${mensaje ? `: ${mensaje}` : ''}`;
    const error = new Error(texto);

    if (status === 429) {
        if (nombre === 'daily_quota_exceeded') {
            error.reintentarEnSegundos = segundosHastaMedianocheUtc(ahora);
        } else if (nombre === 'monthly_quota_exceeded') {
            error.reintentarEnSegundos = ESPERA_CONFIGURACION_SEGUNDOS;
        } else {
            const espera = Number(leerEncabezado(headers, 'retry-after'));
            error.reintentarEnSegundos = Number.isFinite(espera) && espera > 0 ? espera : 5;
        }
        return error;
    }
    if (status === 409 && nombre === 'concurrent_idempotent_requests') {
        error.reintentarEnSegundos = 5;
        return error;
    }
    // clave invalida o dominio no verificado: es un problema de configuracion, no de esta fila.
    // Esperar sin gastar intentos evita que se quemen los 5 intentos de toda la cola.
    if (status === 401 || status === 403) {
        error.reintentarEnSegundos = ESPERA_CONFIGURACION_SEGUNDOS;
        return error;
    }
    if (status === 400 || status === 409 || status === 422) {
        error.permanente = true;
        return error;
    }
    return error;
}

module.exports = { errorDeResend, segundosHastaMedianocheUtc, ESPERA_CONFIGURACION_SEGUNDOS };
