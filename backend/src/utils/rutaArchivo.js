// Rutas de archivo en el bucket privado, armadas por el servidor.
//
// El nombre de archivo que envia el cliente NUNCA participa de la ruta: el servidor la arma entera y del
// original solo rescata la extension. Con `multer.diskStorage` y el nombre del cliente, el `path.join`
// sin normalizar permitiria escribir fuera de la carpeta (por ejemplo `1700-../../../../.env`).

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
 * se conserva la extension (la misma regla de rutaAdjuntoSolicitud, generalizada).
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
    rutaAdjuntoSolicitud, segmentoSeguro, rutaArchivo, rutaPerteneceAOrden,
};
