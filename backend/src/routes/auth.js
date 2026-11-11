const express = require('express');
require('../utils/asyncErrores');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const { limiteLogin, limiteRecuperar, limiteCodigo } = require('../middleware/limites');
const { verifyToken } = require('../middleware/auth');
const { normalizarCorreo } = require('../utils/correo');
const { validarPassword } = require('../utils/cuentasInternas');
const {
    validarConfirmacion, hmacCodigo, evaluarCanje, canjePermitido, correoDisponible,
} = require('../utils/codigosCuenta');
const { crearCodigo, enviarCodigoPorCorreo } = require('../services/codigosCuenta');
const { crearSesion, revocarSesiones } = require('../services/sesiones');

const router = express.Router();

/**
 * Firma la sesion. `pc`: hora del ultimo cambio de contrasena (ms; 0 si nunca), para que verifyToken
 * corte las sesiones emitidas antes de un cambio.
 */
function emitirToken(usuario) {
    const pc = usuario.password_cambiada_at ? new Date(usuario.password_cambiada_at).getTime() : 0;
    return jwt.sign(
        { id: usuario.id, rol: usuario.rol, cliente_id: usuario.cliente_id, pc },
        process.env.JWT_SECRET,
        { expiresIn: '12h' }
    );
}

/**
 * Abre la sesion del login y devuelve el token. Con SESIONES_EN_BASE=0 vuelve al JWT de 12 h (interruptor
 * para deshacer el cambio sin desplegar de nuevo).
 */
async function emitirSesion(usuario, req) {
    if (process.env.SESIONES_EN_BASE === '0') return emitirToken(usuario);
    const s = await crearSesion(pool, usuario.id, { app: req.body && req.body.app, userAgent: req.headers['user-agent'] });
    return s.token;
}

router.post('/login', limiteLogin, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Escribe tu correo y tu contraseña' });
    }

    try {
        const result = await pool.query(
            'SELECT id, nombre, email, password_hash, rol, cliente_id, estado_cuenta, password_cambiada_at FROM usuarios WHERE lower(email) = lower($1)',
            [email]
        );
        const usuario = result.rows[0];
        if (!usuario) {
            // Si no existe en usuarios puede ser un cliente que se registro y aun no lo aprueban.
            // Se le da ese mensaje mas claro, pero SOLO tras validar su contrasena: antes se
            // devolvia sin comprobarla, lo que permitia a cualquiera averiguar que correos
            // estaban registrados probando uno por uno (enumeracion de usuarios).
            const solicitud = await pool.query(
                `SELECT password_hash FROM solicitudes_cliente WHERE lower(email) = lower($1) AND estado = 'pendiente'`,
                [email]
            );
            const pendiente = solicitud.rows[0];
            if (pendiente && await bcrypt.compare(password, pendiente.password_hash)) {
                return res.status(403).json({ error: 'Tu cuenta está en revisión. GOMAQ la aprueba en horario hábil; podrás entrar con este correo apenas quede lista' });
            }
            return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
        }

        // una cuenta invitada (pendiente) tiene una clave aleatoria que nadie conoce: no pasa de aqui
        const passwordOk = await bcrypt.compare(password, usuario.password_hash);
        if (!passwordOk) {
            return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
        }

        // defensa en profundidad: hoy los usuarios solo se crean ya activos, pero si
        // alguna vez queda uno pendiente/rechazado en la tabla, no debe poder entrar
        if (usuario.estado_cuenta === 'pendiente') {
            return res.status(403).json({ error: 'Tu cuenta está en revisión. GOMAQ la aprueba en horario hábil; podrás entrar con este correo apenas quede lista' });
        }
        if (usuario.estado_cuenta === 'rechazado') {
            return res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta a GOMAQ' });
        }

        res.json({
            token: await emitirSesion(usuario, req),
            usuario: {
                id: usuario.id,
                nombre: usuario.nombre,
                email: usuario.email,
                rol: usuario.rol,
                cliente_id: usuario.cliente_id,
            },
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al iniciar sesión' });
    }
});

const RESPUESTA_RECUPERAR = {
    ok: true,
    mensaje: 'Si el correo es de una cuenta activa, te llegará un código en unos minutos (revisa también el spam). '
        + 'Si tu cuenta no tiene un correo real, pide el código a GOMAQ.',
};

// POST /api/auth/recuperar - "Olvide mi contrasena". Responde lo mismo exista o no la cuenta, y el
// correo se envia despues de responder: ni el texto ni la demora delatan que correos estan registrados.
router.post('/recuperar', limiteRecuperar, async (req, res) => {
    const email = normalizarCorreo(req.body && req.body.email);
    if (!email || email.length > 150) {
        return res.status(400).json({ error: 'Escribe tu correo' });
    }
    const config = correoDisponible();
    if (!config.disponible) {
        console.warn(`Pedido de recuperar contraseña sin correo configurado: ${config.motivo}`);
        return res.json(RESPUESTA_RECUPERAR);
    }

    // toda la busqueda en base ocurre despues de responder: el costo de la respuesta es el mismo para un
    // correo inexistente, una cuenta con el limite alcanzado y una cuenta que recibe el codigo
    res.json(RESPUESTA_RECUPERAR);
    procesarRecuperacion(email).catch((err) => console.error('recuperar contraseña:', err));
});

async function procesarRecuperacion(email) {
    let envio = null;
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        const r = await client.query(
            `SELECT id, nombre FROM usuarios WHERE lower(email) = $1 AND estado_cuenta = 'activo' FOR UPDATE`,
            [email]
        );
        const usuario = r.rows[0];
        if (usuario) {
            // por correo: como maximo 1 por minuto y 5 por hora, para no llenarle la bandeja a nadie
            const recientes = await client.query(
                `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hora,
                        count(*) FILTER (WHERE created_at > now() - interval '1 minute')::int AS minuto
                 FROM codigos_cuenta
                 WHERE usuario_id = $1 AND proposito = 'recuperar_password' AND creado_por IS NULL`,
                [usuario.id]
            );
            const { hora, minuto } = recientes.rows[0];
            if (hora < 5 && minuto === 0) {
                const codigo = await crearCodigo(client, {
                    proposito: 'recuperar_password', usuarioId: usuario.id, email, canal: 'correo',
                });
                envio = { ...codigo, proposito: 'recuperar_password', email, nombre: usuario.nombre };
            }
        }
        await client.query('COMMIT');
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        if (client) client.release();
    }

    if (envio) enviarCodigoPorCorreo(pool, envio).catch(() => {});
}

const ERROR_CODIGO = 'El código no es válido o ya venció. Revisa el correo y el código, o pide uno nuevo';

// POST /api/auth/codigo/confirmar - canjea un codigo (invitacion o recuperar) y fija la contrasena que
// eligio la persona. La invitacion ademas activa la cuenta. Las sesiones abiertas se cortan
// (password_cambiada_at). Despues el cliente inicia sesion con la clave nueva.
router.post('/codigo/confirmar', limiteCodigo, async (req, res) => {
    const v = validarConfirmacion(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });

    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        // el correo de la cuenta tiene que seguir siendo el del codigo: si se cambio, el codigo no sirve
        const r = await client.query(
            `SELECT c.id, c.proposito, c.codigo_hmac, c.intentos, c.expira_at, c.usado_at, c.revocado_at,
                    c.usuario_id, u.estado_cuenta
             FROM codigos_cuenta c
             JOIN usuarios u ON u.id = c.usuario_id
             WHERE lower(c.email) = $1 AND lower(u.email) = $1
               AND c.proposito IN ('recuperar_password', 'invitacion')
               AND c.usado_at IS NULL AND c.revocado_at IS NULL AND c.expira_at > now()
             ORDER BY c.created_at DESC
             LIMIT 5
             FOR UPDATE OF c`,
            [v.email]
        );
        const valido = r.rows.find((f) =>
            canjePermitido(f.proposito, f.estado_cuenta)
            && evaluarCanje(f, {
                hmacIngresado: hmacCodigo({ secreto: process.env.JWT_SECRET, proposito: f.proposito, email: v.email, codigo: v.codigo }),
            }) === 'ok');

        if (!valido) {
            // cada intento fallido descuenta en todos los codigos vigentes de ese correo
            if (r.rows.length > 0) {
                await client.query('UPDATE codigos_cuenta SET intentos = intentos + 1 WHERE id = ANY($1::int[])', [r.rows.map((f) => f.id)]);
            }
            await client.query('COMMIT');
            return res.status(400).json({ error: ERROR_CODIGO });
        }

        const hash = await bcrypt.hash(v.password, 10);
        await client.query(
            `UPDATE usuarios SET password_hash = $1, password_cambiada_at = now(),
                    estado_cuenta = CASE WHEN $3 = 'invitacion' THEN 'activo'::estado_cuenta_usuario ELSE estado_cuenta END
             WHERE id = $2`,
            [hash, valido.usuario_id, valido.proposito]
        );
        await revocarSesiones(client, valido.usuario_id, { motivo: 'clave' });
        await client.query('UPDATE codigos_cuenta SET usado_at = now() WHERE id = $1', [valido.id]);
        await client.query(
            `UPDATE codigos_cuenta SET revocado_at = now()
             WHERE usuario_id = $1 AND id <> $2 AND usado_at IS NULL AND revocado_at IS NULL`,
            [valido.usuario_id, valido.id]
        );
        await client.query('COMMIT');
        console.log(`Cuenta ${valido.usuario_id}: código de ${valido.proposito} canjeado`);
        res.json({ ok: true, proposito: valido.proposito });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error(err);
        res.status(500).json({ error: 'No se pudo confirmar el código' });
    } finally {
        if (client) client.release();
    }
});

// POST /api/auth/logout - cierra la sesion actual en el servidor (el cliente igual borra su token). Con un
// token antiguo (JWT) no hay nada que revocar y responde igual.
router.post('/logout', verifyToken, async (req, res) => {
    try {
        if (req.user.sid) {
            await pool.query(`UPDATE sesiones SET revocada_at = now(), motivo = 'logout' WHERE id = $1 AND revocada_at IS NULL`, [req.user.sid]);
        }
        res.status(204).end();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'No se pudo cerrar la sesión' });
    }
});

// POST /api/auth/logout-todas - cierra todas las sesiones de la cuenta, incluida esta.
router.post('/logout-todas', verifyToken, async (req, res) => {
    try {
        await revocarSesiones(pool, req.user.id, { motivo: 'logout_todas' });
        res.status(204).end();
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'No se pudo cerrar las sesiones' });
    }
});

// POST /api/auth/cambiar-password - la persona cambia su propia clave con la sesion abierta. Las demas
// sesiones de la cuenta se cortan (password_cambiada_at) y esta recibe un token nuevo para seguir.
// Una clave actual equivocada responde 400 y no 401: un 401 cerraria la sesion en el panel.
router.post('/cambiar-password', limiteLogin, verifyToken, async (req, res) => {
    const { actual, nueva } = req.body || {};
    if (typeof actual !== 'string' || actual.length === 0) {
        return res.status(400).json({ error: 'Escribe tu contraseña actual' });
    }
    const v = validarPassword(nueva);
    if (!v.ok) return res.status(400).json({ error: v.error });
    if (actual === nueva) {
        return res.status(400).json({ error: 'La contraseña nueva debe ser distinta de la actual' });
    }
    try {
        const r = await pool.query('SELECT password_hash FROM usuarios WHERE id = $1', [req.user.id]);
        if (r.rows.length === 0 || !(await bcrypt.compare(actual, r.rows[0].password_hash))) {
            return res.status(400).json({ error: 'La contraseña actual no es correcta' });
        }
        const hash = await bcrypt.hash(nueva, 10);
        // la clave nueva y el cierre de las otras sesiones van en UNA sentencia: o ocurren las dos o ninguna
        const u = await pool.query(
            `WITH cambio AS (
                 UPDATE usuarios SET password_hash = $1, password_cambiada_at = now()
                 WHERE id = $2
                 RETURNING id, rol, cliente_id, password_cambiada_at
             ), cerradas AS (
                 UPDATE sesiones SET revocada_at = now(), motivo = 'clave'
                 WHERE usuario_id = $2 AND revocada_at IS NULL AND ($3::bigint IS NULL OR id <> $3::bigint)
                 RETURNING id
             )
             SELECT * FROM cambio`,
            [hash, req.user.id, req.user.sid || null]
        );
        // la sesion actual sigue; las demas de la cuenta se cierran. Un token antiguo (JWT) ya no vale tras
        // el cambio de clave, asi que ese caso recibe una sesion nueva.
        let token;
        if (req.user.sid) {
            token = req.headers.authorization.slice('Bearer '.length);
        } else {
            token = await emitirSesion(u.rows[0], req);
        }
        res.json({ ok: true, token });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'No se pudo cambiar la contraseña' });
    }
});

module.exports = router;
module.exports.emitirToken = emitirToken;
