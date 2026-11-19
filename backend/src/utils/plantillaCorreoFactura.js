// Arma el correo de una factura (HTML y texto plano). Funciones puras, sin red ni base de datos.
// El cuerpo lo escribe o edita el administrativo: es TEXTO y siempre se escapa antes de ir al HTML.
//
// Diseno: encabezado con el logo de GOMAQ (incrustado en el correo con `cid:`, no depende de ninguna URL),
// el mensaje, una tarjeta con el resumen de la factura y un pie. Tablas de una columna con estilos en linea:
// se ve igual en Gmail, Outlook y el celular (375 px). El resumen muestra solo lo que el cliente ya recibe en
// la factura: nunca valorizacion, costos ni datos internos.

const COLOR_NARANJA = '#EA5B1F';
const COLOR_OSCURO = '#1B1210';
/** Content-ID del logo: el adjunto del correo lo declara con este mismo valor (`content_id`). */
const LOGO_CID = 'logo-gomaq';
const NOMBRE_EMPRESA = 'GOMAQ Maquinarias';

function escaparHtml(texto) {
    return String(texto ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * El correo de contacto si es una direccion valida (sin espacios, comas, comillas ni corchetes), o null. Con
 * ella el correo lleva `reply_to` y el pie invita a responder; sin ella no hay a quien responder.
 */
function correoDeContacto(contacto) {
    if (typeof contacto !== 'string') return null;
    const c = contacto.trim();
    return /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/.test(c) && c.length <= 254 ? c : null;
}

function lineaContacto(correo) {
    return correo
        ? `Este es un envío automático de ${NOMBRE_EMPRESA}. Puede responder a este correo o escribir a ${correo}.`
        : `Este es un envío automático de ${NOMBRE_EMPRESA}: no responda a este correo.`;
}

/** 1234567 o '1000.00' a '$ 1.234.567' (pesos chilenos). null si no es un monto. */
function formatearPesos(valor) {
    if (valor === null || valor === undefined || valor === '') return null;
    const n = Math.round(Number(valor));
    if (!Number.isFinite(n)) return null;
    const signo = n < 0 ? '-' : '';
    return `${signo}$ ${String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

/** 'YYYY-MM-DD' (o un Date en ISO) a 'dd-mm-aaaa'. null si no es un dia. */
function diaCorto(valor) {
    if (!valor) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(valor instanceof Date ? valor.toISOString() : String(valor));
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** "2 adjuntas: 1 del antes y 1 del despues". null si no van fotos. */
function textoFotos(fotos) {
    const antes = Number(fotos && fotos.antes) || 0;
    const despues = Number(fotos && fotos.despues) || 0;
    const total = antes + despues;
    if (total <= 0) return null;
    const partes = [];
    if (antes > 0) partes.push(`${antes} del antes`);
    if (despues > 0) partes.push(`${despues} del después`);
    return `${total} ${total === 1 ? 'adjunta' : 'adjuntas'}: ${partes.join(' y ')}`;
}

/**
 * Filas del resumen [etiqueta, valor]. Una fila sin dato no se muestra.
 * @param {{folio?:string, monto?:number|string, ordenId?:number, equipo?:string, periodoDesde?:string, periodoHasta?:string,
 *          emision?:string, vencimiento?:string, fotos?:{antes:number, despues:number}}} r
 */
function filasResumen(r) {
    if (!r) return [];
    const filas = [];
    if (r.folio) filas.push(['Folio', String(r.folio)]);
    const monto = formatearPesos(r.monto);
    if (monto) filas.push(['Monto total', monto]);
    if (r.ordenId) filas.push(['Orden de trabajo', r.equipo ? `#${r.ordenId} (equipo ${r.equipo})` : `#${r.ordenId}`]);
    else if (r.equipo) filas.push(['Arriendo del equipo', String(r.equipo)]);
    const desde = diaCorto(r.periodoDesde);
    const hasta = diaCorto(r.periodoHasta);
    if (desde && hasta) filas.push(['Período', `${desde} al ${hasta}`]);
    const emision = diaCorto(r.emision);
    if (emision) filas.push(['Emitida', emision]);
    const vence = diaCorto(r.vencimiento);
    if (vence) filas.push(['Vence', vence]);
    const fotos = textoFotos(r.fotos);
    if (fotos) filas.push(['Fotos del trabajo', fotos]);
    return filas;
}

/** El resumen que sale del aviso encolado (payload de `factura_emitida`) y de lo realmente adjunto. */
function resumenDePayload(payload, fotos) {
    const p = payload || {};
    return {
        folio: p.folio,
        monto: p.monto,
        ordenId: p.orden_trabajo_id || undefined,
        equipo: p.maquinaria_codigo || undefined,
        periodoDesde: p.periodo_desde,
        periodoHasta: p.periodo_hasta,
        emision: p.fecha_emision,
        vencimiento: p.fecha_vencimiento,
        fotos,
    };
}

const FUENTE = 'font-family:Arial,Helvetica,sans-serif;';

/** Escapa el valor y deja cada fecha dd-mm-aaaa en una sola linea (sin partirla en el guion). */
function valorHtml(valor) {
    return escaparHtml(valor).replace(/\d{2}-\d{2}-\d{4}/g, (f) => `<span style="white-space:nowrap;">${f}</span>`);
}

function tarjetaHtml(filas) {
    if (filas.length === 0) return '';
    const celdas = filas.map(([etiqueta, valor]) =>
        '<tr>'
        + `<td valign="top" style="${FUENTE}padding:6px 12px 6px 0;font-size:13px;line-height:1.4;color:#666666;width:38%;">${escaparHtml(etiqueta)}</td>`
        + `<td valign="top" style="${FUENTE}padding:6px 0;font-size:15px;line-height:1.4;color:#222222;font-weight:bold;">${valorHtml(valor)}</td>`
        + '</tr>').join('');
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 4px 0;">'
        + `<tr><td style="background:#f7f7f7;border:1px solid #e5e5e5;border-left:4px solid ${COLOR_NARANJA};padding:10px 16px;">`
        + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${celdas}</table>`
        + '</td></tr></table>';
}

function encabezadoHtml(conLogo) {
    const contenido = conLogo
        ? `<img src="cid:${LOGO_CID}" width="160" alt="${NOMBRE_EMPRESA}" style="display:block;border:0;outline:none;width:160px;height:auto;${FUENTE}font-size:20px;font-weight:bold;color:#ffffff;">`
        : `<span style="${FUENTE}font-size:20px;font-weight:bold;color:#ffffff;">${NOMBRE_EMPRESA}</span>`;
    return `<tr><td bgcolor="${COLOR_OSCURO}" style="background:${COLOR_OSCURO};padding:18px 24px;">${contenido}</td></tr>`
        + `<tr><td bgcolor="${COLOR_NARANJA}" height="4" style="background:${COLOR_NARANJA};height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>`;
}

/**
 * @param {{asunto:string, cuerpo:string, contacto?:string, resumen?:object, conLogo?:boolean}} p
 * @returns {{asunto:string, texto:string, html:string, replyTo:string|null, logoCid:string}}
 */
function armarCorreoFactura({ asunto, cuerpo, contacto, resumen, conLogo = true }) {
    const correo = correoDeContacto(contacto);
    const filas = filasResumen(resumen);
    const pie = lineaContacto(correo);

    const textoResumen = filas.length ? `\n\n${filas.map(([e, v]) => `${e}: ${v}`).join('\n')}` : '';
    const texto = `${cuerpo}${textoResumen}\n\n--\n${pie}`;

    const parrafos = String(cuerpo)
        .split(/\n{2,}/)
        .map((p) => `<p style="margin:0 0 14px 0;">${escaparHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('');
    const html = '<!doctype html><html lang="es"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + '<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">'
        + `<title>${escaparHtml(asunto)}</title></head>`
        + '<body style="margin:0;padding:0;background:#f4f4f4;">'
        // texto de vista previa de la bandeja de entrada
        + `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f4f4f4;">${escaparHtml(asunto)}</div>`
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f4" style="background:#f4f4f4;">'
        + '<tr><td align="center" style="padding:16px 8px;">'
        + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background:#ffffff;border-radius:6px;">'
        + encabezadoHtml(conLogo)
        + `<tr><td style="${FUENTE}padding:24px 24px 8px 24px;font-size:15px;line-height:1.5;color:#222222;">${parrafos}${tarjetaHtml(filas)}</td></tr>`
        + `<tr><td style="${FUENTE}padding:8px 24px 24px 24px;">`
        + '<hr style="border:none;border-top:1px solid #dddddd;margin:16px 0;">'
        + `<p style="margin:0;font-size:13px;line-height:1.5;color:#555555;">${escaparHtml(pie)}</p>`
        + '</td></tr></table></td></tr></table></body></html>';
    return { asunto, texto, html, replyTo: correo, logoCid: LOGO_CID };
}

module.exports = {
    armarCorreoFactura, escaparHtml, correoDeContacto, formatearPesos, diaCorto, textoFotos, filasResumen, resumenDePayload,
    LOGO_CID, NOMBRE_EMPRESA, COLOR_NARANJA, COLOR_OSCURO,
};
