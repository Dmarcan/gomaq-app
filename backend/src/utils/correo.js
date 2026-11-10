// Normalizacion del correo: minusculas y sin espacios alrededor, para que "Ana@X.cl" y "ana@x.cl" sean la misma cuenta.

/** Correo en minusculas y sin espacios. Si no es texto devuelve una cadena vacia. */
function normalizarCorreo(email) {
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

module.exports = { normalizarCorreo };
