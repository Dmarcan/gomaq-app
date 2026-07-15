const pool = require('../config/db');

const INTERVALO_MS = 15000;
const MAX_INTENTOS = 5;

// Stub: aun no hay cuenta de WhatsApp Business ni proveedor de correo configurado.
// Cuando existan las credenciales, reemplazar el cuerpo de esta funcion por la
// llamada real a WhatsApp Cloud API (canal='whatsapp') o al servicio de correo (canal='email').
// El resto del patron Outbox (reintentos, backoff, estado de error) no necesita cambiar.
async function enviarNotificacion(notificacion) {
    throw new Error(`Proveedor de ${notificacion.canal} no configurado todavia`);
}

async function procesarPendientes() {
    const { rows } = await pool.query(
        `SELECT * FROM notificaciones_pendientes
         WHERE estado = 'pendiente' AND intentos < $1 AND proximo_intento <= now()
         ORDER BY created_at ASC LIMIT 20`,
        [MAX_INTENTOS]
    );

    for (const notificacion of rows) {
        try {
            await enviarNotificacion(notificacion);
            await pool.query(
                `UPDATE notificaciones_pendientes SET estado = 'enviado', enviado_at = now() WHERE id = $1`,
                [notificacion.id]
            );
            console.log(`[notificaciones] enviado id=${notificacion.id} canal=${notificacion.canal}`);
        } catch (err) {
            const intentos = notificacion.intentos + 1;
            const nuevoEstado = intentos >= MAX_INTENTOS ? 'error' : 'pendiente';
            // backoff exponencial: 30s, 1min, 2min, 4min... (2^intentos * 30s)
            const esperaSegundos = 30 * Math.pow(2, intentos - 1);
            await pool.query(
                `UPDATE notificaciones_pendientes
                 SET intentos = $1, ultimo_error = $2, estado = $3, proximo_intento = now() + ($4 || ' seconds')::interval
                 WHERE id = $5`,
                [intentos, err.message, nuevoEstado, esperaSegundos, notificacion.id]
            );
            console.log(`[notificaciones] fallo id=${notificacion.id} intento=${intentos}/${MAX_INTENTOS} estado=${nuevoEstado} proximo_intento_en=${esperaSegundos}s`);
        }
    }
}

function iniciarWorker() {
    setInterval(() => {
        procesarPendientes().catch((err) => console.error('[notificaciones] error en worker:', err));
    }, INTERVALO_MS);
    console.log(`[notificaciones] worker iniciado, revisando cada ${INTERVALO_MS / 1000}s`);
}

module.exports = { iniciarWorker };
