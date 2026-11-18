// Reglas puras de geolocalizacion: validar coordenadas, medir distancias y estimar un tiempo
// de viaje cuando no hay servicio de rutas.
//
// La base ya tiene CHECK de rango, pero no basta: el backend debe rechazar strings, NaN,
// infinitos y pares incompletos ANTES de llegar a SQL.

const DECIMALES = 6; // ~0,1 m; mas precision es ruido y dato personal de sobra
const RADIO_TIERRA_M = 6371000;

// ETA aproximada: la linea recta subestima el camino real, y en ciudad se maneja lento.
const FACTOR_CAMINO = 1.4;
const VELOCIDAD_MEDIA_KMH = 40;

// Una posicion con hora del futuro (reloj del telefono mal puesto) bloquearia las siguientes,
// que siempre serian "mas viejas". Se tolera un desfase chico y se rechaza el resto.
const TOLERANCIA_FUTURO_MS = 2 * 60 * 1000;
const ANTIGUEDAD_MAXIMA_MS = 10 * 60 * 1000;

function esNumeroFinito(x) {
    return typeof x === 'number' && Number.isFinite(x);
}

function redondear(x) {
    const f = 10 ** DECIMALES;
    return Math.round(x * f) / f;
}

/**
 * Valida un par latitud/longitud que llega del cliente HTTP (JSON).
 * - Ninguna de las dos: es valido, significa "sin ubicacion" (`presente: false`).
 * - Solo una, strings, NaN, infinitos o fuera de rango: invalido.
 * - Se redondea a 6 decimales.
 * @returns {{ok: true, presente: boolean, latitud: number|null, longitud: number|null}
 *          | {ok: false, error: string}}
 */
function validarCoordenadas(latitud, longitud) {
    const sinLat = latitud === undefined || latitud === null;
    const sinLng = longitud === undefined || longitud === null;
    if (sinLat && sinLng) return { ok: true, presente: false, latitud: null, longitud: null };
    if (sinLat || sinLng) return { ok: false, error: 'Indique latitud y longitud juntas' };
    if (!esNumeroFinito(latitud) || !esNumeroFinito(longitud)) {
        return { ok: false, error: 'Latitud y longitud deben ser numeros' };
    }
    if (latitud < -90 || latitud > 90) return { ok: false, error: 'Latitud fuera de rango (-90 a 90)' };
    if (longitud < -180 || longitud > 180) return { ok: false, error: 'Longitud fuera de rango (-180 a 180)' };
    return { ok: true, presente: true, latitud: redondear(latitud), longitud: redondear(longitud) };
}

/**
 * Cuerpo de PUT /api/mapa/bodega. Exige las dos coordenadas validas o un borrado explicito
 * (latitud y longitud presentes, las dos en null). Un cuerpo vacio o con una sola no es un borrado.
 * @returns {{ok: true, latitud: number|null, longitud: number|null}|{ok: false, error: string}}
 */
function validarUbicacionBodega(cuerpo) {
    const c = cuerpo && typeof cuerpo === 'object' ? cuerpo : {};
    const lat = c.latitud;
    const lng = c.longitud;
    if (lat === undefined && lng === undefined) {
        return { ok: false, error: 'Indique latitud y longitud, o las dos en null para quitar la ubicación' };
    }
    if (lat === undefined || lng === undefined || (lat === null) !== (lng === null)) {
        return { ok: false, error: 'Indique latitud y longitud juntas' };
    }
    if (lat === null) return { ok: true, latitud: null, longitud: null };
    const r = validarCoordenadas(lat, lng);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, latitud: r.latitud, longitud: r.longitud };
}

/**
 * Igual que validarCoordenadas pero para formularios multipart, donde todo llega como texto.
 * Un string vacio cuenta como "no vino"; un string numerico se convierte; el resto se rechaza.
 */
function validarCoordenadasFormulario(latitud, longitud) {
    const aNumero = (v) => {
        if (typeof v !== 'string') return v;
        const t = v.trim();
        if (t === '') return undefined;
        return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
    };
    return validarCoordenadas(aNumero(latitud), aNumero(longitud));
}

/**
 * Lee las coordenadas de una fila de la base. NUMERIC llega como string desde `pg`, por eso
 * aqui si se aceptan strings numericos (a diferencia de validarCoordenadas, que mira el JSON
 * del cliente). null si falta alguna o no es un numero valido.
 */
function coordenadasDeFila(fila, campoLat = 'latitud', campoLng = 'longitud') {
    if (!fila) return null;
    const lat = fila[campoLat];
    const lng = fila[campoLng];
    if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
    const resultado = validarCoordenadas(Number(lat), Number(lng));
    if (!resultado.ok || !resultado.presente) return null;
    return { latitud: resultado.latitud, longitud: resultado.longitud };
}

/** Distancia en linea recta (haversine) entre dos puntos, en metros. */
function distanciaMetros(a, b) {
    const rad = (g) => (g * Math.PI) / 180;
    const dLat = rad(b.latitud - a.latitud);
    const dLng = rad(b.longitud - a.longitud);
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(rad(a.latitud)) * Math.cos(rad(b.latitud)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * RADIO_TIERRA_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * Estimacion de respaldo cuando OpenRouteService no responde o no hay cupo.
 * @returns {{distancia_m: number, segundos: number}} distancia ya corregida por el factor de camino
 */
function etaAproximada(origen, destino) {
    const directa = distanciaMetros(origen, destino);
    const distancia = Math.round(directa * FACTOR_CAMINO);
    const segundos = Math.round((distancia / 1000 / VELOCIDAD_MEDIA_KMH) * 3600);
    return { distancia_m: distancia, segundos };
}

/**
 * Decide si la hora de captura que manda el telefono es creible.
 * @param {string|number|Date} capturadaEn hora en que el telefono tomo la posicion
 * @param {Date} ahora hora del servidor (se inyecta para poder probar)
 * @returns {{ok: true, fecha: Date} | {ok: false, motivo: 'invalida'|'futura'|'antigua'}}
 */
function evaluarCapturadaEn(capturadaEn, ahora = new Date()) {
    if (capturadaEn === undefined || capturadaEn === null || capturadaEn === '') {
        return { ok: false, motivo: 'invalida' };
    }
    const fecha = new Date(capturadaEn);
    if (Number.isNaN(fecha.getTime())) return { ok: false, motivo: 'invalida' };
    const diferencia = ahora.getTime() - fecha.getTime();
    if (diferencia < -TOLERANCIA_FUTURO_MS) return { ok: false, motivo: 'futura' };
    if (diferencia > ANTIGUEDAD_MAXIMA_MS) return { ok: false, motivo: 'antigua' };
    return { ok: true, fecha };
}

module.exports = {
    DECIMALES,
    FACTOR_CAMINO,
    VELOCIDAD_MEDIA_KMH,
    TOLERANCIA_FUTURO_MS,
    ANTIGUEDAD_MAXIMA_MS,
    validarCoordenadas,
    validarCoordenadasFormulario,
    validarUbicacionBodega,
    coordenadasDeFila,
    distanciaMetros,
    etaAproximada,
    evaluarCapturadaEn,
};
