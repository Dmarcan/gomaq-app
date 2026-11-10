const pool = require('../config/db');

/** Numero al final del codigo, sin ceros a la izquierda: 'PL-807' -> '807', 'GH-0506' -> '506'. */
function numeroDelCodigo(codigo) {
    const match = String(codigo || '').match(/(\d+)\s*$/);
    if (!match) return null;
    return match[1].replace(/^0+/, '') || null;
}

/**
 * Elige que equipo de la flota corresponde al numero interno de un documento. Funcion pura
 * para poder probarla.
 *
 * Solo responde cuando calza exactamente un equipo: si dos codigos terminan en el mismo
 * numero (GH-807 y PL-807) no se adivina, porque una guia asigna o libera el equipo y
 * elegir el equivocado es peor que dejar el campo vacio.
 */
function elegirEquipo(numeroInterno, maquinarias) {
    const buscado = String(numeroInterno || '').replace(/^0+/, '');
    if (!buscado || !/^\d+$/.test(buscado)) return null;
    const candidatos = maquinarias.filter((m) => numeroDelCodigo(m.codigo) === buscado);
    return candidatos.length === 1 ? candidatos[0] : null;
}

/** Busca en la BD el equipo del documento. Mejor esfuerzo: null si no hay un unico match. */
async function detectarEquipo(numeroInterno) {
    if (!numeroInterno) return null;
    const maquinarias = await pool.query('SELECT id, codigo FROM maquinarias');
    return elegirEquipo(numeroInterno, maquinarias.rows);
}

module.exports = { detectarEquipo, elegirEquipo, numeroDelCodigo };
