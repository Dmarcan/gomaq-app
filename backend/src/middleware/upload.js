const multer = require('multer');

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

/** Guias y facturas: solo PDF, hasta 10 MB. */
const subidaPdf = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_PDF_BYTES, files: 1 },
    fileFilter: soloTipos(['application/pdf'], 'un PDF'),
});

/** Foto de un equipo en la ficha tecnica: solo imagen, hasta 5 MB. */
const subidaImagen = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGEN_BYTES, files: 1 },
    fileFilter: soloTipos(['image/'], 'una imagen'),
});

/**
 * Traduce los errores de multer a respuestas entendibles. Se monta como manejador de errores
 * al final de server.js: sin esto, un archivo demasiado grande termina en un 500 sin explicacion.
 */
function manejarErroresDeSubida(err, req, res, next) {
    if (!(err instanceof multer.MulterError)) return next(err);
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'El archivo es demasiado grande' });
    }
    return res.status(400).json({ error: err.message || 'Archivo no valido' });
}

module.exports = {
    subidaPdf,
    subidaImagen,
    manejarErroresDeSubida,
    MAX_PDF_BYTES,
    MAX_IMAGEN_BYTES,
    MAX_ADJUNTO_BYTES,
};
