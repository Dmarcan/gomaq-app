// Uso: node scripts/create-user.js <nombre> <email> <rol> [cliente_id]
// rol: gerente | administrativo | mecanico | cliente
// cliente_id: solo aplica (y es requerido) cuando rol=cliente, vincula el usuario a su empresa
//
// La contrasena NO se pasa por argumento: se pide por consola y no se muestra al escribirla.
// Antes iba en argv, donde queda en el historial del shell y visible en `ps` para cualquier
// otro usuario de la maquina (hallazgo de la auditoria).
require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');
const { validarNuevaCuenta } = require('../src/utils/cuentasInternas');

/** Lee una contrasena sin ecoarla en la terminal. */
function pedirPassword(mensaje) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        // silencia el eco: readline sigue leyendo, pero no imprime lo que se teclea
        const alEscribir = rl._writeToOutput;
        rl._writeToOutput = function (texto) {
            if (texto.includes(mensaje)) return alEscribir.call(rl, texto);
        };
        rl.question(mensaje, (respuesta) => {
            rl.close();
            process.stdout.write('\n');
            resolve(respuesta);
        });
    });
}

async function main() {
    const [nombre, email, rol, clienteId] = process.argv.slice(2);
    const rolesValidos = ['gerente', 'administrativo', 'mecanico', 'cliente'];

    if (!nombre || !email || !rol) {
        console.error('Uso: node scripts/create-user.js <nombre> <email> <rol> [cliente_id]');
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

    const password = await pedirPassword('Contrasena: ');
    const repetida = await pedirPassword('Repetir contrasena: ');
    if (password !== repetida) {
        console.error('Las contrasenas no coinciden');
        process.exit(1);
    }

    // mismas reglas que el panel (utils/cuentasInternas.js): correo en minusculas y con formato valido,
    // clave de 8 a 72 bytes. Para rol=cliente se valida con un rol interno solo por reutilizar la regla.
    const v = validarNuevaCuenta({ nombre, email, rol: rol === 'cliente' ? 'gerente' : rol, password });
    if (!v.ok) {
        console.error(v.error);
        process.exit(1);
    }

    const hash = await bcrypt.hash(password, 10);
    try {
        const result = await pool.query(
            'INSERT INTO usuarios (nombre, email, password_hash, rol, cliente_id) VALUES ($1, $2, $3, $4, $5) RETURNING id, nombre, email, rol, cliente_id',
            [v.datos.nombre, v.datos.email, hash, rol, rol === 'cliente' ? clienteId : null]
        );
        console.log('Usuario creado:', result.rows[0]);
    } catch (err) {
        console.error('Error al crear usuario:', err.message);
    } finally {
        await pool.end();
    }
}

main();
