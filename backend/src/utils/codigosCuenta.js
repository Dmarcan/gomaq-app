// Reglas puras de los codigos de un solo uso de la cuenta (tabla codigos_cuenta, migracion 034):
// generarlos, guardar solo su HMAC, decidir si un canje vale y armar el texto que se envia.
// Sin consultas ni red: las rutas solo orquestan.

const crypto = require('node:crypto');
const { validarPassword } = require('./cuentasInternas');
const { normalizarCorreo } = require('./correo');

const CANALES = ['correo', 'manual'];
const MAX_INTENTOS = 5;
const DIGITOS = 6;

// "Olvide mi contrasena" la pide la misma persona y la usa enseguida: 15 minutos. Un codigo que genera
// el administrador (invitacion o restablecer) viaja por correo o WhatsApp y puede leerse horas despues.
const VIGENCIA_MINUTOS = {
    recuperar_password: 15,
    recuperar_password_admin: 24 * 60,
    invitacion: 72 * 60,
    verificar_correo: 30,
};

/** Minutos de vigencia segun el proposito y si lo genero un administrador. */
function vigenciaMinutos(proposito, { generadoPorAdmin = false } = {}) {
    if (proposito === 'recuperar_password' && generadoPorAdmin) return VIGENCIA_MINUTOS.recuperar_password_admin;
    const m = VIGENCIA_MINUTOS[proposito];
    if (!m) throw new Error(`Proposito de codigo desconocido: ${proposito}`);
    return m;
}

/** Codigo de 6 digitos con un generador criptografico (los ceros a la izquierda cuentan). */
function generarCodigo(aleatorio = crypto.randomInt) {
    return String(aleatorio(0, 10 ** DIGITOS)).padStart(DIGITOS, '0');
}

/** Lo que escribe la persona, sin espacios ni guiones. null si no son exactamente 6 digitos. */
function normalizarCodigo(texto) {
    if (typeof texto !== 'string' && typeof texto !== 'number') return null;
    const limpio = String(texto).replace(/[\s-]/g, '');
    return /^\d{6}$/.test(limpio) ? limpio : null;
}

// Clave propia para los codigos, derivada del JWT_SECRET (que el arranque ya exige largo y aleatorio):
// no hay otra variable que configurar, y un HMAC filtrado no sirve para firmar sesiones.
function claveCodigos(secreto) {
    if (typeof secreto !== 'string' || secreto.length === 0) throw new Error('Falta el secreto para los codigos');
    return Buffer.from(crypto.hkdfSync('sha256', secreto, Buffer.alloc(0), 'gomaq-codigos-cuenta-v1', 32));
}

/**
 * HMAC del codigo, amarrado al proposito y al correo: el mismo codigo para otro correo da otro HMAC.
 * @returns {string} 64 caracteres hexadecimales
 */
function hmacCodigo({ secreto, proposito, email, codigo }) {
    return crypto
        .createHmac('sha256', claveCodigos(secreto))
        .update(`${proposito}:${normalizarCorreo(email)}:${codigo}`)
        .digest('hex');
}

/** Compara dos HMAC en tiempo constante. */
function hmacIguales(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Decide un canje. `fila` es la de codigos_cuenta; `hmacIngresado` el HMAC de lo que escribio la persona.
 * @returns {'ok'|'usado'|'revocado'|'vencido'|'agotado'|'incorrecto'}
 */
function evaluarCanje(fila, { hmacIngresado, ahora = new Date() }) {
    if (!fila) return 'incorrecto';
    if (fila.usado_at) return 'usado';
    if (fila.revocado_at) return 'revocado';
    if (new Date(fila.expira_at).getTime() <= ahora.getTime()) return 'vencido';
    if (Number(fila.intentos) >= MAX_INTENTOS) return 'agotado';
    return hmacIguales(fila.codigo_hmac, hmacIngresado) ? 'ok' : 'incorrecto';
}

/**
 * Una invitacion solo activa una cuenta que sigue pendiente, y recuperar la clave solo vale para una
 * cuenta activa: un codigo viejo no reactiva una cuenta que el administrador desactivo.
 */
function canjePermitido(proposito, estadoCuenta) {
    if (proposito === 'invitacion') return estadoCuenta === 'pendiente';
    if (proposito === 'recuperar_password') return estadoCuenta === 'activo';
    return false;
}

/**
 * Estado de la ultima invitacion de una cuenta pendiente, para la lista de cuentas del panel.
 * @returns {'vigente'|'vencida'|'bloqueada'|'revocada'|'aceptada'|'sin_invitacion'}
 */
function estadoInvitacion(fila, ahora = new Date()) {
    if (!fila || !fila.expira_at) return 'sin_invitacion';
    if (fila.usado_at) return 'aceptada';
    if (fila.revocado_at) return 'revocada';
    if (new Date(fila.expira_at).getTime() <= ahora.getTime()) return 'vencida';
    if (Number(fila.intentos) >= MAX_INTENTOS) return 'bloqueada';
    return 'vigente';
}

/**
 * El envio por correo solo sirve con clave de Resend y un remitente de dominio verificado. Con el
 * remitente de pruebas de Resend (onboarding@resend.dev) solo llega a la duena de la clave.
 * @returns {{disponible: boolean, motivo: string|null}}
 */
function correoDisponible(env = process.env) {
    if (!env.RESEND_API_KEY) return { disponible: false, motivo: 'Falta configurar el envío de correos (RESEND_API_KEY).' };
    const remitente = String(env.CORREO_REMITENTE || '').trim();
    if (!remitente) return { disponible: false, motivo: 'Falta configurar el remitente de los correos (CORREO_REMITENTE).' };
    if (/@resend\.dev\b/i.test(remitente)) {
        return { disponible: false, motivo: 'El remitente es el de pruebas de Resend: falta verificar el dominio de GOMAQ.' };
    }
    return { disponible: true, motivo: null };
}

/** URL publica del panel para los mensajes, o null si no se conoce (entonces el texto no lleva enlace). */
function urlPanel(env = process.env) {
    const explicita = String(env.PANEL_URL || '').trim().replace(/\/+$/, '');
    if (/^https?:\/\/[^\s/]+/.test(explicita)) return explicita;
    const dominio = String(env.RAILWAY_PUBLIC_DOMAIN || '').trim();
    if (/^[a-z0-9.-]+$/i.test(dominio)) return `https://${dominio}`;
    return null;
}

const HORA = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});

/** "12-11, 14:30" en la hora de Chile. */
function textoVence(fecha) {
    return HORA.format(new Date(fecha));
}

/**
 * Texto del codigo, el mismo para el correo y para el mensaje que el administrador copia y envia a mano.
 * El codigo nunca va en el enlace: los enlaces quedan en historiales y WhatsApp los abre para la vista previa.
 */
function textoCodigo({ proposito, nombre, email, codigo, venceAt, url }) {
    const saludo = nombre ? `Hola ${nombre}:` : 'Hola:';
    const vence = `Vale hasta el ${textoVence(venceAt)} y sirve una sola vez.`;
    const codigoAgrupado = `${codigo.slice(0, 3)} ${codigo.slice(3)}`;
    if (proposito === 'invitacion') {
        return [
            saludo,
            '',
            'Te crearon una cuenta en GOMAQ. Para activarla y elegir tu contraseña:',
            url ? `1. Abre ${url}/activar en el navegador (si eres mecánico, desde el teléfono; después entras con la app GOMAQ Mecánico).`
                : '1. Abre el panel de GOMAQ en /activar desde el navegador (si eres mecánico, después entras con la app GOMAQ Mecánico).',
            `2. Escribe tu correo de acceso: ${email}`,
            `3. Escribe este código: ${codigoAgrupado}`,
            '',
            vence,
            'No compartas este código. Si no esperabas este mensaje, ignóralo.',
        ].join('\n');
    }
    if (proposito === 'verificar_correo') {
        return [
            saludo,
            '',
            'Para terminar tu registro en GOMAQ, confirma que este correo es tuyo:',
            '1. Vuelve a la pantalla de registro de GOMAQ.',
            `2. Escribe este código: ${codigoAgrupado}`,
            '',
            vence,
            'No compartas este código. Si no pediste una cuenta en GOMAQ, ignora este mensaje.',
        ].join('\n');
    }
    return [
        saludo,
        '',
        'Pediste cambiar tu contraseña de GOMAQ. Para elegir una nueva:',
        url ? `1. Abre ${url}/recuperar en el navegador (si eres mecánico, desde el teléfono; después entras con la app GOMAQ Mecánico).`
            : '1. Abre el panel de GOMAQ en /recuperar desde el navegador (si eres mecánico, después entras con la app GOMAQ Mecánico).',
        `2. Escribe tu correo de acceso: ${email}`,
        `3. Escribe este código: ${codigoAgrupado}`,
        '',
        vence,
        'No compartas este código. Si no lo pediste, ignora este mensaje: tu contraseña actual sigue igual.',
    ].join('\n');
}

/** Asunto del correo segun el proposito. */
function asuntoCodigo(proposito) {
    if (proposito === 'invitacion') return 'Activa tu cuenta de GOMAQ';
    if (proposito === 'verificar_correo') return 'Confirma tu correo en GOMAQ';
    return 'Código para cambiar tu contraseña de GOMAQ';
}

/** Valida el cuerpo de POST /api/auth/codigo/confirmar. */
function validarConfirmacion(body) {
    const b = body && typeof body === 'object' ? body : {};
    const email = normalizarCorreo(b.email);
    const codigo = normalizarCodigo(b.codigo);
    if (!email || !codigo) return { ok: false, error: 'Escribe tu correo y el código de 6 dígitos' };
    const clave = validarPassword(b.password);
    if (!clave.ok) return clave;
    return { ok: true, email, codigo, password: b.password };
}

/** Valida el canal pedido (correo o manual). */
function validarCanal(canal) {
    return CANALES.includes(canal) ? { ok: true, canal } : { ok: false, error: 'Elige cómo enviar el código: correo o manual' };
}

module.exports = {
    CANALES, MAX_INTENTOS,
    vigenciaMinutos, generarCodigo, normalizarCodigo, hmacCodigo, evaluarCanje, canjePermitido, estadoInvitacion,
    correoDisponible, urlPanel, textoCodigo, asuntoCodigo, validarConfirmacion, validarCanal,
};
