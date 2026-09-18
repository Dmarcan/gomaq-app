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

// Cuanto tiempo queda "tomada" una notificacion mientras se envia. Si el proceso muere a mitad
// de camino, pasado este plazo otra instancia (o el mismo proceso al reiniciar) la retoma.
const PLAZO_TOMA_SEGUNDOS = 120;

async function procesarPendientes() {
    // Tomar el lote y correr su proximo_intento en una sola sentencia, con SKIP LOCKED: si hay
    // dos instancias del backend (Railway puede levantar otra durante un despliegue, o al
    // escalar), cada una toma filas distintas y ningun aviso sale dos veces. Antes la unica
    // proteccion era un flag en memoria, que no sirve entre procesos.
    const { rows } = await pool.query(
        `UPDATE notificaciones_pendientes
         SET proximo_intento = now() + ($2 || ' seconds')::interval
         WHERE id IN (
             SELECT id FROM notificaciones_pendientes
             WHERE estado = 'pendiente' AND intentos < $1 AND proximo_intento <= now()
             ORDER BY created_at ASC
             LIMIT 20
             FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [MAX_INTENTOS, PLAZO_TOMA_SEGUNDOS]
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
    // guard anti-solapamiento: si un lote tarda mas que el intervalo (envios reales de red
    // cuando exista proveedor), el tick siguiente re-seleccionaria las mismas filas aun
    // 'pendiente' y duplicaria correos/WhatsApps al cliente. Entre procesos distintos lo
    // resuelve la toma con SKIP LOCKED de procesarPendientes; este flag cubre el mismo proceso.
    let enProceso = false;
    setInterval(async () => {
        if (enProceso) return;
        enProceso = true;
        try {
            await procesarPendientes();
        } catch (err) {
            console.error('[notificaciones] error en worker:', err);
        } finally {
            enProceso = false;
        }
    }, INTERVALO_MS);
    console.log(`[notificaciones] worker iniciado, revisando cada ${INTERVALO_MS / 1000}s`);
}

module.exports = { iniciarWorker };
