const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// La sesion es un token firmado (12 h), pero la firma sola no basta: un usuario dado de baja o con
// el rol cambiado seguiria operando hasta que venza. Por eso cada peticion revisa en la base que la
// cuenta siga activa y toma de ahi el rol y el cliente (lo firmado en el token es solo el id).
//
// Costo: una consulta por clave primaria por peticion.
//
// Un 401 NO borra la cola de sincronizacion de la app del mecanico: solo muestra "tu sesion expiro"
// y conserva lo pendiente en el telefono. Si la base no responde se contesta 503 y no 401, para que
// una caida de Postgres no cierre la sesion de nadie.

async function buscarEnBase(id) {
    const r = await pool.query('SELECT rol, cliente_id, estado_cuenta FROM usuarios WHERE id = $1', [id]);
    return r.rows[0] || null;
}

let buscarUsuario = buscarEnBase;

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
