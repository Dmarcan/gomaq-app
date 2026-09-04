const rateLimit = require('express-rate-limit');

// Limites de peticiones para los dos endpoints publicos (sin token).
//
// Hallazgo de la auditoria: no habia ninguno. El sistema se expone a internet por el tunel de
// Cloudflare, asi que /login aceptaba intentos ilimitados de contraseña y /registro-cliente
// permitia llenar la tabla de solicitudes desde afuera.

/** Login: suficiente para que una persona se equivoque varias veces, no para probar un diccionario. */
const limiteLogin = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    // solo cuentan los intentos fallidos: quien entra bien no gasta cuota
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Demasiados intentos fallidos. Espera unos minutos y vuelve a intentarlo.' },
});

/** Registro publico: una empresa se inscribe una vez, no cinco veces por hora. */
const limiteRegistro = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes de registro desde esta conexion. Intenta mas tarde.' },
});

module.exports = { limiteLogin, limiteRegistro };
