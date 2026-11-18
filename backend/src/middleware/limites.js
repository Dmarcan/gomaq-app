const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// Limites de peticiones para los endpoints publicos (sin token).
//
// El sistema se expone a internet por el tunel de Cloudflare: sin limite, /login aceptaria intentos
// ilimitados de contraseña y /registro-cliente permitiria llenar la tabla de solicitudes desde afuera.
//
// Se cuenta por la IP real de quien se conecta (ver ipDelCliente): detras del tunel TODAS las peticiones
// llegan desde cloudflared en el mismo equipo (127.0.0.1), y con un solo contador diez contraseñas
// equivocadas de cualquiera dejarian a todos sin poder entrar por 15 minutos.

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * IP real del cliente.
 *
 * - Tunel de Cloudflare: cloudflared corre en el mismo equipo y entrega la IP original en
 *   `CF-Connecting-IP`. Solo se le cree si la conexion viene de loopback: desde afuera,
 *   cualquiera podria mandar esa cabecera inventada para saltarse el limite.
 * - Detras de otro proxy (Railway, por ejemplo): `req.ip`, que Express calcula desde
 *   `X-Forwarded-For` segun el `trust proxy` configurado en server.js (variable TRUST_PROXY).
 */
function ipDelCliente(req) {
    const directa = req.socket ? req.socket.remoteAddress : undefined;
    const cloudflare = req.headers ? req.headers['cf-connecting-ip'] : undefined;
    if (cloudflare && LOOPBACK.has(directa)) return String(cloudflare).trim();
    return req.ip || directa || 'desconocida';
}

// ipKeyGenerator agrupa las IPv6 por su prefijo /56: si no, cada direccion de un mismo cliente
// IPv6 tendria su propio contador y el limite no serviria
const clavePorCliente = (req) => ipKeyGenerator(ipDelCliente(req));

/** Login: suficiente para que una persona se equivoque varias veces, no para probar un diccionario. */
const limiteLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    // solo cuentan los intentos fallidos: quien entra bien no gasta cuota
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clavePorCliente,
    message: { error: 'Demasiados intentos fallidos. Espera unos minutos y vuelve a intentarlo.' },
});

/** Registro publico: una empresa se inscribe una vez, no cinco veces por hora. */
const limiteRegistro = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clavePorCliente,
    message: { error: 'Demasiadas solicitudes de cuenta desde esta conexión. Intenta más tarde.' },
});

/**
 * "Olvide mi contrasena": siempre responde lo mismo, asi que cuenta cada pedido. Ademas la ruta limita
 * por correo, para que nadie llene de correos la bandeja de otra persona.
 */
const limiteRecuperar = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clavePorCliente,
    message: { error: 'Demasiados pedidos de código desde esta conexión. Espera unos minutos.' },
});

/** Canje de un codigo: cada codigo aguanta 5 intentos; esto frena a quien prueba muchos correos. */
const limiteCodigo = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: clavePorCliente,
    message: { error: 'Demasiados intentos fallidos. Espera unos minutos y vuelve a intentarlo.' },
});

module.exports = { limiteLogin, limiteRegistro, limiteRecuperar, limiteCodigo, ipDelCliente };
