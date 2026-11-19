const express = require('express');
require('../utils/asyncErrores');
const pool = require('../config/db');
const { verifyToken } = require('../middleware/auth');
const { limiteDispositivos } = require('../middleware/limites');

const router = express.Router();

// Registro de dispositivos para avisos push (tabla dispositivos_push, migracion 048). Las apps llaman aqui en
// linea (no por la cola offline: un token viejo no sirve) al iniciar sesion, cuando FCM renueva el token y
// al cerrar sesion. Cada usuario solo ve y toca sus propios dispositivos, y nunca se devuelve un token.

const MAX_DISPOSITIVOS_ACTIVOS = 10;
const PLATAFORMAS = ['android', 'web'];
const APPS = ['terreno', 'panel'];
// los tokens de FCM son texto url-safe con ':' (ID de instalacion y secreto); se acota para no guardar basura
const TOKEN_VALIDO = /^[A-Za-z0-9_:.-]{20,4096}$/;

function tokenValido(valor) {
    return typeof valor === 'string' && TOKEN_VALIDO.test(valor);
}

// POST /api/dispositivos { token, plataforma, app }
// Upsert por token: si ese token ya estaba (otro usuario en el mismo telefono, o el mismo que renueva) pasa a
// ser de quien llama, con la sesion actual y activo. La app terreno es solo del rol mecanico.
router.post('/', verifyToken, limiteDispositivos, async (req, res) => {
    const { token, plataforma, app } = req.body || {};
    if (!tokenValido(token)) return res.status(400).json({ error: 'Token de dispositivo inválido' });
    if (!PLATAFORMAS.includes(plataforma)) return res.status(400).json({ error: 'Plataforma inválida' });
    if (!APPS.includes(app)) return res.status(400).json({ error: 'App inválida' });
    if (app === 'terreno' && req.user.rol !== 'mecanico') {
        return res.status(403).json({ error: 'No tienes permiso para esta acción' });
    }
    const r = await pool.query(
        `INSERT INTO dispositivos_push (usuario_id, sesion_id, plataforma, app, token)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (token) DO UPDATE
            SET usuario_id = EXCLUDED.usuario_id, sesion_id = EXCLUDED.sesion_id, plataforma = EXCLUDED.plataforma,
                app = EXCLUDED.app, activo = true, ultimo_uso_at = now()
         RETURNING id`,
        [req.user.id, req.user.sid ?? null, plataforma, app, token]
    );
    // tope por usuario: quedan los MAX mas recientes, los demas se desactivan (un telefono que reinstala la app
    // deja tokens muertos; asi no se acumulan ni se mandan avisos a ellos)
    await pool.query(
        `UPDATE dispositivos_push SET activo = false
         WHERE usuario_id = $1 AND activo AND id NOT IN (
             SELECT id FROM dispositivos_push WHERE usuario_id = $1 AND activo ORDER BY ultimo_uso_at DESC, id DESC LIMIT $2
         )`,
        [req.user.id, MAX_DISPOSITIVOS_ACTIVOS]
    );
    res.status(201).json({ id: Number(r.rows[0].id) });
});

// DELETE /api/dispositivos { token }
// Desactiva el dispositivo propio (la app lo llama al cerrar sesion). Siempre 204: no revela si el token existe
// ni de quien es; un token ajeno simplemente no se toca.
router.delete('/', verifyToken, limiteDispositivos, async (req, res) => {
    const { token } = req.body || {};
    if (tokenValido(token)) {
        await pool.query('UPDATE dispositivos_push SET activo = false WHERE token = $1 AND usuario_id = $2', [token, req.user.id]);
    }
    res.status(204).end();
});

module.exports = router;
