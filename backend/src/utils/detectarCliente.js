const pool = require('../config/db');
const { normalizarRutSinValidar } = require('./parsearDocumento');

/**
 * Elige que cliente conocido corresponde a un documento. Funcion pura para poder probarla.
 *
 * Primero por RUT, que es la unica senal inequivoca: el nombre puede aparecer escrito de
 * varias formas y el documento tambien contiene el nombre y el RUT de GOMAQ (el emisor).
 *
 * Si no hay RUT se cae al nombre, recorriendo los candidatos del nombre mas largo al mas corto: sin un
 * orden fijo, con un nombre contenido en otro ("Acme" y "Acme International") el mismo PDF podia
 * resolverse a uno u otro entre llamadas.
 */
function elegirCliente(texto, rut, clientes) {
    const rutBuscado = normalizarRutSinValidar(rut);
    if (rutBuscado) {
        const porRut = clientes.find((c) => normalizarRutSinValidar(c.rut) === rutBuscado);
        if (porRut) return porRut;
    }

    if (!texto) return null;
    const textoMinuscula = texto.toLowerCase();
    const porNombre = clientes
        .filter((c) => c.nombre)
        .sort((a, b) => b.nombre.length - a.nombre.length || String(a.id).localeCompare(String(b.id)))
        .find((c) => textoMinuscula.includes(c.nombre.toLowerCase()));
    return porNombre || null;
}

/** Busca en la BD que cliente corresponde al documento. Mejor esfuerzo: null si no hay match. */
async function detectarCliente(texto, rut) {
    if (!texto && !rut) return null;
    const clientes = await pool.query('SELECT id, nombre, rut FROM clientes');
    return elegirCliente(texto, rut, clientes.rows);
}

module.exports = { detectarCliente, elegirCliente };
