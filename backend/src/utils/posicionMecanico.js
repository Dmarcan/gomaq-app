// Ultima posicion del mecanico mientras va en camino, y la ETA que se deriva de ella.
//
// Una sola fila por mecanico (se pisa), sin historial. Solo se guarda mientras la OT esta en
// 'en_camino'; se borra al llegar, finalizar o reasignar. El cliente nunca la ve, solo la ETA.
//
// Las posiciones NO pasan por la cola offline (no llevan uuid_cliente): una posicion vieja no sirve.
// Por eso la idempotencia es por hora de captura: solo se acepta una posicion mas nueva que la
// guardada, y un reintento o una posicion atrasada no pisa a la vigente.

const { validarCoordenadas, evaluarCapturadaEn, coordenadasDeFila, etaAproximada } = require('./geo');

/**
 * Valida y guarda la posicion de un mecanico para una OT que esta en camino. El llamador es
 * responsable de haber verificado que el mecanico es el dueno y que la OT esta en 'en_camino', y de
 * hacerlo dentro de la transaccion que bloquea la fila de la OT (FOR UPDATE).
 *
 * @param {object} db cliente de pg de la transaccion
 * @param {object} p
 * @param {number} p.ordenId
 * @param {number} p.usuarioId
 * @param {{latitud:any, longitud:any, capturada_en:any, precision_m?:any}} p.posicion
 * @param {Date} [p.ahora]
 * @returns {Promise<{guardada: boolean, motivo?: string, error?: string, eta?: object}>}
 *   motivos: coordenadas_invalidas | hora_invalida | hora_futura (error del cliente),
 *            hora_antigua | mas_vieja (descartada sin error)
 */
async function guardarPosicion(db, { ordenId, usuarioId, posicion, ahora = new Date() }) {
    const p = posicion || {};
    const coords = validarCoordenadas(p.latitud, p.longitud);
    if (!coords.ok || !coords.presente) {
        return { guardada: false, motivo: 'coordenadas_invalidas', error: coords.ok ? 'Falta la posicion' : coords.error };
    }
    const hora = evaluarCapturadaEn(p.capturada_en, ahora);
    if (!hora.ok) {
        return { guardada: false, motivo: hora.motivo === 'invalida' ? 'hora_invalida' : hora.motivo === 'futura' ? 'hora_futura' : 'hora_antigua' };
    }
    const precision = Number.isFinite(p.precision_m) && p.precision_m >= 0 ? Math.round(p.precision_m) : null;

    // upsert condicionado: pisa solo si es mas nueva, o si la fila guardada era de otra OT (un viaje anterior)
    const guardado = await db.query(
        `INSERT INTO posiciones_mecanico (usuario_id, orden_trabajo_id, latitud, longitud, precision_m, capturada_en)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (usuario_id) DO UPDATE SET
             orden_trabajo_id = EXCLUDED.orden_trabajo_id, latitud = EXCLUDED.latitud,
             longitud = EXCLUDED.longitud, precision_m = EXCLUDED.precision_m,
             capturada_en = EXCLUDED.capturada_en, recibida_en = now()
         WHERE posiciones_mecanico.orden_trabajo_id <> EXCLUDED.orden_trabajo_id
            OR posiciones_mecanico.capturada_en < EXCLUDED.capturada_en
         RETURNING usuario_id`,
        [usuarioId, ordenId, coords.latitud, coords.longitud, precision, hora.fecha.toISOString()]
    );
    if (guardado.rowCount === 0) return { guardada: false, motivo: 'mas_vieja' };

    const origen = { latitud: coords.latitud, longitud: coords.longitud };
    const eta = await actualizarEtaAproximada(db, ordenId, origen, ahora);
    // origen: lo usa el llamador para pedir, ya fuera de la transaccion, una ruta real (services/rutasEta.js)
    return { guardada: true, eta, origen };
}

/**
 * ETA de respaldo, en linea recta corregida. Es gratis y sin red, asi que se recalcula con cada
 * posicion; el servicio de rutas la reemplaza por una mejor cuando esta disponible. Sin destino
 * en la OT no hay nada que calcular.
 */
async function actualizarEtaAproximada(db, ordenId, origen, ahora = new Date()) {
    const ot = (await db.query(
        'SELECT destino_lat, destino_lng FROM ordenes_trabajo WHERE id = $1',
        [ordenId]
    )).rows[0];
    const destino = coordenadasDeFila(ot, 'destino_lat', 'destino_lng');
    if (!destino) return null;
    const eta = etaAproximada(origen, destino);
    // una ETA que ya vino del servicio de rutas no se pisa con la aproximada: es mejor aunque sea
    // un poco mas vieja. Solo se renueva cuando services/rutasEta.js decide consultar de nuevo.
    const r = await db.query(
        `UPDATE ordenes_trabajo SET eta_segundos = $1, eta_distancia_m = $2, eta_calculada_at = $3,
                eta_fuente = 'aproximada', eta_origen_lat = $4, eta_origen_lng = $5
         WHERE id = $6 AND eta_fuente IS DISTINCT FROM 'ors'`,
        [eta.segundos, eta.distancia_m, ahora.toISOString(), origen.latitud, origen.longitud, ordenId]
    );
    return r.rowCount === 1 ? { segundos: eta.segundos, distancia_m: eta.distancia_m, fuente: 'aproximada' } : null;
}

/**
 * Borra la posicion y la ETA de la OT: el viaje termino o cambio de tecnico. Es lo que cumple la
 * regla de privacidad (la posicion solo vive mientras el mecanico va en camino).
 */
async function limpiarViaje(db, ordenId) {
    await db.query('DELETE FROM posiciones_mecanico WHERE orden_trabajo_id = $1', [ordenId]);
    await db.query(
        `UPDATE ordenes_trabajo SET eta_segundos = NULL, eta_distancia_m = NULL, eta_calculada_at = NULL,
                eta_fuente = NULL, eta_origen_lat = NULL, eta_origen_lng = NULL, eta_consultas = 0
         WHERE id = $1`,
        [ordenId]
    );
}

module.exports = { guardarPosicion, actualizarEtaAproximada, limpiarViaje };
