// Retencion de datos personales (utils/retencion.js).
//   node scripts/retencion.js              cuenta lo que se borraria (no toca nada)
//   node scripts/retencion.js --ejecutar   borra lo vencido, en una transaccion
// En produccion: railway ssh --service gomaq-app -- node scripts/retencion.js
// Para --ejecutar hace falta el permiso de borrado (el rol limitado gomaq_app lo tiene en estas tablas).
require('dotenv').config();
const { Client } = require('pg');
const { urlBaseDeScript } = require('./_conexion');
const { PLAZOS_DIAS, contarRetencion, ejecutarRetencion } = require('../src/utils/retencion');

(async () => {
    const url = urlBaseDeScript();
    if (!url) throw new Error('Falta DATABASE_URL');
    const ejecutar = process.argv.includes('--ejecutar');
    console.log('Plazos (dias):', JSON.stringify(PLAZOS_DIAS));
    if (!ejecutar) {
        const db = new Client({ connectionString: url });
        await db.connect();
        try {
            console.log('SIMULACION, no se borra nada. Se borraria:', JSON.stringify(await contarRetencion(db)));
        } finally {
            await db.end();
        }
        return;
    }
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
        console.log('Borrado:', JSON.stringify(await ejecutarRetencion(pool)));
    } finally {
        await pool.end();
    }
})().catch((err) => { console.error('ERROR:', err.message); process.exit(1); });
