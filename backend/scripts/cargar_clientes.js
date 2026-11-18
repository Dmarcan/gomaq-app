// Carga los clientes de db/datos/clientes_gomaq.json en la tabla clientes, y crea los ejecutivos
// Freddy, Alejandra, Wenceslao y Oscar si no existen (para asignarles sus clientes).
//
//   node scripts/cargar_clientes.js --simular   # hace todo dentro de una transaccion y la deshace
//   node scripts/cargar_clientes.js             # carga de verdad
//   node scripts/cargar_clientes.js --archivo ruta/otro.json   # para las pruebas
//
// Reglas:
// - Todo corre en una transaccion con pg_advisory_xact_lock: dos corridas a la vez no se pisan.
// - Idempotente: un cliente cuyo RUT ya existe (comparado sin puntos ni guion, en SQL) no se toca ni se
//   sobrescribe; un ejecutivo que ya existe no se duplica.
// - Los clientes entran SIN correo ni telefono: el sistema no les manda ningun aviso hasta que alguien
//   escriba su correo desde el panel. Un registro con esos campos se rechaza y no se inserta nada.
// - Los clientes cuyo vendedor no es uno de los cuatro (o no tiene) quedan sin ejecutivo.
// - plazo_pago_dias viene solo donde las facturas siempre tuvieron el mismo plazo; el resto queda nulo.
//
// En Railway la base no tiene acceso publico, asi que se corre dentro del contenedor:
//   railway ssh --service gomaq-app -- node scripts/cargar_clientes.js --simular

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { urlBaseDeScript } = require('./_conexion');
const { EJECUTIVOS_A_CREAR, validarArchivo, resolverEjecutivo } = require('../src/utils/cargaClientes');

// numero arbitrario pero fijo del candado de esta carga (el de migrar.js es 70214)
const CANDADO_CARGA_CLIENTES = 70215;

const SQL_RUT_NORMALIZADO = "upper(regexp_replace(rut, '[^0-9kK]', '', 'g'))";

function buscarArchivo() {
    return [path.join(__dirname, '../../db/datos'), '/db/datos']
        .map((d) => path.join(d, 'clientes_gomaq.json'))
        .find((f) => fs.existsSync(f));
}

/**
 * Carga `clientes` usando un Client de pg ya conectado. Devuelve los conteos.
 * Con simular = true deshace todo al final; con un error tambien (y lo relanza).
 */
async function cargarClientes(db, clientes, { simular = false } = {}) {
    const { errores } = validarArchivo(clientes);
    if (errores.length) {
        const e = new Error(`El archivo no es valido, no se inserto nada:\n- ${errores.slice(0, 20).join('\n- ')}`);
        e.codigo = 'archivo_invalido';
        throw e;
    }
    const resumen = {
        enArchivo: clientes.length, nuevos: 0, yaExistian: 0, antes: 0, despues: 0,
        ejecutivosCreados: [], ejecutivosExistentes: [],
        porEjecutivo: {}, sinEjecutivo: 0, conPlazo: 0, simular,
    };
    await db.query('BEGIN');
    try {
        await db.query('SELECT pg_advisory_xact_lock($1)', [CANDADO_CARGA_CLIENTES]);
        resumen.antes = (await db.query('SELECT COUNT(*)::int AS n FROM clientes')).rows[0].n;

        // ejecutivos: se crean los que falten
        let lista = (await db.query('SELECT id, nombre FROM ejecutivos ORDER BY id')).rows;
        const idPorNombre = new Map();
        for (const nombre of EJECUTIVOS_A_CREAR) {
            const r = resolverEjecutivo(nombre, lista);
            if (r.estado === 'ambiguo') {
                throw new Error(`Hay mas de un ejecutivo que coincide con "${nombre}": se detiene sin tocar nada`);
            }
            if (r.estado === 'uno') {
                idPorNombre.set(nombre, r.id);
                resumen.ejecutivosExistentes.push(nombre);
            } else {
                const ins = await db.query('INSERT INTO ejecutivos (nombre) VALUES ($1) RETURNING id, nombre', [nombre]);
                idPorNombre.set(nombre, ins.rows[0].id);
                lista = lista.concat(ins.rows[0]);
                resumen.ejecutivosCreados.push(nombre);
            }
        }

        for (const c of clientes) {
            const ejecutivoId = c.ejecutivo ? idPorNombre.get(c.ejecutivo) : null;
            const r = await db.query(
                `INSERT INTO clientes (nombre, rut, direccion, giro, plazo_pago_dias, ejecutivo_id, email, telefono)
                 SELECT $1::varchar, $2::varchar, $3::text, $4::varchar, $5::integer, $6::integer, NULL, NULL
                  WHERE NOT EXISTS (
                      SELECT 1 FROM clientes
                       WHERE rut IS NOT NULL
                         AND ${SQL_RUT_NORMALIZADO} = upper(regexp_replace($2::varchar, '[^0-9kK]', '', 'g'))
                  )`,
                [c.nombre, c.rut, c.direccion ?? null, c.giro ?? null, c.plazo_pago_dias ?? null, ejecutivoId ?? null]
            );
            if (r.rowCount === 1) {
                resumen.nuevos++;
                if (c.ejecutivo) resumen.porEjecutivo[c.ejecutivo] = (resumen.porEjecutivo[c.ejecutivo] || 0) + 1;
                else resumen.sinEjecutivo++;
                if (c.plazo_pago_dias !== null && c.plazo_pago_dias !== undefined) resumen.conPlazo++;
            } else {
                resumen.yaExistian++;
            }
        }
        resumen.despues = (await db.query('SELECT COUNT(*)::int AS n FROM clientes')).rows[0].n;
        await db.query(simular ? 'ROLLBACK' : 'COMMIT');
    } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
    }
    return resumen;
}

function imprimir(r) {
    console.log(`${r.enArchivo} clientes en el archivo: ${r.nuevos} nuevos, ${r.yaExistian} ya existian (no se tocaron)`);
    console.log(`Ejecutivos creados: ${r.ejecutivosCreados.join(', ') || 'ninguno'}; ya existian: ${r.ejecutivosExistentes.join(', ') || 'ninguno'}`);
    const partes = Object.entries(r.porEjecutivo).map(([n, c]) => `${n} ${c}`);
    console.log(`Clientes nuevos por ejecutivo: ${partes.join(', ') || 'ninguno'}; sin ejecutivo ${r.sinEjecutivo}`);
    console.log(`Clientes nuevos con plazo de pago: ${r.conPlazo}; sin plazo ${r.nuevos - r.conPlazo}`);
    console.log(`clientes: ${r.antes} antes, ${r.despues} ${r.simular ? 'si se guardara' : 'despues'}`);
    console.log(r.simular ? 'Simulacion: no se guardo nada.' : 'Guardado.');
}

async function main() {
    const argv = process.argv.slice(2);
    const simular = argv.includes('--simular');
    const i = argv.indexOf('--archivo');
    const archivo = i >= 0 ? argv[i + 1] : buscarArchivo();
    if (!archivo || !fs.existsSync(archivo)) throw new Error('No se encontro db/datos/clientes_gomaq.json (no se versiona: pidelo a David; el formato esta en clientes_gomaq.ejemplo.json)');
    const url = urlBaseDeScript();
    if (!url) throw new Error('Falta DATABASE_URL');
    const { clientes } = JSON.parse(fs.readFileSync(archivo, 'utf8'));

    const db = new Client({ connectionString: url });
    await db.connect();
    try {
        imprimir(await cargarClientes(db, clientes, { simular }));
    } finally {
        await db.end();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error(err.message);
        process.exit(1);
    });
}

module.exports = { cargarClientes, CANDADO_CARGA_CLIENTES };
