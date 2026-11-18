// Aplica el esquema y las migraciones pendientes de db/, en orden, una sola vez cada una.
//
//   node scripts/migrar.js
//
// Corre al arrancar el contenedor, antes que el servidor (CMD del Dockerfile), y lleva el registro de las
// migraciones aplicadas en la tabla schema_migraciones.
//
// Base vacia: aplica schema.sql y todas las migraciones.
// Base existente sin registro (la del servidor local, migrada a mano): se niega a tocarla,
// porque no puede saber cuales ya estan aplicadas. Para esa, marcar primero las que ya estan:
//
//   node scripts/migrar.js --marcar-hasta 016
//
// Para probar una migracion nueva contra filas ya existentes (scripts/probar_migraciones_con_datos.js)
// se puede aplicar solo hasta cierta version, inclusive, sin tocar las siguientes:
//
//   node scripts/migrar.js --hasta 042
//
// Cada migracion corre en su propia transaccion: si falla, no queda a medias ni registrada.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { urlBaseDeScript } = require('./_conexion');

// numero arbitrario pero fijo que identifica el candado de migraciones en pg_advisory_lock
const CANDADO_MIGRACIONES = 70214;

// en el repositorio db/ esta junto a backend/; en la imagen de Docker se copia a /db
const DIRECTORIO_DB = [path.join(__dirname, '../../db'), '/db'].find((d) => fs.existsSync(d));

// Lee la opcion --hasta NNN de los argumentos. Devuelve null si no viene; lanza un error claro si
// el valor no es un numero de tres digitos o no corresponde a ninguna migracion existente.
function leerHasta(argv, disponibles) {
    const i = argv.indexOf('--hasta');
    if (i === -1) return null;
    const tope = argv[i + 1];
    if (!/^\d{3}$/.test(tope || '')) throw new Error('Uso: --hasta 042 (numero de tres digitos)');
    if (!disponibles.some((f) => f.slice(0, 3) === tope)) {
        throw new Error(`--hasta ${tope}: no existe una migracion con ese numero`);
    }
    return tope;
}

function migracionesDisponibles() {
    return fs.readdirSync(path.join(DIRECTORIO_DB, 'migrations'))
        .filter((f) => /^\d{3}_.*\.sql$/.test(f))
        .sort();
}

async function main() {
    if (!DIRECTORIO_DB) throw new Error('No se encontro el directorio db/ con schema.sql y migrations/');
    const url = urlBaseDeScript();
    if (!url) throw new Error('Falta DATABASE_URL');

    const cliente = new Client({ connectionString: url });
    await cliente.connect();
    // Candado de la base: si dos instancias arrancan a la vez (un despliegue nuevo mientras la
    // anterior sigue viva, o al escalar), la segunda espera a que la primera termine y despues
    // ve que no queda nada pendiente, en vez de aplicar las mismas migraciones en paralelo.
    await cliente.query('SELECT pg_advisory_lock($1)', [CANDADO_MIGRACIONES]);
    try {
        await cliente.query(`CREATE TABLE IF NOT EXISTS schema_migraciones (
            nombre TEXT PRIMARY KEY,
            aplicada_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);

        const marcarHasta = process.argv.indexOf('--marcar-hasta');
        if (marcarHasta !== -1) {
            const tope = process.argv[marcarHasta + 1];
            if (!/^\d{3}$/.test(tope || '')) throw new Error('Uso: --marcar-hasta 016');
            for (const nombre of ['schema.sql', ...migracionesDisponibles().filter((f) => f.slice(0, 3) <= tope)]) {
                await cliente.query('INSERT INTO schema_migraciones (nombre) VALUES ($1) ON CONFLICT DO NOTHING', [nombre]);
            }
            console.log(`Marcadas como aplicadas hasta la ${tope}. No se ejecuto ninguna.`);
            return;
        }

        const aplicadas = new Set((await cliente.query('SELECT nombre FROM schema_migraciones')).rows.map((r) => r.nombre));
        const hayTablas = (await cliente.query(
            "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'usuarios'"
        )).rows.length > 0;
        if (hayTablas && aplicadas.size === 0) {
            throw new Error(
                'La base ya tiene tablas pero no registro de migraciones: se creo a mano. '
                + 'Marca las que ya tiene con --marcar-hasta NNN antes de migrar.'
            );
        }

        const disponibles = migracionesDisponibles();
        const hasta = leerHasta(process.argv, disponibles);
        const pendientes = ['schema.sql', ...disponibles]
            .filter((n) => !aplicadas.has(n))
            .filter((n) => hasta === null || n === 'schema.sql' || n.slice(0, 3) <= hasta);
        if (pendientes.length === 0) {
            console.log('Base al dia: no hay migraciones pendientes.');
            return;
        }
        for (const nombre of pendientes) {
            const archivo = nombre === 'schema.sql'
                ? path.join(DIRECTORIO_DB, 'schema.sql')
                : path.join(DIRECTORIO_DB, 'migrations', nombre);
            await cliente.query('BEGIN');
            try {
                await cliente.query(fs.readFileSync(archivo, 'utf8'));
                await cliente.query('INSERT INTO schema_migraciones (nombre) VALUES ($1)', [nombre]);
                await cliente.query('COMMIT');
                console.log(`Aplicada ${nombre}`);
            } catch (err) {
                await cliente.query('ROLLBACK');
                throw new Error(`Fallo ${nombre}: ${err.message}`);
            }
        }
    } finally {
        await cliente.query('SELECT pg_advisory_unlock($1)', [CANDADO_MIGRACIONES]).catch(() => {});
        await cliente.end();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}

module.exports = { leerHasta };
