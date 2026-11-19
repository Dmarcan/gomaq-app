// Envio de correo por la API HTTP de Resend (https://resend.com/docs/api-reference/emails/send-email).
// Se usa la API y no SMTP porque Railway bloquea SMTP en los planes Hobby y menores.
// La clave (RESEND_API_KEY) nunca se escribe en el repo: va en .env y en las variables de Railway.

const { errorDeResend } = require('../utils/errorResend');

const URL_RESEND = 'https://api.resend.com/emails';

/**
 * @param {object} p
 * @param {string} p.apiKey
 * @param {string} p.desde        remitente, por ejemplo 'GOMAQ <facturas@avisos.dominio.cl>'
 * @param {string} p.para
 * @param {string} p.asunto
 * @param {string} p.texto
 * @param {string} p.html
 * @param {{filename: string, content: string, content_id?: string}[]} [p.adjuntos]   content en base64; con
 *        `content_id` el adjunto es una imagen incrustada que el HTML cita como `cid:<content_id>`
 * @param {string|null} [p.replyTo]   a quien llega la respuesta del cliente (si no, al remitente)
 * @param {string} p.claveIdempotencia   evita un correo doble si el envio se repite (vale 24 h)
 * @param {AbortSignal} p.signal
 * @param {Function} [p.fetchFn]  solo para pruebas
 * @returns {Promise<string|null>} id del correo en Resend
 */
async function enviarCorreoResend({ apiKey, desde, para, asunto, texto, html, adjuntos = [], replyTo = null, claveIdempotencia, signal, fetchFn = fetch }) {
    const cuerpo = { from: desde, to: [para], subject: asunto, text: texto, html };
    if (adjuntos.length > 0) cuerpo.attachments = adjuntos;
    if (replyTo) cuerpo.reply_to = replyTo;
    const respuesta = await fetchFn(URL_RESEND, {
        method: 'POST',
        signal,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': claveIdempotencia,
        },
        body: JSON.stringify(cuerpo),
    });
    if (!respuesta.ok) {
        let detalle = null;
        try { detalle = await respuesta.json(); } catch { /* respuesta sin JSON */ }
        throw errorDeResend({ status: respuesta.status, cuerpo: detalle, headers: respuesta.headers });
    }
    const datos = await respuesta.json().catch(() => ({}));
    return datos.id || null;
}

module.exports = { enviarCorreoResend, URL_RESEND };
