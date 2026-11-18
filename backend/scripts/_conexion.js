// Conexion de los scripts de operacion: el rol dueño del esquema (DATABASE_URL_MIGRACION) si existe, y si no la de la API.

/** URL de la base para un script, o null si no hay ninguna configurada. */
function urlBaseDeScript() {
    return process.env.DATABASE_URL_MIGRACION || process.env.DATABASE_URL || null;
}

module.exports = { urlBaseDeScript };
