// Proceso aparte para el worker de notificaciones (servicio `gomaq-worker` en Railway).
//
//   node scripts/worker.js
//
// Corre el mismo worker que antes vivia dentro de la API (server.js), pero sin servidor HTTP: asi
// un despliegue del panel o de la API no corta envios a medio camino, y un proveedor lento no
// comparte proceso con las peticiones de los usuarios. No aplica migraciones (eso lo hace la API
// al arrancar); si el esquema aun no esta al dia, el worker simplemente reintenta en el
// siguiente ciclo.
//
// Arrancar con `node` directo y no con `npm start`: npm no reenvia SIGTERM al proceso hijo y el
// cierre ordenado de abajo no correria.

// misma zona horaria que la API (ver server.js)
process.env.TZ = 'America/Santiago';

require('dotenv').config();

// Cuando exista el proveedor, agregar aca sus claves (por ejemplo WHATSAPP_TOKEN).
const VARIABLES_REQUERIDAS = ['DATABASE_URL'];
const faltantes = VARIABLES_REQUERIDAS.filter((v) => !process.env[v]);
if (faltantes.length > 0) {
    console.error(`Faltan variables de entorno obligatorias: ${faltantes.join(', ')}. Revisa el .env`);
    process.exit(1);
}

const pool = require('../src/config/db');
const { iniciarWorker } = require('../src/workers/notificaciones');

// un error en una conexion inactiva del pool (por ejemplo Postgres reiniciando) no debe tumbar el proceso
pool.on('error', (err) => console.error('[worker] error en el pool de Postgres:', err.message));

const detener = iniciarWorker();

let apagando = false;
async function apagar(senal) {
    if (apagando) return;
    apagando = true;
    console.log(`[worker] ${senal} recibida, cerrando`);
    try {
        await detener();
        await pool.end();
        process.exit(0);
    } catch (err) {
        console.error('[worker] error al cerrar:', err);
        process.exit(1);
    }
}
process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
