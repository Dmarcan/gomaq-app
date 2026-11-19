// Reglas puras del viaje del mecanico: que la hora de llegada se mantenga al dia entre consultas al
// servicio de rutas, y desde cuando esta quieto. Sin consultas a la base: guardarPosicion las usa.
//
// La ruta real (OpenRouteService) se pide poco por el cupo gratuito (utils/recalculoEta.js). Entre
// una consulta y otra, la hora se ajusta con la distancia recta que queda, que es gratis: si el
// mecanico recorrio la mitad del camino en linea recta, quedan mas o menos la mitad de los segundos.

const { distanciaMetros, etaAproximada } = require('./geo');

const CONFIG = {
    llegadaMetros: 150,       // a esta distancia se considera casi llegado
    llegadaSegundos: 60,      // lo que queda cuando ya esta casi en el destino
    minTramoMetros: 1000,     // bajo esto la proporcion es poco confiable: se usa la aproximada
    maxDesvio: 1.3,           // si esta mas lejos que el 130 % de la distancia de la consulta, se desvio
    minFuturoSegundos: 60,    // la hora de llegada nunca queda en el pasado: al menos ahora + 60 s
    quietoMinMetros: 75,      // bajo esta distancia entre dos posiciones (o la precision, si es mayor) no se movio
};

/**
 * Hora de llegada ajustada a la posicion actual.
 *
 * @param {object} p
 * @param {number} p.etaSegundos segundos que dijo la ruta real en su consulta
 * @param {{latitud:number, longitud:number}} p.origenConsulta donde estaba el mecanico en esa consulta
 * @param {{latitud:number, longitud:number}} p.destino
 * @param {{latitud:number, longitud:number}} p.posicion posicion actual
 * @param {Date} p.capturadaEn cuando el telefono tomo la posicion actual
 * @param {Date} [p.ahora]
 * @returns {{llegadaAt: Date, segundosRestantes: number, metodo: string}|null} null si faltan datos
 */
function ajustarEta({ etaSegundos, origenConsulta, destino, posicion, capturadaEn, ahora = new Date() }, config = {}) {
    const cfg = { ...CONFIG, ...config };
    if (!Number.isFinite(etaSegundos) || etaSegundos < 0 || !origenConsulta || !destino || !posicion || !capturadaEn) return null;

    const d0 = distanciaMetros(origenConsulta, destino);
    const d = distanciaMetros(posicion, destino);

    let restantes;
    let metodo;
    if (d <= cfg.llegadaMetros) {
        restantes = cfg.llegadaSegundos;
        metodo = 'casi_llegado';
    } else if (d0 < cfg.minTramoMetros || d / d0 > cfg.maxDesvio) {
        restantes = etaAproximada(posicion, destino).segundos;
        metodo = 'aproximada';
    } else {
        restantes = Math.round(etaSegundos * (d / d0));
        metodo = 'proporcional';
    }

    const desdeCaptura = new Date(capturadaEn).getTime() + restantes * 1000;
    const minimo = ahora.getTime() + cfg.minFuturoSegundos * 1000;
    return { llegadaAt: new Date(Math.max(desdeCaptura, minimo)), segundosRestantes: restantes, metodo };
}

/**
 * Desde cuando esta quieto el mecanico. Si se movio mas que el umbral desde la posicion anterior,
 * quieto_desde se reinicia a la hora de la nueva; si no, se conserva.
 *
 * @param {{latitud:number, longitud:number, capturada_en:Date|string, quieto_desde?:Date|string|null, orden_trabajo_id:number}|null} previa
 *   fila guardada antes (null si no habia)
 * @param {{latitud:number, longitud:number, capturadaEn:Date, precisionM?:number|null, ordenId:number}} nueva
 * @returns {Date}
 */
function calcularQuietoDesde(previa, nueva, config = {}) {
    const cfg = { ...CONFIG, ...config };
    const nuevaHora = new Date(nueva.capturadaEn);
    if (!previa || previa.orden_trabajo_id !== nueva.ordenId) return nuevaHora;
    const movido = distanciaMetros(
        { latitud: Number(previa.latitud), longitud: Number(previa.longitud) },
        { latitud: nueva.latitud, longitud: nueva.longitud }
    );
    const umbral = Math.max(cfg.quietoMinMetros, Number.isFinite(nueva.precisionM) ? nueva.precisionM : 0);
    if (movido > umbral) return nuevaHora;
    return new Date(previa.quieto_desde || previa.capturada_en);
}

module.exports = { ajustarEta, calcularQuietoDesde };
