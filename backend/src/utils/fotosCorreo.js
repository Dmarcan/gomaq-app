// Fotos del antes y el despues que se adjuntan al correo de una factura de reparacion.
//
// El administrativo elige las fotos en la vista previa (ids de `evidencias_fotograficas`). Aqui se valida
// la eleccion, se reduce cada foto y se arman los adjuntos. Lo usan dos lados con el MISMO procedimiento: la
// API, para medir el peso antes de aceptar el envio, y el worker, para adjuntarlas al enviar. Como la
// reduccion es determinista, lo que se midio es lo que sale.
//
// `sharp` re-codifica a JPEG sin metadatos: se pierden los EXIF, incluidas las coordenadas GPS que pueda
// traer la foto. El cliente nunca recibe coordenadas (regla del proyecto).

const MAX_FOTOS = 12;
const MAX_BYTES_FOTOS = 10 * 1024 * 1024;

// Primero 1600 px y calidad 80; si no cabe en el tope, un segundo intento mas chico.
const PASOS_REDUCCION = Object.freeze([
    Object.freeze({ lado: 1600, calidad: 80 }),
    Object.freeze({ lado: 1200, calidad: 70 }),
]);

/**
 * Valida la lista de ids que manda el panel. Ausente o vacia = sin fotos. Devuelve { ids } sin repetidos
 * y en el orden recibido, o { error } con un texto para el usuario.
 */
function validarIdsFotos(valor) {
    if (valor === undefined || valor === null) return { ids: [] };
    if (!Array.isArray(valor)) return { error: 'foto_ids debe ser una lista de ids' };
    const ids = [];
    for (const v of valor) {
        const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : v;
        if (!Number.isInteger(n) || n <= 0 || n > 2147483647) return { error: 'foto_ids solo admite ids de fotos' };
        if (!ids.includes(n)) ids.push(n);
    }
    if (ids.length > MAX_FOTOS) return { error: `Se pueden adjuntar hasta ${MAX_FOTOS} fotos por correo` };
    return { ids };
}

/**
 * Las fotos pedidas, solo si TODAS son de esa orden. Salen primero las del antes y despues las del despues,
 * cada grupo por orden de subida. Un id ajeno o inexistente da { error }.
 */
async function leerFotosDeOrden(db, ordenId, ids) {
    if (ids.length === 0) return { fotos: [] };
    const r = await db.query(
        `SELECT id, tipo, path FROM evidencias_fotograficas
         WHERE orden_trabajo_id = $1 AND id = ANY($2::int[])
         ORDER BY (tipo = 'despues'), created_at, id`,
        [ordenId, ids]
    );
    if (r.rows.length !== ids.length) return { error: 'Alguna de las fotos elegidas no pertenece a esta orden de trabajo' };
    return { fotos: r.rows };
}

/** 'antes-1.jpg', 'antes-2.jpg', 'despues-1.jpg'... segun el orden de la lista (ya agrupada por tipo). */
function nombresAdjuntos(fotos) {
    const contador = {};
    return fotos.map((f) => {
        const tipo = f.tipo === 'despues' ? 'despues' : 'antes';
        contador[tipo] = (contador[tipo] || 0) + 1;
        return `${tipo}-${contador[tipo]}.jpg`;
    });
}

/** Una foto a JPEG reducido y sin metadatos. `sharp` se carga aqui: los tests de logica no lo necesitan. */
async function reducirFoto(bytes, { lado, calidad }) {
    const sharp = require('sharp');
    return sharp(bytes, { failOn: 'none' })
        .rotate() // aplica la orientacion EXIF antes de que se pierda
        .resize({ width: lado, height: lado, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' }) // un PNG con transparencia no sale negro
        .jpeg({ quality: calidad, mozjpeg: true })
        .toBuffer();
}

/**
 * Descarga y reduce las fotos, de a una (no se guardan todas en memoria a la vez).
 *
 * @param {{id:number, tipo:string, path:string}[]} fotos
 * @param {(path:string)=>Promise<Buffer|null>} descargar  null si el archivo ya no existe
 * @param {number} limite  peso maximo del conjunto (bytes ya reducidos)
 * @returns {{adjuntos:{filename:string, content:string, bytes:number}[], total:number, faltantes:number[], excede:boolean}}
 */
async function prepararAdjuntosFotos({ fotos, descargar, reducir = reducirFoto, limite = MAX_BYTES_FOTOS, pasos = PASOS_REDUCCION }) {
    let ultimo = { adjuntos: [], total: 0, faltantes: [], excede: false };
    for (const paso of pasos) {
        const adjuntos = [];
        const usadas = [];
        const faltantes = [];
        let total = 0;
        for (const foto of fotos) {
            const original = await descargar(foto.path);
            if (!original) {
                faltantes.push(foto.id);
                continue;
            }
            const reducida = await reducir(original, paso);
            total += reducida.length;
            usadas.push(foto);
            adjuntos.push({ content: reducida.toString('base64'), bytes: reducida.length });
        }
        // los nombres se ponen al final: si falta una foto, la numeracion no queda con huecos
        nombresAdjuntos(usadas).forEach((filename, i) => { adjuntos[i].filename = filename; });
        ultimo = { adjuntos, total, faltantes, excede: total > limite };
        if (!ultimo.excede) return ultimo;
    }
    return ultimo;
}

/** Descargador sobre un bucket de Supabase: devuelve el archivo o null si no esta (otro error se propaga). */
function descargadorDeBucket(supabase, bucket, signal) {
    return async (ruta) => {
        const { data, error } = await supabase.storage.from(bucket).download(ruta);
        if (signal && signal.aborted) throw new Error('Envio cancelado por timeout');
        if (error) {
            const codigo = Number(error.statusCode || error.status || (error.originalError && error.originalError.status));
            if (codigo === 404 || /not found|no existe/i.test(String(error.message))) return null;
            throw new Error(`No se pudo leer una foto: ${error.message}`);
        }
        if (!data) return null;
        return Buffer.from(await data.arrayBuffer());
    };
}

/** "10 MB" / "9,4 MB" para los mensajes. */
function formatearMb(bytes) {
    const mb = bytes / (1024 * 1024);
    return `${(Math.round(mb * 10) / 10).toString().replace('.', ',')} MB`;
}

module.exports = {
    MAX_FOTOS, MAX_BYTES_FOTOS,
    validarIdsFotos, leerFotosDeOrden, nombresAdjuntos, reducirFoto, prepararAdjuntosFotos, descargadorDeBucket, formatearMb,
};
