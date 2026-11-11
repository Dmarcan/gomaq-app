// Crear y revocar sesiones (tabla sesiones). Las reglas puras estan en utils/sesiones.js.

const {
    generarToken, hashToken, normalizarApp, vencimientoAbsoluto, INACTIVIDAD_MINUTOS, MAX_SESIONES_ACTIVAS,
} = require('../utils/sesiones');

/**
 * Abre una sesion y devuelve el token en claro (solo se ve aqui: la base guarda su hash). Limpia las
 * sesiones viejas de la cuenta y deja como maximo MAX_SESIONES_ACTIVAS abiertas (cierra las mas antiguas).
 * @param {import('pg').Pool|import('pg').PoolClient} db
 * @returns {Promise<{token:string, sid:string, expiraAt:Date}>}
 */
async function crearSesion(db, usuarioId, { app, userAgent } = {}) {
    const token = generarToken();
    const expiraAt = vencimientoAbsoluto();
    const r = await db.query(
        `INSERT INTO sesiones (usuario_id, token_hash, app, expira_at, inactividad_min, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [usuarioId, hashToken(token), normalizarApp(app), expiraAt, INACTIVIDAD_MINUTOS, String(userAgent || '').slice(0, 200) || null]
    );
    // mantenimiento de la cuenta: nunca hace fallar el inicio de sesion
    try {
        await db.query(
            `DELETE FROM sesiones
             WHERE usuario_id = $1 AND (revocada_at < now() - interval '30 days' OR expira_at < now() - interval '30 days')`,
            [usuarioId]
        );
        await db.query(
            `UPDATE sesiones SET revocada_at = now(), motivo = 'limite'
             WHERE usuario_id = $1 AND revocada_at IS NULL AND id NOT IN (
                 SELECT id FROM sesiones WHERE usuario_id = $1 AND revocada_at IS NULL ORDER BY id DESC LIMIT $2
             )`,
            [usuarioId, MAX_SESIONES_ACTIVAS]
        );
    } catch (err) {
        console.error('No se pudo limpiar las sesiones de la cuenta:', err && err.message);
    }
    return { token, sid: r.rows[0].id, expiraAt };
}

/**
 * Revoca las sesiones abiertas de una cuenta, menos la indicada en `excepto` (la actual).
 * @returns {Promise<number>} cuantas cerro
 */
async function revocarSesiones(db, usuarioId, { excepto = null, motivo = 'revocada' } = {}) {
    const r = await db.query(
        `UPDATE sesiones SET revocada_at = now(), motivo = $3
         WHERE usuario_id = $1 AND revocada_at IS NULL AND ($2::bigint IS NULL OR id <> $2::bigint)`,
        [usuarioId, excepto, motivo]
    );
    return r.rowCount;
}

module.exports = { crearSesion, revocarSesiones };
