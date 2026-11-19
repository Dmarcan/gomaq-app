// Arma lo que sale en el correo de una factura: el HTML y los adjuntos (logo incrustado, PDF y fotos). Sin red ni
// base de datos: el worker le pasa lo que ya descargo. Ver plantillaCorreoFactura.js para el diseno.

const fs = require('node:fs');
const path = require('node:path');
const { armarCorreoFactura, resumenDePayload, LOGO_CID } = require('./plantillaCorreoFactura');

const RUTA_LOGO = path.join(__dirname, '..', 'assets', 'correo', 'logo_gomaq.png');
let logoEnMemoria; // undefined = aun no se leyo; null = no se pudo leer

/**
 * El logo como adjunto incrustado de Resend (`content_id`), o null si el archivo no esta: el correo sale igual,
 * con el nombre de la empresa en texto en vez del logo. Se lee una vez por proceso.
 */
function leerLogoCorreo(ruta = RUTA_LOGO) {
    if (ruta === RUTA_LOGO && logoEnMemoria !== undefined) return logoEnMemoria;
    let adjunto = null;
    try {
        adjunto = { filename: 'logo-gomaq.png', content: fs.readFileSync(ruta).toString('base64'), content_id: LOGO_CID };
    } catch (err) {
        console.error('[correo] no se pudo leer el logo, el correo sale sin el:', err.message);
    }
    if (ruta === RUTA_LOGO) logoEnMemoria = adjunto;
    return adjunto;
}

/** Cuantas fotos del antes y del despues van adjuntas, segun el nombre de cada adjunto (antes-1.jpg...). */
function contarFotos(adjuntos) {
    const nombres = (adjuntos || []).map((a) => String(a.filename));
    return {
        antes: nombres.filter((n) => /^antes-\d+\.jpg$/.test(n)).length,
        despues: nombres.filter((n) => /^despues-\d+\.jpg$/.test(n)).length,
    };
}

/**
 * @param {object} p
 * @param {object} p.payload   el aviso `factura_emitida` (asunto, cuerpo, folio, monto, fechas...)
 * @param {{filename:string, content:string}[]} p.pdf
 * @param {{filename:string, content:string}[]} p.fotos
 * @param {{filename:string, content:string, content_id:string}|null} p.logo
 * @param {string} [p.contacto]  CORREO_CONTACTO
 * @returns {{correo: {asunto:string, texto:string, html:string, replyTo:string|null}, adjuntos: object[]}}
 */
function armarEnvioFactura({ payload, pdf, fotos, logo, contacto }) {
    const correo = armarCorreoFactura({
        asunto: payload.asunto,
        cuerpo: payload.cuerpo,
        contacto,
        // el resumen cuenta las fotos que de verdad van adjuntas, no las que se pidieron
        resumen: resumenDePayload(payload, contarFotos(fotos)),
        conLogo: Boolean(logo),
    });
    return { correo, adjuntos: [...(logo ? [logo] : []), ...pdf, ...fotos] };
}

module.exports = { leerLogoCorreo, contarFotos, armarEnvioFactura, RUTA_LOGO };
