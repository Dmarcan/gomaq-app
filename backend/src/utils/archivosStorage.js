// Limpieza de archivos subidos a Supabase Storage cuando la operacion que los subio no se completo.
//
// Borrar es un intento de limpieza: si falla no cambia la respuesta al usuario, pero queda en el log para que
// alguien pueda borrar a mano el archivo huerfano. La libreria de Storage no rechaza la promesa ante un error
// del servicio: devuelve `{ error }`, asi que hay que leerlo ademas de capturar las excepciones de red.

const { supabase } = require('../config/supabase');

/**
 * Borra un archivo y nunca lanza. Devuelve true si se borro.
 * @param {string} bucket
 * @param {string} ruta
 * @param {{storage: {from: Function}}} [cliente] solo para pruebas
 */
async function borrarArchivoSubido(bucket, ruta, cliente = supabase) {
    try {
        const { error } = await cliente.storage.from(bucket).remove([ruta]);
        if (!error) return true;
        console.error(`No se pudo borrar el archivo ${bucket}/${ruta} que quedo sin registro:`, error.message);
    } catch (err) {
        console.error(`No se pudo borrar el archivo ${bucket}/${ruta} que quedo sin registro:`, err && err.message);
    }
    return false;
}

module.exports = { borrarArchivoSubido };
