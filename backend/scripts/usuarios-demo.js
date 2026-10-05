// Crea o borra los usuarios de prueba que usan los botones de inicio rapido del panel y de terreno.
//
//   node scripts/usuarios-demo.js crear
//   node scripts/usuarios-demo.js borrar
//
// SOLO PARA PRUEBAS: las credenciales estan en el repositorio. Las mismas viven en
// comun/lib/usuarios_demo.dart; si se cambian, cambiarlas en los dos lados. Es idempotente:
// `crear` repetido deja las contrasenas al dia sin duplicar. `borrar` elimina los tres usuarios y
// la empresa de prueba (falla si la empresa ya tiene datos asociados, para no borrar nada real).
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');

const EMPRESA_DEMO = 'Empresa Demo GOMAQ';
const USUARIOS = [
    { nombre: 'Usuario Demo Administrativo', email: 'demo.admin@gomaq.demo', rol: 'administrativo', clave: 'clave-demo-retirada' },
    { nombre: 'Usuario Demo Mecánico', email: 'demo.mecanico@gomaq.demo', rol: 'mecanico', clave: 'clave-demo-retirada' },
    { nombre: 'Usuario Demo Cliente', email: 'demo.cliente@gomaq.demo', rol: 'cliente', clave: 'clave-demo-retirada' },
];

async function crear() {
    let empresa = (await pool.query('SELECT id FROM clientes WHERE nombre = $1', [EMPRESA_DEMO])).rows[0];
    if (!empresa) {
        empresa = (await pool.query(
            `INSERT INTO clientes (nombre, rut, email) VALUES ($1, '11.111.111-1', 'demo.cliente@gomaq.demo') RETURNING id`,
            [EMPRESA_DEMO]
        )).rows[0];
    }
    for (const u of USUARIOS) {
        const hash = await bcrypt.hash(u.clave, 10);
        const clienteId = u.rol === 'cliente' ? empresa.id : null;
        await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, cliente_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, rol = EXCLUDED.rol, cliente_id = EXCLUDED.cliente_id`,
            [u.nombre, u.email, hash, u.rol, clienteId]
        );
        console.log(`usuario listo: ${u.email} (${u.rol})`);
    }
}

async function borrar() {
    await pool.query('DELETE FROM usuarios WHERE email = ANY($1)', [USUARIOS.map((u) => u.email)]);
    await pool.query('DELETE FROM clientes WHERE nombre = $1', [EMPRESA_DEMO]);
    console.log('usuarios de prueba y empresa demo borrados');
}

async function main() {
    const accion = process.argv[2];
    if (accion !== 'crear' && accion !== 'borrar') {
        console.error('Uso: node scripts/usuarios-demo.js crear|borrar');
        process.exit(1);
    }
    try {
        await (accion === 'crear' ? crear() : borrar());
    } catch (err) {
        console.error('Error:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

if (require.main === module) main();

module.exports = { USUARIOS };
