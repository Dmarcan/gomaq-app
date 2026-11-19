// Arma el correo "tu cuenta fue aprobada" que recibe el cliente cuando el administrativo o el gerente aprueba su
// solicitud. Sin red ni base de datos: el worker le pasa el aviso encolado y el logo ya leido.
// Usa el mismo diseno de marca que el correo de factura. No lleva datos internos: solo el nombre de contacto y el
// enlace al panel (que el servidor de la API pone en el aviso al encolarlo, porque el worker no conoce la URL).

const { armarCorreoMarca } = require('./plantillaCorreoFactura');

const ASUNTO_CUENTA_APROBADA = 'Tu cuenta de GOMAQ fue aprobada';

/**
 * @param {{payload: {nombre_contacto?: string, url?: string}, logo?: object|null, contacto?: string}} p
 * @returns {{correo: {asunto:string, texto:string, html:string, replyTo:string|null}, adjuntos: object[]}}
 */
function armarCorreoCuentaAprobada({ payload, logo, contacto }) {
    const p = payload || {};
    const nombre = String(p.nombre_contacto || '').trim();
    const saludo = nombre ? `Hola ${nombre},` : 'Hola,';
    const cuerpo = `${saludo}\n\n`
        + 'Tu solicitud de cuenta en GOMAQ fue aprobada. Ya puedes iniciar sesión con el correo y la contraseña que elegiste al registrarte.\n\n'
        + 'Desde tu cuenta puedes ver tus equipos, pedir asistencia y seguir tus órdenes de trabajo.';
    const correo = armarCorreoMarca({
        asunto: ASUNTO_CUENTA_APROBADA,
        cuerpo,
        contacto,
        enlace: p.url ? { texto: 'Iniciar sesión', url: p.url } : undefined,
        conLogo: Boolean(logo),
    });
    return { correo, adjuntos: logo ? [logo] : [] };
}

module.exports = { armarCorreoCuentaAprobada, ASUNTO_CUENTA_APROBADA };
