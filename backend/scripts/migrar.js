// Aplica el esquema y las migraciones pendientes de db/, en orden, una sola vez cada una.
//
//   node scripts/migrar.js
//
// En el servidor local las migraciones se aplicaban a mano con psql y nada registraba cuales
// ya habian corrido. En Railway no hay un servidor donde entrar a hacerlo: este script corre
// antes de cada despliegue (preDeployCommand en railway.json) y lleva el registro en la tabla
// schema_migraciones.
//
// Base vacia: aplica schema.sql y todas las migraciones.
// Base existente sin registro (la del servidor local, migrada a mano): se niega a tocarla,
// porque no puede saber cuales ya estan aplicadas. Para esa, marcar primero las que ya estan:
//
//   node scripts/migrar.js --marcar-hasta 016
//
// Cada migracion corre en su propia transaccion: si falla, no queda a medias ni registrada.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// en el repositorio db/ esta junto a backend/; en la imagen de Docker se copia a /db
const DIRECTORIO_DB = [path.join(__dirname, '../../db'), '/db'].find((d) => fs.existsSync(d));

function migracionesDisponibles() {
    return fs.readdirSync(path.join(DIRECTORIO_DB, 'migrations'))
        .filter((f) => /^\d{3}_.*\.sql$/.test(f))
        .sort();
}

async function main() {
    if (!DIRECTORIO_DB) throw new Error('No se encontro el directorio db/ con schema.sql y migrations/');
    if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');

    const cliente = new Client({ connectionString: process.env.DATABASE_URL });
    await cliente.connect();
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

        const pendientes = ['schema.sql', ...migracionesDisponibles()].filter((n) => !aplicadas.has(n));
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
        await cliente.end();
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
