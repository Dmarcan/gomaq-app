// Cuando conviene consultar el servicio de rutas para recalcular la ETA de una OT.
//
// El plan gratuito de OpenRouteService permite 2.000 consultas de ruta al dia y 40 por minuto.
// Estas reglas cuidan ese cupo: no se consulta si el mecanico casi no se movio, si la ultima
// consulta fue hace poco, ni cuando la OT ya gasto su tope. Cuando no se consulta (o ORS falla)
// se usa la ETA aproximada de utils/geo.js, asi que "no recalcular" nunca deja al cliente sin hora.
//
// Esto solo DECIDE. El cupo real se reserva en la base con un UPDATE atomico antes de llamar
// (leer y luego incrementar permitiria pasarse bajo concurrencia).

const { distanciaMetros } = require('./geo');

const CONFIG_POR_DEFECTO = {
    minSegundos: 3 * 60,   // minimo entre dos consultas de la misma OT
    minMetros: 500,        // el mecanico debe haberse movido al menos esto desde la ultima consulta
    maxPorOt: 15,          // tope de consultas por orden
    cupoDiario: 1500,      // margen bajo el limite real de 2.000
};

/**
 * @param {object} p
 * @param {string} p.estado estado actual de la OT
 * @param {Date|null} p.ultimoCalculoAt cuando se consulto ORS por ultima vez para esta OT
 * @param {Date|null} [p.ultimoIntentoAt] cuando se reservo la ultima consulta, haya salido bien o no
 * @param {{latitud:number, longitud:number}|null} p.posicionUltimoCalculo posicion usada en esa consulta
 * @param {{latitud:number, longitud:number}|null} p.posicionActual ultima posicion conocida del mecanico
 * @param {number} p.consultasOt consultas ya gastadas por esta OT
 * @param {number} p.consultasHoy consultas globales del dia
 * @param {Date} p.ahora hora del servidor (se inyecta para poder probar)
 * @param {object} [config] sobrescribe CONFIG_POR_DEFECTO
 * @returns {{recalcular: boolean, motivo: string}}
 */
function decidirRecalculo(p, config = {}) {
    const cfg = { ...CONFIG_POR_DEFECTO, ...config };

    if (p.estado !== 'en_camino') return { recalcular: false, motivo: 'fuera_de_camino' };
    if (!p.posicionActual) return { recalcular: false, motivo: 'sin_posicion' };
    if (p.consultasHoy >= cfg.cupoDiario) return { recalcular: false, motivo: 'cupo_diario' };
    if (p.consultasOt >= cfg.maxPorOt) return { recalcular: false, motivo: 'tope_por_ot' };

    // un intento reciente (aunque haya fallado) tambien espera: si no, con el servicio caido cada
    // posicion nueva contaria como "primera" y gastaria las consultas de la OT en pocos minutos
    if (p.ultimoIntentoAt) {
        const desdeIntento = (p.ahora.getTime() - new Date(p.ultimoIntentoAt).getTime()) / 1000;
        if (desdeIntento < cfg.minSegundos) return { recalcular: false, motivo: 'muy_reciente' };
    }

    // primera consulta de la OT: no hay con que comparar, se hace de inmediato
    if (!p.ultimoCalculoAt || !p.posicionUltimoCalculo) return { recalcular: true, motivo: 'primera' };

    const transcurridoSeg = (p.ahora.getTime() - new Date(p.ultimoCalculoAt).getTime()) / 1000;
    if (transcurridoSeg < cfg.minSegundos) return { recalcular: false, motivo: 'muy_reciente' };

    const movido = distanciaMetros(p.posicionUltimoCalculo, p.posicionActual);
    if (movido < cfg.minMetros) return { recalcular: false, motivo: 'sin_movimiento' };

    return { recalcular: true, motivo: 'movimiento' };
}

module.exports = { CONFIG_POR_DEFECTO, decidirRecalculo };
