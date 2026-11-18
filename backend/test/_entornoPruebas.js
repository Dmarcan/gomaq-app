// Guarda de entorno para las pruebas con base de datos: ninguna prueba debe escribir, migrar ni
// iniciar sesion fuera de una base local (o del CI), ni llamar a servicios externos reales.
//
// Uso: llamar a exigirBaseLocal() al comienzo del `before` de cada archivo que use la base,
// despues de cargar dotenv. Si la base no es local, lanza un error y la prueba FALLA (no se omite).
// Para una base temporal en otro host (por ejemplo una base de revision), declarar ese host en
// GOMAQ_TEST_HOST_PERMITIDO.
require('dotenv').config();

const HOSTS_LOCALES = ['localhost', '127.0.0.1', '::1'];

/** Host de una URL de conexion, o null si no hay valor. Una URL ilegible se trata como no local. */
function hostDe(valor) {
    if (!valor) return null;
    try {
        // los corchetes de IPv6 ([::1]) se quitan para comparar
        return new URL(valor).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch {
        return '(url ilegible)';
    }
}

function exigirBaseLocal() {
    const permitido = (process.env.GOMAQ_TEST_HOST_PERMITIDO || '').trim().toLowerCase();
    const validos = permitido ? [...HOSTS_LOCALES, permitido] : HOSTS_LOCALES;
    for (const variable of ['DATABASE_URL', 'DATABASE_URL_MIGRACION']) {
        const host = hostDe(process.env[variable]);
        if (host !== null && !validos.includes(host)) {
            throw new Error(
                `Las pruebas con base solo corren contra una base local: ${variable} apunta a "${host}". ` +
                'Use localhost o declare el host en GOMAQ_TEST_HOST_PERMITIDO.');
        }
    }
    // nunca se llama a los servicios externos reales desde las pruebas
    delete process.env.ORS_API_KEY;
    delete process.env.RESEND_API_KEY;
}

module.exports = { exigirBaseLocal };
