// Cliente del servicio de rutas (OpenRouteService, alojado por HeiGIT) para la hora estimada de
// llegada del mecanico.
//
// - Plan gratuito: 2.000 consultas de ruta al dia y 40 por minuto. El cupo se cuida en
//   utils/recalculoEta.js y services/rutasEta.js; aqui solo se hace la consulta.
// - La llave vive SOLO en process.env.ORS_API_KEY (variable de Railway y .env local). Nunca va al
//   panel ni a la app de terreno, y nunca se escribe en un log ni en un mensaje de error.
// - El dominio antiguo api.openrouteservice.org esta en desuso: se usa api.heigit.org, que acepta
//   la llave en el encabezado Authorization tal cual (sin "Bearer"). Verificado con una consulta real.
// - ORS recibe las coordenadas como [longitud, latitud]: al reves de como se hablan en el resto del sistema.
// - Todo fallo se convierte en ErrorOrs: el llamador cae a la ETA aproximada y nunca bloquea al mecanico.

const BASE_URL_POR_DEFECTO = 'https://api.heigit.org/openrouteservice';
const PERFIL = 'driving-car'; // el furgon del mecanico es un vehiculo liviano
const TIMEOUT_MS = 5000;

/** tipo: sin_llave | auth_o_cuota | limite_minuto | servidor | timeout | respuesta | red */
class ErrorOrs extends Error {
    constructor(tipo, mensaje, estadoHttp = null) {
        super(mensaje);
        this.name = 'ErrorOrs';
        this.tipo = tipo;
        this.estadoHttp = estadoHttp;
    }
}

function hayLlave(env = process.env) {
    return typeof env.ORS_API_KEY === 'string' && env.ORS_API_KEY.trim() !== '';
}

/** Traduce un codigo HTTP de error al tipo de fallo. */
function tipoDeEstadoHttp(estado) {
    if (estado === 401 || estado === 403) return 'auth_o_cuota'; // llave invalida o cupo diario agotado
    if (estado === 429) return 'limite_minuto';
    if (estado >= 500) return 'servidor';
    return 'respuesta';
}

/**
 * Saca distancia (m) y duracion (s) de la respuesta de ORS. Una respuesta mal formada, con valores
 * no numericos o negativos, es un error: nunca se guarda una ETA inventada.
 */
function interpretarRespuesta(json) {
    const resumen = json && Array.isArray(json.routes) && json.routes[0] && json.routes[0].summary;
    if (!resumen) throw new ErrorOrs('respuesta', 'La respuesta de rutas no trae un resumen');
    const { distance, duration } = resumen;
    if (![distance, duration].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
        throw new ErrorOrs('respuesta', 'La respuesta de rutas trae distancia o duracion invalidas');
    }
    return { distancia_m: Math.round(distance), segundos: Math.round(duration) };
}

/**
 * Ruta en auto entre dos puntos.
 * @param {{latitud:number, longitud:number}} origen
 * @param {{latitud:number, longitud:number}} destino
 * @param {object} [opciones] fetchFn y llave se inyectan para probar sin red
 * @returns {Promise<{distancia_m:number, segundos:number}>}
 */
async function calcularRuta(origen, destino, opciones = {}) {
    const {
        fetchFn = fetch,
        llave = process.env.ORS_API_KEY,
        baseUrl = process.env.ORS_BASE_URL || BASE_URL_POR_DEFECTO,
        timeoutMs = TIMEOUT_MS,
    } = opciones;
    if (typeof llave !== 'string' || llave.trim() === '') throw new ErrorOrs('sin_llave', 'No hay llave del servicio de rutas');

    let respuesta;
    try {
        respuesta = await fetchFn(`${baseUrl}/v2/directions/${PERFIL}`, {
            method: 'POST',
            headers: { Authorization: llave.trim(), 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ coordinates: [[origen.longitud, origen.latitud], [destino.longitud, destino.latitud]] }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        // el mensaje original no se propaga: podria incluir detalles de la peticion
        if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new ErrorOrs('timeout', 'El servicio de rutas no respondio a tiempo');
        throw new ErrorOrs('red', 'No se pudo conectar con el servicio de rutas');
    }
    if (!respuesta.ok) {
        throw new ErrorOrs(tipoDeEstadoHttp(respuesta.status), `El servicio de rutas respondio ${respuesta.status}`, respuesta.status);
    }
    let json;
    try {
        json = await respuesta.json();
    } catch (err) {
        throw new ErrorOrs('respuesta', 'La respuesta de rutas no es JSON');
    }
    return interpretarRespuesta(json);
}

module.exports = { ErrorOrs, hayLlave, tipoDeEstadoHttp, interpretarRespuesta, calcularRuta, BASE_URL_POR_DEFECTO, TIMEOUT_MS };
