// Buscador de direcciones para la oficina: el administrativo escribe una direccion y elige una
// sugerencia (como en Mercado Libre), sin tener que conocer coordenadas.
//
// Usa el geocodificador de OpenRouteService (HeiGIT, basado en Pelias), con la misma llave que las
// rutas. El plan gratuito tiene cupo bajo (1.000 consultas al dia y 100 por minuto en geocodificacion),
// asi que:
//   - el panel espera a que se deje de escribir y no busca con menos de 3 letras,
//   - aqui se limita por usuario y por dia (limitador en memoria: un solo servidor, y si reinicia
//     solo se "perdona" el contador, no se pasa del cupo real porque el proveedor tambien lo corta).
// Nunca se envia a este servicio datos de clientes ni de equipos: solo el texto que escribe la oficina.

const { ErrorOrs, tipoDeEstadoHttp, hayLlave } = require('./ors');
const { validarCoordenadas } = require('../utils/geo');

// El geocodificador (Pelias) tiene su propia ruta en el dominio nuevo de HeiGIT; no cuelga de /openrouteservice.
const BASE_URL_POR_DEFECTO = 'https://api.heigit.org/pelias/v1';
const TIMEOUT_MS = 5000;
const MAX_SUGERENCIAS = 6;
const MIN_LETRAS = 3;
const MAX_LETRAS = 120;

// Un poco bajo el limite real para dejar margen a las rutas y a otros usos de la misma llave.
const LIMITE_POR_USUARIO_MINUTO = 20;
const LIMITE_DIARIO = 800;

/**
 * Limitador simple en memoria. `ahora` se inyecta para probarlo sin esperar.
 * @returns {{intentar: (clave:string|number, ahora?:number) => {ok:true}|{ok:false, motivo:'usuario_minuto'|'diario'}}}
 */
function crearLimitador({ porUsuarioMinuto = LIMITE_POR_USUARIO_MINUTO, diario = LIMITE_DIARIO } = {}) {
    const porUsuario = new Map(); // clave -> marcas de tiempo del ultimo minuto
    let dia = null;
    let usoDiario = 0;
    const diaDe = (ms) => new Date(ms).toISOString().slice(0, 10);
    return {
        intentar(clave, ahora = Date.now()) {
            const hoy = diaDe(ahora);
            if (hoy !== dia) {
                dia = hoy;
                usoDiario = 0;
            }
            if (usoDiario >= diario) return { ok: false, motivo: 'diario' };
            const recientes = (porUsuario.get(clave) || []).filter((t) => ahora - t < 60_000);
            if (recientes.length >= porUsuarioMinuto) {
                porUsuario.set(clave, recientes);
                return { ok: false, motivo: 'usuario_minuto' };
            }
            recientes.push(ahora);
            porUsuario.set(clave, recientes);
            usoDiario += 1;
            return { ok: true };
        },
    };
}

/** El limitador (por usuario o diario) no deja hacer otra consulta al proveedor. */
class ErrorLimite extends Error {
    constructor(motivo) {
        super(`limite de busquedas: ${motivo}`);
        this.name = 'ErrorLimite';
        this.motivo = motivo;
    }
}

/**
 * Deja solo la calle de una direccion: primer tramo antes de la coma, "Av." como "Avenida" y sin numero.
 * El proveedor ubica bien las calles de Chile pero casi nunca el numero ni la comuna ("Av. Apoquindo 4500,
 * Las Condes" no da resultados y "Avenida Apoquindo" si). Devuelve null si no cambia nada.
 */
function simplificarACalle(texto) {
    // en una ruta o un kilometro el numero ES la direccion: quitarlo la destruye
    if (/\b(?:ruta|km|kil[oó]metro)\b/i.test(String(texto))) return null;
    const primero = String(texto).split(',')[0];
    const calle = primero
        .replace(/\b(?:av|avda|avd)\b\.?/gi, 'Avenida')
        .replace(/(?:\bn[°ºo]\.?\s*|#\s*)?\b\d[\d.\-]*\b/gi, ' ')
        .replace(/\bs\/n\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (calle.length < MIN_LETRAS) return null;
    return calle.toLowerCase() === String(texto).trim().toLowerCase() ? null : calle;
}

/** Texto de busqueda valido: se recorta, sin letras de control, entre 3 y 120 caracteres. */
function normalizarTexto(texto) {
    if (typeof texto !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const limpio = texto.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (limpio.length < MIN_LETRAS || limpio.length > MAX_LETRAS) return null;
    return limpio;
}

/**
 * Saca las sugerencias de una respuesta GeoJSON de Pelias. Un resultado sin etiqueta o con
 * coordenadas invalidas se descarta: nunca se ofrece un punto inventado.
 * @returns {{etiqueta:string, latitud:number, longitud:number}[]}
 */
function interpretarSugerencias(json) {
    if (!json || !Array.isArray(json.features)) throw new ErrorOrs('respuesta', 'La respuesta del buscador no trae resultados');
    const vistas = new Set();
    const resultado = [];
    for (const f of json.features) {
        const etiqueta = f && f.properties && typeof f.properties.label === 'string' ? f.properties.label.trim() : '';
        const c = f && f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
        if (!etiqueta || !c) continue;
        const v = validarCoordenadas(c[1], c[0]); // GeoJSON es [longitud, latitud]
        if (!v.ok || !v.presente) continue;
        if (vistas.has(etiqueta)) continue;
        vistas.add(etiqueta);
        resultado.push({ etiqueta, latitud: v.latitud, longitud: v.longitud });
        if (resultado.length >= MAX_SUGERENCIAS) break;
    }
    return resultado;
}

/**
 * Busca sugerencias de direcciones. Orden (se corta en el primero que da resultados):
 *   1. autocompletar con el texto tal cual,
 *   2. autocompletar solo con la calle (sin numero ni comuna),
 *   3. busqueda completa del proveedor (a veces solo ubica la comuna).
 * Las de los pasos 2 y 3 salen con `aproximada: true`: el panel avisa que conviene ajustar el punto.
 * Cada consulta al proveedor llama antes a `antesDeConsultar`, que puede lanzar ErrorLimite: asi el
 * cupo se cuenta por consulta real y no por busqueda del usuario.
 * @param {string} texto ya normalizado
 * @param {object} [opciones] fetchFn y llave se inyectan para probar sin red
 */
async function buscarDirecciones(texto, opciones = {}) {
    const {
        fetchFn = fetch,
        llave = process.env.ORS_API_KEY,
        baseUrl = process.env.PELIAS_BASE_URL || BASE_URL_POR_DEFECTO,
        timeoutMs = TIMEOUT_MS,
        antesDeConsultar = () => {},
    } = opciones;
    if (typeof llave !== 'string' || llave.trim() === '') throw new ErrorOrs('sin_llave', 'No hay llave del servicio de mapas');

    const consultar = async (ruta, consulta) => {
        antesDeConsultar();
        const url = new URL(`${baseUrl}${ruta}`);
        url.searchParams.set('text', consulta);
        url.searchParams.set('boundary.country', 'CL');
        url.searchParams.set('size', String(MAX_SUGERENCIAS));
        url.searchParams.set('lang', 'es');
        let respuesta;
        try {
            respuesta = await fetchFn(url, {
                headers: { Authorization: llave.trim(), Accept: 'application/json' },
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new ErrorOrs('timeout', 'El buscador de direcciones no respondio a tiempo');
            throw new ErrorOrs('red', 'No se pudo conectar con el buscador de direcciones');
        }
        if (!respuesta.ok) {
            throw new ErrorOrs(tipoDeEstadoHttp(respuesta.status), `El buscador de direcciones respondio ${respuesta.status}`, respuesta.status);
        }
        let json;
        try {
            json = await respuesta.json();
        } catch (err) {
            throw new ErrorOrs('respuesta', 'La respuesta del buscador no es JSON');
        }
        return interpretarSugerencias(json);
    };
    const marcar = (lista, aproximada) => lista.map((x) => ({ ...x, aproximada }));

    let r = await consultar('/autocomplete', texto);
    if (r.length > 0) return marcar(r, false);
    const calle = simplificarACalle(texto);
    if (calle) {
        r = await consultar('/autocomplete', calle);
        if (r.length > 0) return marcar(r, true);
    }
    r = await consultar('/search', texto);
    return marcar(r, true);
}

module.exports = {
    BASE_URL_POR_DEFECTO, MIN_LETRAS, MAX_LETRAS, MAX_SUGERENCIAS, LIMITE_POR_USUARIO_MINUTO, LIMITE_DIARIO,
    ErrorLimite, crearLimitador, normalizarTexto, simplificarACalle, interpretarSugerencias, buscarDirecciones, hayLlave,
};
