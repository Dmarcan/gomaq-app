// Tipo real de un archivo subido, segun sus primeros bytes ("firma" o magic bytes).
//
// El `mimetype` que declara el cliente no vale como prueba: lo escribe quien sube el archivo y se
// reenviaria tal cual a Supabase como Content-Type. Un texto declarado como PDF pasaria el filtro, y un
// SVG o un HTML declarados como imagen quedarian guardados con ese tipo.
// Aca se reconoce el contenido; el tipo que se guarda es el que sale de la firma, no el declarado.
//
// Lista cerrada: PDF, JPEG, PNG, WEBP y HEIC/HEIF (las fotos de iPhone). SVG no va: es XML y puede
// llevar scripts.

const TIPOS = {
    pdf: { mimetype: 'application/pdf', extension: 'pdf' },
    jpeg: { mimetype: 'image/jpeg', extension: 'jpg' },
    png: { mimetype: 'image/png', extension: 'png' },
    webp: { mimetype: 'image/webp', extension: 'webp' },
    heic: { mimetype: 'image/heic', extension: 'heic' },
};

const MARCAS_HEIC = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'heif']);

function empiezaCon(buffer, bytes, desde = 0) {
    if (buffer.length < desde + bytes.length) return false;
    return bytes.every((b, i) => buffer[desde + i] === b);
}

const ascii = (texto) => Array.from(texto).map((c) => c.charCodeAt(0));

/**
 * Reconoce el tipo de un archivo por su contenido. Devuelve una de las claves de TIPOS
 * ('pdf', 'jpeg', 'png', 'webp', 'heic') o null si no es ninguno.
 */
function detectarTipoArchivo(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    if (empiezaCon(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
    if (empiezaCon(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (empiezaCon(buffer, ascii('RIFF')) && empiezaCon(buffer, ascii('WEBP'), 8)) return 'webp';
    if (empiezaCon(buffer, ascii('ftyp'), 4) && MARCAS_HEIC.has(buffer.subarray(8, 12).toString('latin1'))) return 'heic';
    // el PDF va al final: tolera basura antes de %PDF- (dentro de los primeros 1024 bytes, ISO 32000),
    // asi que una foto que lleve ese texto en sus metadatos ya se reconocio arriba como imagen
    if (buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return 'pdf';
    return null;
}

module.exports = { detectarTipoArchivo, TIPOS };
