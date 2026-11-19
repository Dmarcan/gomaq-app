// Piezas que comparten los routers de usuarios.

const pool = require('../../config/db');

const ROLES_VALIDOS = ['gerente', 'administrativo', 'mecanico', 'cliente'];

/** true si la cuenta :id es de un gerente y quien pide no lo es: solo un gerente actua sobre otro gerente. */
async function esGerenteVedado(req) {
    if (req.user.rol === 'gerente') return false;
    const r = await pool.query(`SELECT 1 FROM usuarios WHERE id = $1 AND rol = 'gerente'`, [req.params.id]);
    return r.rows.length > 0;
}

module.exports = { ROLES_VALIDOS, esGerenteVedado };
