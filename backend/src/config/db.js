const { Pool } = require('pg');

// Limites de espera: sin ellos, una base lenta o una conexion colgada deja las peticiones esperando
// sin fin y agota el pool. Se pueden ajustar por variable de entorno sin tocar el codigo.
const numero = (valor, defecto) => {
    const n = Number(valor);
    return Number.isFinite(n) && n >= 0 ? n : defecto;
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // espera maxima por una conexion libre del pool o por abrir una nueva
    connectionTimeoutMillis: numero(process.env.DB_CONNECT_TIMEOUT_MS, 5000),
    // una consulta que pasa de esto se cancela en el servidor (la exportacion y la rentabilidad
    // quedan muy por debajo); 0 la desactiva
    statement_timeout: numero(process.env.DB_STATEMENT_TIMEOUT_MS, 30000),
    // una transaccion abierta sin actividad libera sus bloqueos a los 60 s
    idle_in_transaction_session_timeout: numero(process.env.DB_IDLE_TX_TIMEOUT_MS, 60000),
});

// Un error en una conexion ociosa (reinicio o mantenimiento de Postgres, corte de red) se emite
// como `error` del pool; sin oyente, Node lo trata como excepcion no atrapada y termina el
// proceso. El pool descarta esa conexion y abre otra en la siguiente consulta.
pool.on('error', (err) => {
    console.error('Error en una conexion ociosa de la base de datos:', err.message);
});

module.exports = pool;
