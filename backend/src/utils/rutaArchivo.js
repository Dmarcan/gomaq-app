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

/**
 * Un trozo de ruta armado desde un dato (el codigo de un equipo, por ejemplo). Solo letras,
 * numeros, guion y guion bajo: un `/` crearia carpetas y un `..` saldria de la propia.
 */
function segmentoSeguro(texto) {
    const limpio = String(texto ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
    return limpio || 'sin-nombre';
}

/**
 * Ruta de cualquier archivo subido: la carpeta la decide el servidor y del nombre original solo
 * se conserva la extension. Es la misma regla de rutaAdjuntoSolicitud, generalizada: la segunda
 * auditoria encontro guias, facturas, fotos de equipos, documentos de vehiculos y evidencias
 * que todavia metian el nombre enviado por el usuario dentro de la ruta.
 *
 * @param {Array<string|number>} carpetas  cada una se sanea con segmentoSeguro
 */
function rutaArchivo(carpetas, nombreOriginal) {
    const base = carpetas.map(segmentoSeguro).join('/');
    return `${base}/${sufijoUnico()}.${extensionSegura(nombreOriginal)}`;
}

/**
 * Si una ruta que devuelve el cliente (la de una foto o una firma ya subida) esta dentro de la
 * carpeta esperada. Sin `..` ni barras dobles, que permitirian apuntar a otra carpeta aunque el
 * prefijo coincida.
 */
function rutaPerteneceAOrden(ruta, prefijo) {
    if (typeof ruta !== 'string' || !ruta.startsWith(prefijo)) return false;
    return !ruta.includes('..') && !ruta.includes('//') && !ruta.includes('\\');
}

module.exports = {
    extensionSegura, sufijoUnico, rutaAdjuntoSolicitud, segmentoSeguro, rutaArchivo, rutaPerteneceAOrden,
};
