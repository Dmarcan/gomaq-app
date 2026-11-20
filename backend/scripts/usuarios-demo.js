// Crea o borra usuarios de demostracion (administrativo, mecanico y cliente) para probar el sistema.
//
//   node scripts/usuarios-demo.js crear
//   node scripts/usuarios-demo.js borrar
//
// Las contrasenas NO estan en el repositorio: se leen de variables de entorno (minimo 8 caracteres)
//   GOMAQ_DEMO_CLAVE_ADMINISTRATIVO, GOMAQ_DEMO_CLAVE_MECANICO, GOMAQ_DEMO_CLAVE_CLIENTE
// `crear` las exige; `borrar` no las necesita. Es idempotente: `crear` repetido deja las
// contrasenas al dia sin duplicar. `borrar` elimina los tres usuarios y la empresa de prueba
// (falla si la empresa ya tiene datos asociados, para no borrar nada real).
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');

const EMPRESA_DEMO = 'Empresa Demo GOMAQ';
const USUARIOS = [
    { nombre: 'Usuario Demo Administrativo', email: 'demo.admin@gomaq.demo', rol: 'administrativo', variable: 'GOMAQ_DEMO_CLAVE_ADMINISTRATIVO' },
    { nombre: 'Usuario Demo Mecánico', email: 'demo.mecanico@gomaq.demo', rol: 'mecanico', variable: 'GOMAQ_DEMO_CLAVE_MECANICO' },
    { nombre: 'Usuario Demo Cliente', email: 'demo.cliente@gomaq.demo', rol: 'cliente', variable: 'GOMAQ_DEMO_CLAVE_CLIENTE' },
];

// Lee las claves del entorno; falla con un mensaje claro si falta alguna o es demasiado corta.
function leerClaves(env = process.env) {
    const faltan = USUARIOS.filter((u) => !env[u.variable]).map((u) => u.variable);
    if (faltan.length) {
        throw new Error(`Faltan variables de entorno con las contrasenas demo: ${faltan.join(', ')}`);
    }
    const cortas = USUARIOS.filter((u) => env[u.variable].length < 8).map((u) => u.variable);
    if (cortas.length) {
        throw new Error(`Las contrasenas demo deben tener al menos 8 caracteres: ${cortas.join(', ')}`);
    }
    return Object.fromEntries(USUARIOS.map((u) => [u.email, env[u.variable]]));
}

async function crear() {
    const claves = leerClaves();
    let empresa = (await pool.query('SELECT id FROM clientes WHERE nombre = $1', [EMPRESA_DEMO])).rows[0];
    if (!empresa) {
        empresa = (await pool.query(
            `INSERT INTO clientes (nombre, rut, email) VALUES ($1, '11.111.111-1', 'demo.cliente@gomaq.demo') RETURNING id`,
            [EMPRESA_DEMO]
        )).rows[0];
    }
    for (const u of USUARIOS) {
        const hash = await bcrypt.hash(claves[u.email], 10);
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
    // Un usuario demo que hizo algo en una OT (crearla, asignarla, valorizarla) esta referenciado
    // por ordenes_eventos, que es de solo insercion (migracion 020) y rechaza UPDATE y DELETE.
    // Esta es una de las tres vias de purga permitidas: SET LOCAL activa gomaq.purga solo dentro
    // de esta transaccion. No se borran los eventos (son el historial de OT que pueden ser reales):
    // se les quita el usuario, y el rol queda escrito en el evento.
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL gomaq.purga = 'on'");
        const ids = `(SELECT id FROM usuarios WHERE email = ANY($1))`;
        await client.query(`UPDATE ordenes_eventos SET usuario_id = NULL WHERE usuario_id IN ${ids}`, [USUARIOS.map((u) => u.email)]);
        // clientes_cambios (migracion 047, cambios que el cliente hizo en su portal) tambien es de solo
        // insercion y apunta al usuario y a la empresa demo: se borra por la misma via de purga
        await client.query(
            `DELETE FROM clientes_cambios WHERE usuario_id IN ${ids}
                OR cliente_id IN (SELECT id FROM clientes WHERE nombre = $2)`,
            [USUARIOS.map((u) => u.email), EMPRESA_DEMO]
        );
        await client.query('DELETE FROM usuarios WHERE email = ANY($1)', [USUARIOS.map((u) => u.email)]);
        await client.query('DELETE FROM clientes WHERE nombre = $1', [EMPRESA_DEMO]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
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

module.exports = { USUARIOS, leerClaves };
