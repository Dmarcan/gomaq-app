// Uso: node scripts/create-user.js <nombre> <email> <password> <rol>
// rol: gerente | administrativo | mecanico | cliente
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');

async function main() {
    const [nombre, email, password, rol] = process.argv.slice(2);
    const rolesValidos = ['gerente', 'administrativo', 'mecanico', 'cliente'];

    if (!nombre || !email || !password || !rol) {
        console.error('Uso: node scripts/create-user.js <nombre> <email> <password> <rol>');
        process.exit(1);
    }
    if (!rolesValidos.includes(rol)) {
        console.error(`Rol invalido. Debe ser uno de: ${rolesValidos.join(', ')}`);
        process.exit(1);
    }

    const hash = await bcrypt.hash(password, 10);
    try {
        const result = await pool.query(
            'INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES ($1, $2, $3, $4) RETURNING id, nombre, email, rol',
            [nombre, email, hash, rol]
        );
        console.log('Usuario creado:', result.rows[0]);
    } catch (err) {
        console.error('Error al crear usuario:', err.message);
    } finally {
        await pool.end();
    }
}

main();
