// Prueba que las migraciones se apliquen sobre una base que ya tiene filas.
//
//   node scripts/probar_migraciones_con_datos.js
//
// El CI ya prueba las migraciones sobre una base vacia (node scripts/migrar.js), pero en produccion
// siempre hay filas: una columna NOT NULL sin default o una restriccion nueva pasa en vacio y
// rompe el despliegue. Este script, sobre una base aparte que crea y borra (no toca la de las
// pruebas):
//   1. aplica el esquema y las migraciones hasta VERSION_BASE (migrar.js --hasta),
//   2. carga db/scripts/fixture_migraciones_base.sql,
//   3. aplica las migraciones posteriores a la base,
//   4. verifica que las filas del fixture siguen ahi.
// Con cero migraciones posteriores a la base solo avisa y comprueba que el fixture carga.
//
// Usa DATABASE_URL (o DATABASE_URL_MIGRACION) para conectarse al servidor; el rol debe poder
// crear bases de datos. Para subir VERSION_BASE ver el comentario de
// db/scripts/fixture_migraciones_base.sql. Variable opcional MIGRACIONES_VERSION_BASE solo para
// probar el mecanismo en local con otra base.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const { urlBaseDeScript } = require('./_conexion');

const VERSION_BASE = process.env.MIGRACIONES_VERSION_BASE || '042';
// nombre unico por ejecucion: nunca se borra una base que ya existia en el servidor
const NOMBRE_BASE_PRUEBA = `gomaq_migraciones_con_datos_${process.pid}_${Date.now()}`;
const DB = path.join(__dirname, '../../db');
const MIGRAR = path.join(__dirname, 'migrar.js');
const FIXTURE = process.env.MIGRACIONES_FIXTURE || path.join(DB, 'scripts/fixture_migraciones_base.sql');

function urlConBase(url, nombre) {
    const u = new URL(url);
    u.pathname = `/${nombre}`;
    return u.toString();
}

function migrar(url, args) {
    const r = spawnSync(process.execPath, [MIGRAR, ...args], {
        env: { ...process.env, DATABASE_URL: url, DATABASE_URL_MIGRACION: '' },
        encoding: 'utf8',
    });
    process.stdout.write(r.stdout || '');
    if (r.status !== 0) throw new Error(`migrar.js ${args.join(' ')} fallo:\n${r.stderr}`);
}

async function main() {
    const urlServidor = urlBaseDeScript();
    if (!urlServidor) throw new Error('Falta DATABASE_URL');
    const todas = fs.readdirSync(path.join(DB, 'migrations')).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    if (!todas.some((f) => f.startsWith(`${VERSION_BASE}_`))) {
        throw new Error(`La version base ${VERSION_BASE} no existe entre las migraciones`);
    }
    const posteriores = todas.filter((f) => f.slice(0, 3) > VERSION_BASE);

    const admin = new Client({ connectionString: urlServidor });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${NOMBRE_BASE_PRUEBA}`);
    const url = urlConBase(urlServidor, NOMBRE_BASE_PRUEBA);
    try {
        console.log(`Migrando una base vacia hasta la version base ${VERSION_BASE}...`);
        migrar(url, ['--hasta', VERSION_BASE]);

        const c = new Client({ connectionString: url });
        await c.connect();
        try {
            await c.query(fs.readFileSync(FIXTURE, 'utf8'));
            const conteo = async () => {
                const tablas = (await c.query(
                    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migraciones' ORDER BY 1"
                )).rows.map((r) => r.table_name);
                const out = {};
                for (const t of tablas) out[t] = Number((await c.query(`SELECT count(*) FROM "${t}"`)).rows[0].count);
                return out;
            };
            const antes = await conteo();
            const conFilas = Object.keys(antes).filter((t) => antes[t] > 0);
            if (conFilas.length < 15) throw new Error(`El fixture dejo filas en solo ${conFilas.length} tablas: se esperaban al menos 15`);
            console.log(`Fixture cargado: ${conFilas.length} tablas con filas.`);

            if (posteriores.length === 0) {
                console.log('Sin migraciones posteriores a la base: solo se comprobo que el fixture carga.');
            } else {
                console.log(`Aplicando ${posteriores.length} migracion(es) posterior(es) a la base con datos...`);
                migrar(url, []);
                const despues = await conteo();
                for (const t of conFilas) {
                    if (despues[t] === undefined) continue; // la migracion pudo renombrar o borrar la tabla a proposito
                    if (despues[t] < antes[t]) throw new Error(`La tabla ${t} perdio filas: ${antes[t]} antes, ${despues[t]} despues`);
                }
                console.log('Las filas del fixture siguen ahi.');
            }
        } finally {
            await c.end();
        }
    } finally {
        await admin.query(`DROP DATABASE IF EXISTS ${NOMBRE_BASE_PRUEBA} WITH (FORCE)`).catch(() => {});
        await admin.end();
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
