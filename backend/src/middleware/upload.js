const multer = require('multer');
const { detectarTipoArchivo, TIPOS } = require('../utils/firmaArchivo');

// Limites de subida. Sin esto multer acepta cualquier archivo de cualquier tamano y lo carga
// entero en memoria: el servidor actual es un equipo con 3 GB de RAM, asi que una subida
// grande (accidental o no) lo deja sin memoria. El panel web ya prometia "hasta 10 MB".
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_IMAGEN_BYTES = 5 * 1024 * 1024;
const MAX_ADJUNTO_BYTES = 10 * 1024 * 1024;

function soloTipos(tiposPermitidos, descripcion) {
    return (req, file, cb) => {
        if (tiposPermitidos.some((t) => file.mimetype === t || file.mimetype.startsWith(t))) {
            return cb(null, true);
        }
        // se marca con el mismo codigo de multer para que el manejador de server.js
        // lo traduzca a un 4xx entendible y no a un 500 generico
        const err = new multer.MulterError('LIMITE_TIPO_ARCHIVO');
        err.message = `El archivo debe ser ${descripcion}`;
        cb(err);
    };
}

/**
 * Comprueba el CONTENIDO del archivo subido (sus primeros bytes), no lo que el cliente declara, y
 * fija `req.file.mimetype` al tipo real: las rutas lo usan como Content-Type al subir a Supabase.
 * Un archivo que no es de los tipos permitidos responde 400 y no sigue a la ruta.
 */
function verificarFirma(permitidos, descripcion) {
    return (req, res, next) => {
        if (!req.file) return next();
        const tipo = detectarTipoArchivo(req.file.buffer);
        if (!tipo || !permitidos.includes(tipo)) {
            return res.status(400).json({ error: `El archivo debe ser ${descripcion}` });
        }
        req.file.mimetype = TIPOS[tipo].mimetype;
        return next();
    };
}

/** Envuelve una instancia de multer para que `.single(campo)` incluya la comprobacion de la firma. */
function conFirma(instancia, permitidos, descripcion) {
    return { single: (campo) => [instancia.single(campo), verificarFirma(permitidos, descripcion)] };
}

const IMAGENES = ['jpeg', 'png', 'webp', 'heic'];

/** Guias y facturas: solo PDF, hasta 10 MB. */
const subidaPdf = conFirma(multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PDF_BYTES, files: 1 },
    fileFilter: soloTipos(['application/pdf'], 'un PDF'),
}), ['pdf'], 'un PDF válido');

/** Foto de un equipo en la ficha tecnica o evidencia de una solicitud: solo imagen (sin SVG), hasta 5 MB. */
const subidaImagen = conFirma(multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGEN_BYTES, files: 1 },
    fileFilter: soloTipos(['image/'], 'una imagen'),
}), IMAGENES, 'una imagen JPEG, PNG, WEBP o HEIC');

/** Documento de un vehiculo: PDF o foto del papel, hasta 10 MB. */
const subidaDocumento = conFirma(multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ADJUNTO_BYTES, files: 1 },
    fileFilter: soloTipos(['application/pdf', 'image/'], 'un PDF o una imagen'),
}), ['pdf', ...IMAGENES], 'un PDF o una imagen JPEG, PNG, WEBP o HEIC');

/**
 * Traduce los errores de multer a respuestas entendibles. Se monta como manejador de errores
 * al final de server.js: sin esto, un archivo demasiado grande termina en un 500 sin explicacion.
 */
function manejarErroresDeSubida(err, req, res, next) {
    if (!(err instanceof multer.MulterError)) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'El archivo es demasiado grande (máximo 10 MB)' });
    }
    return res.status(400).json({ error: err.message || 'Archivo no válido' });
}

module.exports = {
    subidaPdf,
    subidaImagen,
    subidaDocumento,
    verificarFirma,
    manejarErroresDeSubida,
    MAX_PDF_BYTES,
    MAX_IMAGEN_BYTES,
    MAX_ADJUNTO_BYTES,
};
