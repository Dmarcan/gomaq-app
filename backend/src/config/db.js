const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// Un error en una conexion ociosa (reinicio o mantenimiento de Postgres, corte de red) se emite
// como `error` del pool; sin oyente, Node lo trata como excepcion no atrapada y termina el
// proceso. El pool descarta esa conexion y abre otra en la siguiente consulta.
pool.on('error', (err) => {
    console.error('Error en una conexion ociosa de la base de datos:', err.message);
});

module.exports = pool;
