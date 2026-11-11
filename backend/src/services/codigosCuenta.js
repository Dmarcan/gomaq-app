// Crear y enviar codigos de un solo uso (tabla codigos_cuenta). Lo comparten /api/auth (recuperar y
// canjear) y /api/usuarios (invitar y restablecer). Las reglas puras estan en utils/codigosCuenta.js.
//
// El correo sale directo por Resend y no por notificaciones_pendientes: GET /api/notificaciones le
// muestra el payload al administrativo, y ahi quedaria el codigo a la vista.

const { enviarCorreoResend } = require('./correoResend');
const {
    generarCodigo, hmacCodigo, vigenciaMinutos, textoCodigo, asuntoCodigo, correoDisponible, urlPanel,
} = require('../utils/codigosCuenta');

const TIMEOUT_CORREO_MS = 10000;

/**
 * Genera un codigo nuevo para una cuenta y revoca los vigentes del mismo proposito. Va dentro de la
 * transaccion de quien llama. Devuelve el codigo en claro solo para enviarlo o mostrarlo una vez:
 * la base guarda unicamente su HMAC.
 *
 * Un pedido de "Olvide mi contrasena" (sin creadoPor) solo revoca los anteriores del mismo tipo: si no,
 * cualquiera que conozca el correo de un mecanico podria anular el codigo que le genero la oficina.
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{id:number, codigo:string, expiraAt:Date}>}
 */
async function crearCodigo(client, { proposito, usuarioId = null, solicitudClienteId = null, email, canal, creadoPor = null }) {
    const minutos = vigenciaMinutos(proposito, { generadoPorAdmin: creadoPor !== null });
    const codigo = generarCodigo();
    const hmac = hmacCodigo({ secreto: process.env.JWT_SECRET, proposito, email, codigo });
    await client.query(
        `UPDATE codigos_cuenta SET revocado_at = now()
         WHERE usuario_id IS NOT DISTINCT FROM $1 AND solicitud_cliente_id IS NOT DISTINCT FROM $4
           AND proposito = $2 AND usado_at IS NULL AND revocado_at IS NULL
           AND ($3::boolean OR creado_por IS NULL)`,
        [usuarioId, proposito, creadoPor !== null, solicitudClienteId]
    );
    const r = await client.query(
        `INSERT INTO codigos_cuenta (proposito, usuario_id, solicitud_cliente_id, email, codigo_hmac, expira_at, canal, creado_por)
         VALUES ($1, $2, $8, $3, $4, now() + make_interval(mins => $5), $6, $7)
         RETURNING id, expira_at`,
        [proposito, usuarioId, email, hmac, minutos, canal, creadoPor, solicitudClienteId]
    );
    return { id: r.rows[0].id, codigo, expiraAt: r.rows[0].expira_at };
}

/**
 * Envia el codigo por correo y anota el resultado en la fila. No lanza: devuelve si salio.
 * @returns {Promise<{enviado: boolean, error: string|null}>}
 */
async function enviarCodigoPorCorreo(pool, { id, proposito, email, nombre, codigo, expiraAt }, { fetchFn } = {}) {
    const config = correoDisponible();
    if (!config.disponible) {
        await anotarEnvio(pool, id, config.motivo);
        return { enviado: false, error: config.motivo };
    }
    const texto = textoCodigo({ proposito, nombre, email, codigo, venceAt: expiraAt, url: urlPanel() });
    try {
        await enviarCorreoResend({
            apiKey: process.env.RESEND_API_KEY,
            desde: process.env.CORREO_REMITENTE,
            para: email,
            asunto: asuntoCodigo(proposito),
            texto,
            html: htmlDeTexto(texto),
            claveIdempotencia: `codigo-cuenta-${id}`,
            signal: AbortSignal.timeout(TIMEOUT_CORREO_MS),
            ...(fetchFn ? { fetchFn } : {}),
        });
        await anotarEnvio(pool, id, null);
        return { enviado: true, error: null };
    } catch (err) {
        // el mensaje de Resend no lleva el codigo; se guarda para que el panel muestre por que no salio
        const motivo = String((err && err.message) || 'Error al enviar el correo').slice(0, 300);
        console.error(`No se pudo enviar el código ${id} por correo: ${motivo}`);
        await anotarEnvio(pool, id, motivo);
        return { enviado: false, error: 'No se pudo enviar el correo. Usa "Copiar mensaje" para enviarlo a mano.' };
    }
}

async function anotarEnvio(pool, id, error) {
    try {
        await pool.query(
            error
                ? 'UPDATE codigos_cuenta SET error_envio = $2 WHERE id = $1'
                : 'UPDATE codigos_cuenta SET enviado_at = now(), error_envio = NULL WHERE id = $1',
            error ? [id, error] : [id]
        );
    } catch (err) {
        console.error('No se pudo anotar el envío del código:', err && err.message);
    }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML minimo a partir del texto (el mismo contenido, con saltos de linea). */
function htmlDeTexto(texto) {
    const seguro = texto.replace(/[&<>"']/g, (c) => ESCAPES[c]);
    return `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5">${seguro.replace(/\n/g, '<br>')}</div>`;
}

module.exports = { crearCodigo, enviarCodigoPorCorreo, htmlDeTexto };
