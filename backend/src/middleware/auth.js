const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { esTokenDeSesion, hashToken, estadoSesion, REFRESCO_USO_MINUTOS } = require('../utils/sesiones');

// Hay dos clases de token. El login entrega un token opaco ("gs1_...") cuyo hash vive en la tabla
// sesiones (migracion 036): se puede revocar y vence por tiempo absoluto o por inactividad. Los JWT
// firmados de 12 h que ya estan en los telefonos y navegadores siguen valiendo hasta que venzan.
//
// En ambos casos la firma o el token solos no bastan: un usuario dado de baja o con el rol cambiado
// seguiria operando. Por eso cada peticion revisa en la base (una consulta por clave primaria) que la
// cuenta siga activa y toma de ahi el rol y el cliente.
//
// Un 401 NO borra la cola de sincronizacion de la app del mecanico: solo muestra "tu sesion expiro"
// y conserva lo pendiente en el telefono. Si la base no responde se contesta 503 y no 401, para que
// una caida de Postgres no cierre la sesion de nadie.

async function buscarEnBase(id) {
    const r = await pool.query(
        'SELECT rol, cliente_id, estado_cuenta, password_cambiada_at FROM usuarios WHERE id = $1',
        [id]
    );
    return r.rows[0] || null;
}

let buscarUsuario = buscarEnBase;

async function buscarSesion(hash) {
    const r = await pool.query(
        `SELECT s.id, s.usuario_id, s.expira_at, s.ultimo_uso_at, s.inactividad_min, s.revocada_at,
                u.rol, u.cliente_id, u.estado_cuenta
         FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
         WHERE s.token_hash = $1`,
        [hash]
    );
    return r.rows[0] || null;
}

/** Valida un token de sesion guardado en la base. Una sola consulta (sesion y cuenta juntas). */
async function verificarSesion(token, req, res, next) {
    let fila;
    try {
        fila = await buscarSesion(hashToken(token));
    } catch (err) {
        console.error('No se pudo verificar la sesión:', err && err.message);
        return res.status(503).json({ error: 'No se pudo verificar tu sesión. Reintenta en un momento' });
    }
    if (!fila || estadoSesion(fila) !== 'ok') {
        return res.status(401).json({ error: 'Tu sesión expiró. Vuelve a iniciar sesión' });
    }
    if (fila.estado_cuenta !== 'activo') {
        return res.status(401).json({ error: 'Tu cuenta no está activa. Vuelve a iniciar sesión o contacta a GOMAQ' });
    }
    // marca de uso, como maximo cada pocos minutos y sin esperar el resultado
    pool.query(
        `UPDATE sesiones SET ultimo_uso_at = now()
         WHERE id = $1 AND ultimo_uso_at < now() - make_interval(mins => $2)`,
        [fila.id, REFRESCO_USO_MINUTOS]
    ).catch(() => {});
    req.user = { id: fila.usuario_id, rol: fila.rol, cliente_id: fila.cliente_id ?? null, sid: fila.id };
    return next();
}

/**
 * Cambia como se busca al usuario. Solo para pruebas que montan rutas sin base de datos o con
 * tokens de usuarios que no existen; devuelve una funcion que restaura el comportamiento real.
 * @param {(id:number, claims:object) => Promise<{rol:string, cliente_id:number|null, estado_cuenta:string}|null>} [fn]
 */
function usarBuscadorDeUsuarios(fn) {
    const previo = buscarUsuario;
    buscarUsuario = fn || buscarEnBase;
    return () => { buscarUsuario = previo; };
}

async function verifyToken(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Debes iniciar sesión' });
    }
    const token = header.slice('Bearer '.length);
    if (esTokenDeSesion(token)) return verificarSesion(token, req, res, next);
    let claims;
    try {
        claims = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        return res.status(401).json({ error: 'Tu sesión expiró. Vuelve a iniciar sesión' });
    }
    if (!claims || !Number.isInteger(claims.id)) {
        return res.status(401).json({ error: 'Tu sesión expiró. Vuelve a iniciar sesión' });
    }

    let usuario;
    try {
        usuario = await buscarUsuario(claims.id, claims);
    } catch (err) {
        console.error('No se pudo verificar la sesión:', err && err.message);
        return res.status(503).json({ error: 'No se pudo verificar tu sesión. Reintenta en un momento' });
    }
    if (!usuario || usuario.estado_cuenta !== 'activo') {
        return res.status(401).json({ error: 'Tu cuenta no está activa. Vuelve a iniciar sesión o contacta a GOMAQ' });
    }

    // el token lleva (claim `pc`) la hora del ultimo cambio de contrasena que habia al emitirse, en
    // milisegundos (0 si nunca se cambio). Si hoy es otra, la contrasena se cambio despues y esa sesion
    // ya no vale. Compararlo asi, y no con `iat` (que va en segundos), no deja ninguna ventana: un token
    // emitido en el mismo segundo del cambio, antes o despues, se distingue igual.
    const cambioActual = usuario.password_cambiada_at ? new Date(usuario.password_cambiada_at).getTime() : 0;
    if (cambioActual !== (Number.isFinite(claims.pc) ? claims.pc : 0)) {
        return res.status(401).json({ error: 'Tu contraseña cambió. Vuelve a iniciar sesión' });
    }

    // rol y cliente salen de la base, no del token: un cambio de rol o de empresa rige de inmediato
    req.user = { ...claims, rol: usuario.rol, cliente_id: usuario.cliente_id ?? null };
    next();
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.rol)) {
            return res.status(403).json({ error: 'No tienes permiso para esta acción' });
        }
        next();
    };
}

module.exports = { verifyToken, requireRole, usarBuscadorDeUsuarios };
