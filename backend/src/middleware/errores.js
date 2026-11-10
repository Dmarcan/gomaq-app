// Manejador de errores final de la API. Responde siempre JSON y nunca filtra el detalle del
// error (trazas, mensajes de Postgres) al cliente: el detalle va solo al log del servidor.

function manejarErrores(err, req, res, next) {
    if (res.headersSent) {
        // la respuesta ya salio: pasarlo a Express cortaria el socket; solo se registra
        console.error(err);
        return;
    }
    // cuerpos JSON mal formados o demasiado grandes (body-parser pone `status` y `type`)
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'El cuerpo de la petición no es un JSON válido' });
    }
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'La petición es demasiado grande' });
    }
    if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({ error: 'Petición no válida' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Error interno del servidor' });
}

// Cualquier /api/* que ningun router resolvio: JSON en español en vez del HTML de Express.
function rutaApiNoEncontrada(req, res) {
    res.status(404).json({ error: 'Ruta no encontrada' });
}

/**
 * Red de seguridad del proceso: una promesa rechazada o una excepcion que se escape de una
 * ruta se registra y una promesa rechazada solo se registra; una excepcion no atrapada se registra y reinicia el proceso.
 * Los handlers asincronos ya van cubiertos por `utils/asyncErrores.js`; esto es el ultimo
 * recurso (por ejemplo un temporizador o un evento del pool).
 */
function registrarRedDeSeguridad(proc = process) {
    proc.on('unhandledRejection', (motivo) => {
        console.error('unhandledRejection:', motivo);
    });
    proc.on('uncaughtException', (err) => {
        // tras una excepcion no atrapada Node no garantiza un estado sano: se registra y se
        // sale para que Railway reinicie el servicio (y espere a /api/health)
        console.error('uncaughtException:', err);
        if (proc.exit) proc.exit(1);
    });
}

module.exports = { manejarErrores, rutaApiNoEncontrada, registrarRedDeSeguridad };
