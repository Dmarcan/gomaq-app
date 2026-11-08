// Express 4 no captura el rechazo de un handler `async`: sin esto, una excepcion dentro de una
// ruta (un cuerpo mal tipado, un `ROLLBACK` sobre una conexion caida) queda como
// `unhandledRejection` y Node 22 termina el proceso. Aca se parchea el `Layer` de Express una
// sola vez para que el error de un handler asincrono vaya a `next(err)`, es decir, al manejador
// de errores final (`middleware/errores.js`).
//
// Se carga desde cada archivo de rutas (y desde server.js) para que tambien valga cuando los
// tests montan las rutas sin pasar por server.js. Cargarlo varias veces no hace nada.

const Layer = require('express/lib/router/layer');

if (!Layer.prototype.__gomaqAsync) {
    const original = Layer.prototype.handle_request;
    Layer.prototype.handle_request = function handleRequest(req, res, next) {
        const fn = this.handle;
        // los manejadores de error (4 argumentos) los llama `handle_error`; los que no son
        // funciones o tienen una aridad ajena se dejan al comportamiento original
        if (typeof fn !== 'function' || fn.length > 3) return original.call(this, req, res, next);
        try {
            const resultado = fn(req, res, next);
            if (resultado && typeof resultado.catch === 'function') resultado.catch(next);
        } catch (err) {
            next(err);
        }
    };
    Layer.prototype.__gomaqAsync = true;
}

module.exports = {};
