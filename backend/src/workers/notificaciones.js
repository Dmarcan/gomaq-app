const pool = require('../config/db');
const { planificarReintento, plazoTomaSegundos, conTimeout } = require('../utils/reintentosNotificacion');

const INTERVALO_MS = 15000;
const MAX_INTENTOS = 5;
// Lote chico y con timeout por envio: los envios salen en serie, y con un proveedor lento un lote
// grande tardaria mas que el plazo de toma, con lo que otra instancia reenviaria las ultimas
// filas. Ajustables con variables de entorno sin tocar codigo.
const LOTE = Math.max(1, Number(process.env.NOTIF_LOTE) || 5);
const TIMEOUT_ENVIO_MS = Math.max(1000, Number(process.env.NOTIF_TIMEOUT_MS) || 15000);
// cada cuanto deja una linea de "sigo vivo" en el log cuando no hay nada que enviar
const LATIDO_MS = 10 * 60 * 1000;

// Stub: aun no hay cuenta de WhatsApp Business ni proveedor de correo configurado.
// Cuando existan las credenciales, reemplazar el cuerpo de esta funcion por la
// llamada real a WhatsApp Cloud API (canal='whatsapp') o al servicio de correo (canal='email').
// Pasar `signal` a fetch para que el timeout corte la llamada. Si el proveedor responde 429,
// lanzar un error con `reintentarEnSegundos` (el Retry-After): se reprograma sin gastar intento.
// El resto del patron Outbox (reintentos, backoff, estado de error) no necesita cambiar.
// Los correos de factura llevan `payload.asunto` y `payload.cuerpo`: el cuerpo es TEXTO PLANO (text/plain).
// Si algun dia se arma un correo HTML con ese texto, hay que escaparlo antes de insertarlo.
async function enviarNotificacion(notificacion, signal) {
    throw new Error(`Proveedor de ${notificacion.canal} no configurado todavia`);
}

// El envio real se puede reemplazar (solo las pruebas lo hacen) para simular un proveedor que responde bien.
let enviar = enviarNotificacion;
function usarEnvio(fn) {
    enviar = fn || enviarNotificacion;
}

// Cuanto tiempo queda "tomada" una notificacion mientras se envia. Si el proceso muere a mitad
// de camino, pasado este plazo otra instancia (o el mismo proceso al reiniciar) la retoma.
const PLAZO_TOMA_SEGUNDOS = plazoTomaSegundos({ lote: LOTE, timeoutMs: TIMEOUT_ENVIO_MS });

// true si la notificacion sigue pendiente y, siendo el correo de una factura, la factura existe.
// Una factura anulada deja la fila 'cancelado' y no se envia.
async function sigueVigente(notificacion) {
    const actual = await pool.query('SELECT estado, payload FROM notificaciones_pendientes WHERE id = $1', [notificacion.id]);
    if (actual.rows.length === 0 || actual.rows[0].estado !== 'pendiente') {
        console.log(`[notificaciones] omitido id=${notificacion.id}: ya no esta pendiente`);
        return false;
    }
    const payload = actual.rows[0].payload || {};
    if (payload.tipo === 'factura_emitida' && payload.factura_id) {
        const factura = await pool.query('SELECT 1 FROM facturas WHERE id = $1', [payload.factura_id]);
        if (factura.rows.length === 0) {
            await pool.query(
                `UPDATE notificaciones_pendientes SET estado = 'cancelado', ultimo_error = 'Factura anulada'
                 WHERE id = $1 AND estado = 'pendiente'`,
                [notificacion.id]
            );
            console.log(`[notificaciones] cancelado id=${notificacion.id}: la factura ya no existe`);
            return false;
        }
    }
    return true;
}

// Envia una notificacion ya tomada y deja su estado. Separada del lote para poder probarla.
async function procesarUna(notificacion) {
    // Justo antes de enviar se vuelve a mirar la fila: otra transaccion pudo cancelarla (factura
    // anulada) o cambiarle el estado despues de que este lote la tomo. Queda una ventana de
    // milisegundos entre esta revision y la llamada al proveedor: se acepta, cerrarla obligaria a
    // bloquear la fila durante todo el envio (hasta TIMEOUT_ENVIO_MS).
    if (!(await sigueVigente(notificacion))) return;
    try {
        await conTimeout((signal) => enviar(notificacion, signal), TIMEOUT_ENVIO_MS);
        const marcada = await pool.query(
            `UPDATE notificaciones_pendientes SET estado = 'enviado', enviado_at = now() WHERE id = $1 AND estado = 'pendiente'`,
            [notificacion.id]
        );
        if (marcada.rowCount === 0) {
            // Contrato: la anulacion puede cancelar la fila entre la revision de sigueVigente y la respuesta
            // del proveedor (ventana aceptada). Si el correo ya salio, la fila queda 'cancelado' pero deja
            // constancia de que se envio, para que quien la revise no crea que no llego.
            await pool.query(
                `UPDATE notificaciones_pendientes
                 SET ultimo_error = 'Enviado antes de que la anulación lo alcanzara', enviado_at = now()
                 WHERE id = $1 AND estado = 'cancelado'`,
                [notificacion.id]
            );
            console.log(`[notificaciones] enviado id=${notificacion.id} pero la fila ya estaba cancelada (la anulacion llego despues del envio)`);
        } else {
            console.log(`[notificaciones] enviado id=${notificacion.id} canal=${notificacion.canal}`);
        }
    } catch (err) {
        const plan = planificarReintento({ intentos: notificacion.intentos, maxIntentos: MAX_INTENTOS, error: err });
        await pool.query(
            `UPDATE notificaciones_pendientes
             SET intentos = $1, ultimo_error = $2, estado = $3, proximo_intento = now() + ($4 || ' seconds')::interval
             WHERE id = $5 AND estado = 'pendiente'`,
            [plan.intentos, err.message, plan.estado, plan.esperaSegundos, notificacion.id]
        );
        console.log(`[notificaciones] fallo id=${notificacion.id} intento=${plan.intentos}/${MAX_INTENTOS} estado=${plan.estado} proximo_intento_en=${plan.esperaSegundos}s`);
    }
}

// Devuelve cuantas notificaciones tomo (0 si no habia nada).
async function procesarPendientes() {
    // Tomar el lote y correr su proximo_intento en una sola sentencia, con SKIP LOCKED: si hay
    // dos procesos (la API y el worker, o dos despliegues superpuestos), cada uno toma filas
    // distintas y ningun aviso sale dos veces. Antes la unica proteccion era un flag en
    // memoria, que no sirve entre procesos.
    const { rows } = await pool.query(
        `UPDATE notificaciones_pendientes
         SET proximo_intento = now() + ($2 || ' seconds')::interval
         WHERE id IN (
             SELECT id FROM notificaciones_pendientes
             WHERE estado = 'pendiente' AND intentos < $1 AND proximo_intento <= now()
             ORDER BY created_at ASC
             LIMIT $3
             FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [MAX_INTENTOS, PLAZO_TOMA_SEGUNDOS, LOTE]
    );
    if (rows.length === 0) return 0;

    const inicio = Date.now();
    for (const notificacion of rows) {
        await procesarUna(notificacion);
    }
    console.log(`[notificaciones] lote de ${rows.length} procesado en ${Date.now() - inicio} ms`);
    return rows.length;
}

// Arranca el worker y devuelve `detener()`: deja de programar lotes y espera a que termine el
// que esta en curso, para poder cerrar el pool sin cortar un envio a medias.
function iniciarWorker() {
    // guard anti-solapamiento: si un lote tarda mas que el intervalo (envios reales de red
    // cuando exista proveedor), el tick siguiente re-seleccionaria las mismas filas aun
    // 'pendiente' y duplicaria correos/WhatsApps al cliente. Entre procesos distintos lo
    // resuelve la toma con SKIP LOCKED de procesarPendientes; este flag cubre el mismo proceso.
    let enProceso = null;
    let detenido = false;
    let ultimoLatido = Date.now();

    async function tick() {
        if (enProceso || detenido) return;
        enProceso = (async () => {
            try {
                // si el lote vino lleno probablemente hay mas esperando: seguir sin esperar el intervalo
                while (!detenido && (await procesarPendientes()) === LOTE) { /* siguiente lote */ }
            } catch (err) {
                console.error('[notificaciones] error en worker:', err);
            } finally {
                enProceso = null;
            }
        })();
        await enProceso;
        if (Date.now() - ultimoLatido >= LATIDO_MS) {
            ultimoLatido = Date.now();
            console.log('[notificaciones] worker activo, sin pendientes por ahora');
        }
    }

    const intervalo = setInterval(tick, INTERVALO_MS);
    console.log(`[notificaciones] worker iniciado, revisando cada ${INTERVALO_MS / 1000}s (lote ${LOTE}, timeout de envio ${TIMEOUT_ENVIO_MS} ms)`);

    return async function detener() {
        detenido = true;
        clearInterval(intervalo);
        if (enProceso) await enProceso;
        console.log('[notificaciones] worker detenido');
    };
}

module.exports = { iniciarWorker, sigueVigente, procesarUna, usarEnvio };
