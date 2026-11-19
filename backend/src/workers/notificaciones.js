const pool = require('../config/db');
const { planificarReintento, plazoTomaSegundos, conTimeout } = require('../utils/reintentosNotificacion');
const { armarEnvioFactura, leerLogoCorreo } = require('../utils/envioFactura');
const { enviarCorreoResend } = require('../services/correoResend');
const { enviarPushFcm, leerCuentaServicio } = require('../services/fcm');
const { armarMensajePush, motivoDescarte } = require('../utils/push');
const { SQL_OT_SIN_ASIGNAR } = require('../utils/ordenes');
const { prepararAdjuntosFotos, descargadorDeBucket, formatearMb, MAX_BYTES_FOTOS } = require('../utils/fotosCorreo');

const INTERVALO_MS = 15000;
const MAX_INTENTOS = 5;
// Lote chico y con timeout por envio: los envios salen en serie, y con un proveedor lento un lote
// grande tardaria mas que el plazo de toma, con lo que otra instancia reenviaria las ultimas
// filas. Ajustables con variables de entorno sin tocar codigo.
const LOTE = Math.max(1, Number(process.env.NOTIF_LOTE) || 5);
const TIMEOUT_ENVIO_MS = Math.max(1000, Number(process.env.NOTIF_TIMEOUT_MS) || 15000);
// cada cuanto deja una linea de "sigo vivo" en el log cuando no hay nada que enviar
const LATIDO_MS = 10 * 60 * 1000;

// Envio real. Hay proveedor para el correo de factura (Resend, por API HTTP) y para el push por FCM de los tipos
// de utils/push.js (mecanico, gerencia, administrativo y cliente). WhatsApp no tiene proveedor ni plantilla: un
// tipo sin plantilla falla como error permanente, no manda un mensaje vacio.
// Push: FCM_CUENTA_SERVICIO (JSON de la cuenta de servicio en base64) solo en este servicio.
// Configuracion: RESEND_API_KEY, CORREO_REMITENTE (en pruebas 'onboarding@resend.dev', que solo entrega
// a la cuenta dueña de la clave) y CORREO_CONTACTO (correo al que escriben los clientes; el correo pide
// no responder al remitente).
function errorConfiguracion(mensaje) {
    // sin clave el problema no es de la fila: se espera sin gastar intentos
    return Object.assign(new Error(mensaje), { reintentarEnSegundos: 3600 });
}

async function adjuntarPdfFactura(facturaId, signal) {
    if (!facturaId) throw Object.assign(new Error('El aviso no indica la factura'), { permanente: true });
    const fila = await pool.query('SELECT folio, archivo_url FROM facturas WHERE id = $1', [facturaId]);
    if (fila.rows.length === 0 || !fila.rows[0].archivo_url) {
        throw Object.assign(new Error('La factura no tiene archivo para adjuntar'), { permanente: true });
    }
    // se carga aqui y no arriba: config/supabase.js exige SUPABASE_URL y SUPABASE_SERVICE_KEY al cargarse
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        throw errorConfiguracion('Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY en el worker para adjuntar el PDF');
    }
    const { supabase, BUCKET_DOCUMENTOS } = require('../config/supabase');
    const { data, error } = await supabase.storage.from(BUCKET_DOCUMENTOS).download(fila.rows[0].archivo_url);
    if (signal && signal.aborted) throw new Error('Envio cancelado por timeout');
    if (error || !data) throw new Error(`No se pudo leer el PDF de la factura: ${error ? error.message : 'sin datos'}`);
    const bytes = Buffer.from(await data.arrayBuffer());
    const nombre = String(fila.rows[0].folio || facturaId).replace(/[^\w.-]+/g, '_');
    return [{ filename: `factura-${nombre}.pdf`, content: bytes.toString('base64') }];
}

/**
 * Fotos del antes y el despues que el administrativo eligio para el correo (`payload.foto_ids`). Se leen de la
 * orden de la factura (una foto de otra orden no se adjunta jamas) y se reducen con el mismo procedimiento con que
 * la API midio el peso. Una foto que ya no existe se omite y se informa; que no quepan en el tope o que falte la
 * configuracion es un error del envio. `deps` solo se reemplaza en pruebas.
 */
async function adjuntarFotosFactura(payload, signal, deps = {}) {
    const ids = Array.isArray(payload.foto_ids) ? payload.foto_ids : [];
    if (ids.length === 0) return { adjuntos: [], faltantes: [] };
    if (!payload.orden_trabajo_id) {
        throw Object.assign(new Error('El correo pide fotos pero la factura no tiene orden de trabajo'), { permanente: true });
    }
    const filas = await pool.query(
        `SELECT id, tipo, path FROM evidencias_fotograficas
         WHERE orden_trabajo_id = $1 AND id = ANY($2::int[])
         ORDER BY (tipo = 'despues'), created_at, id`,
        [payload.orden_trabajo_id, ids]
    );
    const existentes = new Set(filas.rows.map((f) => f.id));
    const sinFila = ids.filter((id) => !existentes.has(id));
    let descargar = deps.descargar;
    if (!descargar) {
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
            throw errorConfiguracion('Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY en el worker para adjuntar las fotos');
        }
        const { supabase, BUCKET } = require('../config/supabase');
        descargar = descargadorDeBucket(supabase, BUCKET, signal);
    }
    const r = await prepararAdjuntosFotos({ fotos: filas.rows, descargar, ...(deps.reducir ? { reducir: deps.reducir } : {}) });
    if (r.excede) {
        throw Object.assign(
            new Error(`Las fotos pesan ${formatearMb(r.total)} ya reducidas y el maximo es ${formatearMb(MAX_BYTES_FOTOS)}`),
            { permanente: true }
        );
    }
    return { adjuntos: r.adjuntos.map(({ filename, content }) => ({ filename, content })), faltantes: [...sinFila, ...r.faltantes] };
}

/**
 * Push a un dispositivo (`destinatario` = id del dispositivo). El mensaje sale de la lista blanca de
 * utils/push.js, nunca del payload completo. Los errores de FCM traen `descartar`, `reintentarEnSegundos` o
 * `permanente` (ver services/fcm.js). `deps` solo se reemplaza en pruebas.
 */
async function enviarPush(notificacion, signal, deps = {}) {
    const mensaje = armarMensajePush(notificacion.payload);
    if (!mensaje) {
        throw Object.assign(new Error(`Sin plantilla push para ${(notificacion.payload || {}).tipo}`), { permanente: true });
    }
    const dispositivoId = Number(notificacion.destinatario);
    if (!Number.isInteger(dispositivoId)) {
        throw Object.assign(new Error('El aviso no indica un dispositivo valido'), { permanente: true });
    }
    const fila = await pool.query('SELECT token FROM dispositivos_push WHERE id = $1 AND activo', [dispositivoId]);
    if (fila.rows.length === 0) {
        throw Object.assign(new Error('El dispositivo ya no esta activo'), { permanente: true });
    }
    const cuenta = (deps.leerCuenta || leerCuentaServicio)();
    await (deps.enviarFcm || enviarPushFcm)({ cuenta, token: fila.rows[0].token, mensaje, signal });
}

async function enviarNotificacion(notificacion, signal) {
    const payload = notificacion.payload || {};
    if (notificacion.canal === 'push') return enviarPush(notificacion, signal);
    if (notificacion.canal !== 'email') {
        // sin proveedor: reintentar no lo arregla, queda en 'error' (el panel permite reenviarlo despues)
        throw Object.assign(new Error(`Proveedor de ${notificacion.canal} no configurado todavia`), { permanente: true });
    }
    if (payload.tipo !== 'factura_emitida') {
        throw Object.assign(new Error(`Sin plantilla para ${payload.tipo}`), { permanente: true });
    }
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) throw errorConfiguracion('Falta RESEND_API_KEY en el worker');

    const pdf = await adjuntarPdfFactura(payload.factura_id, signal);
    const fotos = await adjuntarFotosFactura(payload, signal);
    // el HTML se arma despues de adjuntar: el resumen cuenta las fotos que de verdad van
    const { correo, adjuntos } = armarEnvioFactura({
        payload, pdf, fotos: fotos.adjuntos, logo: leerLogoCorreo(), contacto: process.env.CORREO_CONTACTO,
    });
    await enviarCorreoResend({
        apiKey,
        desde: process.env.CORREO_REMITENTE || 'onboarding@resend.dev',
        para: notificacion.destinatario,
        asunto: correo.asunto,
        texto: correo.texto,
        html: correo.html,
        adjuntos,
        replyTo: correo.replyTo,
        claveIdempotencia: `gomaq-notif-${notificacion.id}`,
        signal,
    });
    // el correo salio, pero sin alguna foto elegida (ya no existe): queda anotado en Notificaciones
    if (fotos.faltantes.length > 0) {
        return { nota: `Enviado sin ${fotos.faltantes.length} foto(s) que ya no existen (ids ${fotos.faltantes.join(', ')})` };
    }
    return undefined;
}

// El envio real se puede reemplazar (solo las pruebas lo hacen) para simular un proveedor que responde bien.
let enviar = enviarNotificacion;
function usarEnvio(fn) {
    enviar = fn || enviarNotificacion;
}

// Cuanto tiempo queda "tomada" una notificacion mientras se envia. Si el proceso muere a mitad
// de camino, pasado este plazo otra instancia (o el mismo proceso al reiniciar) la retoma.
// Un correo con fotos descarga y reduce imagenes antes de enviar: tiene un plazo mas largo que el resto.
const TIMEOUT_CON_FOTOS_MS = Math.max(TIMEOUT_ENVIO_MS, Number(process.env.NOTIF_TIMEOUT_FOTOS_MS) || 60000);
const PLAZO_TOMA_SEGUNDOS = plazoTomaSegundos({ lote: LOTE, timeoutMs: TIMEOUT_CON_FOTOS_MS });

function plazoDeEnvio(notificacion) {
    const payload = notificacion.payload || {};
    return notificacion.canal === 'email' && Array.isArray(payload.foto_ids) && payload.foto_ids.length > 0
        ? TIMEOUT_CON_FOTOS_MS
        : TIMEOUT_ENVIO_MS;
}

// Mira el dispositivo (activo, app), su dueno (cuenta activa, rol, empresa), su sesion y (ot_disponible) la OT, y
// deja la decision a utils/push.js: un tipo solo va a la app y a los roles de su destino (DESTINOS_PUSH), asi un
// telefono de terreno no recibe avisos de gerencia ni del cliente, y el panel no recibe los del mecanico.
// Devuelve el motivo para cancelar el aviso o null si sigue vigente.
async function motivoDescartePush(fila, payload) {
    const id = Number(fila.destinatario);
    let dispositivo = null;
    if (Number.isInteger(id)) {
        const r = await pool.query(
            `SELECT d.activo, d.app, d.usuario_id, d.sesion_id, u.rol::text AS rol, u.cliente_id, u.estado_cuenta, s.revocada_at AS sesion_revocada_at, s.expira_at AS sesion_expira_at
             FROM dispositivos_push d
             JOIN usuarios u ON u.id = d.usuario_id
             LEFT JOIN sesiones s ON s.id = d.sesion_id
             WHERE d.id = $1`,
            [id]
        );
        dispositivo = r.rows[0] || null;
    }
    let otSinAsignar = true;
    if (payload.tipo === 'ot_disponible') {
        const ot = await pool.query(`SELECT 1 FROM ordenes_trabajo ot WHERE ot.id = $1 AND ${SQL_OT_SIN_ASIGNAR}`, [Number(payload.orden_trabajo_id) || 0]);
        otSinAsignar = ot.rows.length > 0;
    }
    return motivoDescarte({
        aviso: { tipo: payload.tipo, usuario_id: payload.usuario_id, cliente_id: payload.cliente_id, created_at: fila.created_at },
        dispositivo,
        otSinAsignar,
    });
}

// true si la notificacion sigue pendiente y, siendo el correo de una factura, la factura existe.
// Una factura anulada deja la fila 'cancelado' y no se envia.
async function sigueVigente(notificacion) {
    const actual = await pool.query('SELECT estado, payload, canal, destinatario, created_at FROM notificaciones_pendientes WHERE id = $1', [notificacion.id]);
    if (actual.rows.length === 0 || actual.rows[0].estado !== 'pendiente') {
        console.log(`[notificaciones] omitido id=${notificacion.id}: ya no esta pendiente`);
        return false;
    }
    const payload = actual.rows[0].payload || {};
    if (actual.rows[0].canal === 'push') {
        const motivo = await motivoDescartePush(actual.rows[0], payload);
        if (motivo) {
            await pool.query(
                `UPDATE notificaciones_pendientes SET estado = 'cancelado', ultimo_error = $2
                 WHERE id = $1 AND estado = 'pendiente'`,
                [notificacion.id, motivo]
            );
            console.log(`[notificaciones] cancelado id=${notificacion.id}: ${motivo}`);
            return false;
        }
        return true;
    }
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
        const resultado = await conTimeout((signal) => enviar(notificacion, signal), plazoDeEnvio(notificacion));
        // un envio puede devolver { nota }: salio, pero con algo que el administrativo debe saber
        const nota = resultado && typeof resultado.nota === 'string' ? resultado.nota : null;
        const marcada = await pool.query(
            `UPDATE notificaciones_pendientes SET estado = 'enviado', enviado_at = now(), ultimo_error = COALESCE($2, ultimo_error)
             WHERE id = $1 AND estado = 'pendiente'`,
            [notificacion.id, nota]
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
        if (err && err.descartar === true) {
            // el token ya no sirve (app desinstalada, token rotado): se apaga el dispositivo y el aviso queda cancelado
            await pool.query('UPDATE dispositivos_push SET activo = false WHERE id = $1', [Number(notificacion.destinatario) || 0]);
            await pool.query(
                `UPDATE notificaciones_pendientes SET estado = 'cancelado', ultimo_error = $2
                 WHERE id = $1 AND estado = 'pendiente'`,
                [notificacion.id, err.message]
            );
            console.log(`[notificaciones] descartado id=${notificacion.id}: dispositivo apagado (${err.message})`);
            return;
        }
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
    // distintas y ningun aviso sale dos veces. Un flag en memoria no sirve entre procesos.
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

module.exports = { iniciarWorker, sigueVigente, procesarUna, usarEnvio, enviarPush, adjuntarFotosFactura, plazoDeEnvio };
