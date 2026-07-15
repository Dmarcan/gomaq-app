const pool = require('../config/db');

// verifica que una orden de trabajo exista y pertenezca al mecanico dado
async function verificarDuenoOrden(ordenId, mecanicoId) {
    const result = await pool.query('SELECT mecanico_id FROM ordenes_trabajo WHERE id = $1', [ordenId]);
    if (result.rows.length === 0) return { existe: false };
    return { existe: true, esDueno: result.rows[0].mecanico_id === mecanicoId };
}

module.exports = { verificarDuenoOrden };
