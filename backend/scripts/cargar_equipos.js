// Carga el inventario real de equipos (db/datos/equipos_gomaq.json) en la tabla maquinarias.
//
//   node scripts/cargar_equipos.js --simular   # inserta dentro de una transaccion y la deshace
//   node scripts/cargar_equipos.js             # carga de verdad
//
// El JSON sale del Excel "detalle equipos gomaq" (status al 2026-07-20) mas los equipos nuevos del
// Excel "Status Equipos GOMAQ" (status al 2026-11-13). El codigo de cada equipo
// es un prefijo por tipo mas su N. interno (GH-501, TP-2013...): el N. interno 2013 existia en una
// grua horquilla y en una traspaleta, y `codigo` es unico.
//
// Se puede correr varias veces: un codigo que ya existe no se toca (ni se sobrescribe lo que
// alguien haya editado desde el panel). En Railway la base no tiene acceso publico, asi que se
// corre dentro del contenedor:  railway ssh --service gomaq-app -- node scripts/cargar_equipos.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ARCHIVO = [path.join(__dirname, '../../db/datos'), '/db/datos']
    .map((d) => path.join(d, 'equipos_gomaq.json'))
    .find((f) => fs.existsSync(f));

async function main() {
    if (!ARCHIVO) throw new Error('No se encontro db/datos/equipos_gomaq.json');
    if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
    const simular = process.argv.includes('--simular');
    const { equipos } = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));

    const cliente = new Client({ connectionString: process.env.DATABASE_URL });
    await cliente.connect();
    let nuevos = 0;
    const existentes = [];
    try {
        await cliente.query('BEGIN');
        const antes = await cliente.query('SELECT COUNT(*)::int AS n FROM maquinarias');
        for (const e of equipos) {
            const r = await cliente.query(
                `INSERT INTO maquinarias (
                    codigo, tipo, categoria_equipo, marca, modelo, descripcion,
                    capacidad_carga, altura_trabajo, tipo_combustible, numero_serie, anio
                 ) VALUES ($1, $2, $3::categoria_equipo, $4, $5, $6, $7, $8, $9::tipo_combustible_maquinaria, $10, $11)
                 ON CONFLICT (codigo) DO NOTHING`,
                [e.codigo, e.tipo, e.categoria_equipo, e.marca, e.modelo, e.descripcion,
                 e.capacidad_carga, e.altura_trabajo, e.tipo_combustible,
                 e.numero_serie ?? null, e.anio ?? null]
            );
            if (r.rowCount === 1) nuevos++;
            else existentes.push(e.codigo);
        }
        const total = await cliente.query('SELECT COUNT(*)::int AS n FROM maquinarias');
        console.log(`${equipos.length} en el archivo: ${nuevos} nuevos, ${existentes.length} ya existian` +
            (existentes.length ? ` (${existentes.join(', ')})` : ''));
        console.log(`maquinarias: ${antes.rows[0].n} antes, ${total.rows[0].n} ${simular ? 'si se guardara' : 'despues'}`);
        if (simular) {
            await cliente.query('ROLLBACK');
            console.log('Simulacion: no se guardo nada.');
        } else {
            await cliente.query('COMMIT');
            console.log('Guardado.');
        }
    } catch (err) {
        await cliente.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        await cliente.end();
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
