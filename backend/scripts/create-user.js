// Uso: node scripts/create-user.js <nombre> <email> <password> <rol> [cliente_id]
// rol: gerente | administrativo | mecanico | cliente
// cliente_id: solo aplica (y es requerido) cuando rol=cliente, vincula el usuario a su empresa
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');

async function main() {
    const [nombre, email, password, rol, clienteId] = process.argv.slice(2);
    const rolesValidos = ['gerente', 'administrativo', 'mecanico', 'cliente'];

    if (!nombre || !email || !password || !rol) {
        console.error('Uso: node scripts/create-user.js <nombre> <email> <password> <rol> [cliente_id]');
        process.exit(1);
    }
    if (!rolesValidos.includes(rol)) {
        console.error(`Rol invalido. Debe ser uno de: ${rolesValidos.join(', ')}`);
        process.exit(1);
    }
    if (rol === 'cliente' && !clienteId) {
        console.error('Para rol=cliente debes indicar cliente_id (id de la tabla clientes)');
        process.exit(1);
    }

    const hash = await bcrypt.hash(password, 10);
    try {
        const result = await pool.query(
            'INSERT INTO usuarios (nombre, email, password_hash, rol, cliente_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, nombre, email, rol, cliente_id',
            [nombre, email, hash, rol, rol === 'cliente' ? clienteId : null]
        );
        console.log('Usuario creado:', result.rows[0]);
    } catch (err) {
        console.error('Error al crear usuario:', err.message);
    } finally {
        await pool.end();
    }
}

main();
