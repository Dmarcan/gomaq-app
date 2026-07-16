const pool = require('../config/db');

// busca cual cliente conocido aparece mencionado dentro del texto extraido de un PDF
// (guia o factura). Mejor esfuerzo: null si no hay texto o no se encuentra ninguno.
async function detectarCliente(texto) {
    if (!texto) return null;
    const clientes = await pool.query('SELECT id, nombre FROM clientes');
    const textoMinuscula = texto.toLowerCase();
    const encontrado = clientes.rows.find((c) => textoMinuscula.includes(c.nombre.toLowerCase()));
    return encontrado || null;
}

module.exports = { detectarCliente };
