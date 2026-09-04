// Rutas de archivo en el bucket privado, armadas por el servidor.
//
// Hallazgo critico de la auditoria: el adjunto de una solicitud se guardaba en disco con
// `multer.diskStorage` usando el nombre que enviaba el cliente. Multer hace
// `path.join(destino, nombre)` SIN normalizar, asi que `1700-../../../../.env` escribia
// `backend/.env` - el JWT_SECRET y las credenciales de la base. Ademas ese directorio se
// servia con `express.static('/uploads')` sin autenticacion.
//
// La regla que evita toda esa clase de problema: el nombre que envia el cliente NUNCA
// participa de la ruta. El servidor la arma entera y del original solo rescata la extension.

/** Extension saneada del nombre original, o 'bin' si no hay una razonable. */
function extensionSegura(nombreOriginal) {
    const match = String(nombreOriginal || '').match(/\.([A-Za-z0-9]{1,5})$/);
    return match ? match[1].toLowerCase() : 'bin';
}

/** Sufijo aleatorio para que dos subidas del mismo archivo en el mismo milisegundo no choquen. */
function sufijoUnico() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Ruta del adjunto de una solicitud, siempre dentro de la carpeta de su propio cliente. */
function rutaAdjuntoSolicitud(clienteId, nombreOriginal) {
    return `solicitudes/cliente-${Number(clienteId) || 0}/${sufijoUnico()}.${extensionSegura(nombreOriginal)}`;
}

module.exports = { extensionSegura, sufijoUnico, rutaAdjuntoSolicitud };
