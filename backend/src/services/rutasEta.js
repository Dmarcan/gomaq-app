// Mejora la ETA aproximada de una OT en camino con una ruta real del servicio de rutas.
//
// Corre FUERA de la respuesta al mecanico (las rutas lo llaman sin await despues del COMMIT): el
// mecanico nunca espera al servicio ni su cambio de estado depende de el. Si no hay llave, no hay
// cupo, el servicio falla o tarda, la OT conserva la ETA aproximada que guardarPosicion ya calculo.
//
// Cupo (plan gratuito: 2.000 consultas al dia, 40 por minuto):
//  - La decision de consultar es una regla pura (utils/recalculoEta.js).
//  - El cupo se RESERVA con un UPDATE/INSERT atomico ANTES de llamar. Leer y luego incrementar
//    dejaria pasarse del tope con dos posiciones simultaneas, y un contador en memoria no sirve si
//    hay mas de una replica. Una consulta reservada que falla igual cuenta: es lo conservador.
//  - El dia del cupo es UTC; el limite real corre 24 h desde la primera consulta, y el tope propio
//    (1.500) deja margen para esa diferencia.
//
// Resultados viejos no pisan a los nuevos: el UPDATE final solo aplica si la OT sigue en camino con
// el mismo mecanico y no hay una ETA de rutas mas reciente.

const { coordenadasDeFila } = require('../utils/geo');
const { decidirRecalculo, CONFIG_POR_DEFECTO } = require('../utils/recalculoEta');
const ors = require('./ors');

const DIA_UTC = `(now() AT TIME ZONE 'UTC')::date`;

/**
 * Reserva una consulta: la de la OT y la del dia. Atomico por UPDATE/INSERT condicionado.
 * @returns {Promise<{ok: true} | {ok: false, motivo: 'tope_por_ot'|'cupo_diario'}>}
 */
async function reservarConsulta(db, ordenId, config = CONFIG_POR_DEFECTO) {
    const porOt = await db.query(
        `UPDATE ordenes_trabajo SET eta_consultas = eta_consultas + 1
         WHERE id = $1 AND eta_consultas < $2 RETURNING eta_consultas`,
        [ordenId, config.maxPorOt]
    );
    if (porOt.rowCount === 0) return { ok: false, motivo: 'tope_por_ot' };

    const diario = await db.query(
        `INSERT INTO uso_ors (dia, consultas) VALUES (${DIA_UTC}, 1)
         ON CONFLICT (dia) DO UPDATE SET consultas = uso_ors.consultas + 1
         WHERE uso_ors.consultas < $1
         RETURNING consultas`,
        [config.cupoDiario]
    );
    if (diario.rowCount === 0) {
        // el dia esta agotado: se devuelve lo reservado en la OT
        await db.query('UPDATE ordenes_trabajo SET eta_consultas = eta_consultas - 1 WHERE id = $1', [ordenId]);
        return { ok: false, motivo: 'cupo_diario' };
    }
    return { ok: true };
}

/**
 * @param {object} db pool o cliente de pg (fuera de la transaccion del mecanico)
 * @param {{ordenId:number, usuarioId:number, origen:{latitud:number, longitud:number}}} p
 * @param {object} [opciones] ahora, config, llamar y hayLlave se inyectan para probar sin red
 * @returns {Promise<{consultada: boolean, guardada?: boolean, motivo?: string}>} nunca lanza
 */
async function mejorarEtaConRutas(db, { ordenId, usuarioId, origen }, opciones = {}) {
    const {
        ahora = new Date(), config = CONFIG_POR_DEFECTO,
        llamar = ors.calcularRuta, hayLlave = ors.hayLlave, log = console,
    } = opciones;
    try {
        if (!hayLlave()) return { consultada: false, motivo: 'sin_llave' };

        const ot = (await db.query(
            `SELECT estado, mecanico_id, destino_lat, destino_lng, eta_fuente, eta_calculada_at,
                    eta_origen_lat, eta_origen_lng, eta_consultas
             FROM ordenes_trabajo WHERE id = $1`,
            [ordenId]
        )).rows[0];
        if (!ot || ot.mecanico_id !== usuarioId) return { consultada: false, motivo: 'orden_cambio' };
        const destino = coordenadasDeFila(ot, 'destino_lat', 'destino_lng');
        if (!destino) return { consultada: false, motivo: 'sin_destino' };

        const hoy = (await db.query(
            `SELECT COALESCE((SELECT consultas FROM uso_ors WHERE dia = ${DIA_UTC}), 0)::int AS n`
        )).rows[0].n;

        // solo una ETA que vino del servicio de rutas cuenta como "ultimo calculo": la aproximada se
        // recalcula con cada posicion y no sirve de referencia
        const previaEsRuta = ot.eta_fuente === 'ors';
        const decision = decidirRecalculo({
            estado: ot.estado,
            ultimoCalculoAt: previaEsRuta ? ot.eta_calculada_at : null,
            posicionUltimoCalculo: previaEsRuta ? coordenadasDeFila(ot, 'eta_origen_lat', 'eta_origen_lng') : null,
            posicionActual: origen,
            consultasOt: ot.eta_consultas,
            consultasHoy: hoy,
            ahora,
        }, config);
        if (!decision.recalcular) return { consultada: false, motivo: decision.motivo };

        const reserva = await reservarConsulta(db, ordenId, config);
        if (!reserva.ok) return { consultada: false, motivo: reserva.motivo };

        let ruta;
        try {
            ruta = await llamar(origen, destino);
        } catch (err) {
            // solo el tipo: nada del mensaje ni de la peticion llega al log
            log.warn(`ETA: servicio de rutas no disponible (${err && err.tipo ? err.tipo : 'desconocido'}); se mantiene la aproximada`);
            return { consultada: true, guardada: false, motivo: 'ors_fallo' };
        }

        const guardado = await db.query(
            `UPDATE ordenes_trabajo
             SET eta_segundos = $1, eta_distancia_m = $2, eta_calculada_at = $3, eta_fuente = 'ors',
                 eta_origen_lat = $4, eta_origen_lng = $5
             WHERE id = $6 AND estado = 'en_camino' AND mecanico_id = $7
               AND (eta_fuente IS DISTINCT FROM 'ors' OR eta_calculada_at IS NULL OR eta_calculada_at <= $3)
             RETURNING id`,
            [ruta.segundos, ruta.distancia_m, ahora.toISOString(), origen.latitud, origen.longitud, ordenId, usuarioId]
        );
        return { consultada: true, guardada: guardado.rowCount === 1, motivo: guardado.rowCount === 1 ? undefined : 'obsoleta' };
    } catch (err) {
        log.error('ETA por rutas fallo:', err && err.message);
        return { consultada: false, motivo: 'error' };
    }
}

module.exports = { reservarConsulta, mejorarEtaConRutas };
