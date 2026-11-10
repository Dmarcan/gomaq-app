// Arma el correo de una factura (HTML y texto plano). Funciones puras, sin red ni base de datos.
// El cuerpo lo escribe o edita el administrativo: es TEXTO y siempre se escapa antes de ir al HTML.

const CONTACTO_POR_DEFECTO = 'xxxx';

function escaparHtml(texto) {
    return String(texto ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function lineaContacto(contacto) {
    return `Este es un envío automático: no responda a este correo. Para consultas, escriba a ${contacto}.`;
}

/**
 * @param {{asunto: string, cuerpo: string, contacto?: string}} datos
 * @returns {{asunto: string, texto: string, html: string}}
 */
function armarCorreoFactura({ asunto, cuerpo, contacto }) {
    const contactoFinal = (typeof contacto === 'string' && contacto.trim()) || CONTACTO_POR_DEFECTO;
    const texto = `${cuerpo}\n\n--\n${lineaContacto(contactoFinal)}`;
    const parrafos = String(cuerpo)
        .split(/\n{2,}/)
        .map((p) => `<p style="margin:0 0 14px 0;">${escaparHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('');
    const html = '<!doctype html><html lang="es"><head><meta charset="utf-8">'
        + `<title>${escaparHtml(asunto)}</title></head>`
        + '<body style="margin:0;padding:24px;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#222;">'
        + '<div style="max-width:600px;margin:0 auto;background:#ffffff;padding:24px;border-radius:6px;font-size:15px;line-height:1.5;">'
        + parrafos
        + '<hr style="border:none;border-top:1px solid #dddddd;margin:20px 0;">'
        + `<p style="margin:0;font-size:13px;color:#555555;">${escaparHtml(lineaContacto(contactoFinal))}</p>`
        + '</div></body></html>';
    return { asunto, texto, html };
}

module.exports = { armarCorreoFactura, escaparHtml, CONTACTO_POR_DEFECTO };
