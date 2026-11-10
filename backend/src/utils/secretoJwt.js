// Validacion del secreto con que se firman las sesiones (JWT_SECRET). Regla pura: el servidor la
// llama al arrancar (server.js) y no inicia si el secreto es debil.
//
// Un secreto corto o copiado del ejemplo se puede adivinar por fuerza bruta a partir de un token
// capturado, o simplemente usar tal cual: quien lo tenga puede firmar un token de gerente. Solo se
// exige en produccion; en desarrollo y en el CI se aceptan secretos de prueba.

const MIN_LARGO = 32;
// valores de ejemplo o de prueba que no deben llegar a produccion
const PREFIJOS_DE_EJEMPLO = ['changeme', 'secreto-solo-para', 'cambiar', 'tu-secreto', 'your-secret', 'secret', 'password'];

/**
 * @param {string|undefined} secreto valor de JWT_SECRET
 * @param {string|undefined} entorno valor de NODE_ENV
 * @returns {{ok: true} | {ok: false, motivo: string}}
 */
function validarSecretoJwt(secreto, entorno) {
    if (entorno !== 'production') return { ok: true };
    if (typeof secreto !== 'string' || secreto.trim() === '') {
        return { ok: false, motivo: 'esta vacio' };
    }
    const normalizado = secreto.trim().toLowerCase();
    if (PREFIJOS_DE_EJEMPLO.some((p) => normalizado.startsWith(p))) {
        return { ok: false, motivo: 'parece un valor de ejemplo' };
    }
    if (secreto.length < MIN_LARGO) {
        return { ok: false, motivo: `tiene ${secreto.length} caracteres y se piden al menos ${MIN_LARGO}` };
    }
    // todo el mismo caracter (por ejemplo "aaaa...") cumple el largo pero no es un secreto
    if (new Set(secreto).size < 8) {
        return { ok: false, motivo: 'tiene muy pocos caracteres distintos' };
    }
    return { ok: true };
}

module.exports = { MIN_LARGO, validarSecretoJwt };
