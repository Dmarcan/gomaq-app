// Las rutas guardan el camino del archivo dentro de un bucket privado de Supabase; al responder se cambia por una URL firmada temporal.
const URL_EXPIRACION_SEGUNDOS = 3600;

/** Firma `ruta` del bucket para leerla durante una hora. Devuelve { data, error } como Supabase. */
function firmarUrl(supabase, bucket, ruta) {
    return supabase.storage.from(bucket).createSignedUrl(ruta, URL_EXPIRACION_SEGUNDOS);
}

/** La URL firmada, o null si no se pudo firmar (el documento queda sin enlace). */
async function urlFirmadaONull(supabase, bucket, ruta) {
    const { data, error } = await firmarUrl(supabase, bucket, ruta);
    return error ? null : data.signedUrl;
}

module.exports = { URL_EXPIRACION_SEGUNDOS, firmarUrl, urlFirmadaONull };
