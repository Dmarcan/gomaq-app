// Transaccion de base de datos con una sola forma de abrirla, cerrarla y soltar la conexion.
//
//   await conTransaccion(pool, async (client, { confirmar, deshacer }) => {
//       ...consultas con `client`...
//   });
//
// - Si la funcion termina, se hace COMMIT; si lanza un error, ROLLBACK y el error sigue su camino.
// - `deshacer()` cierra la transaccion con ROLLBACK antes de tiempo (una validacion que falla); lo que
//   venga despues ya no se confirma.
// - `confirmar()` hace el COMMIT en ese punto, para responder o avisar recien despues de confirmar.
// - La conexion siempre vuelve al pool.
// `pool` se recibe como argumento porque varias utilidades lo reciben inyectado (y asi se prueba sin base).

/**
 * @param {{ connect: () => Promise<{ query: Function, release: Function }> }} pool
 * @param {(client: object, control: { confirmar: () => Promise<void>, deshacer: () => Promise<void> }) => Promise<any>} fn
 * @param {{ inicio?: string }} [opciones] `inicio` reemplaza al BEGIN (por ejemplo con un nivel de aislamiento).
 * @returns {Promise<any>} lo que devuelva `fn`.
 */
async function conTransaccion(pool, fn, { inicio = 'BEGIN' } = {}) {
    const client = await pool.connect();
    let abierta = false;
    try {
        await client.query(inicio);
        abierta = true;
        const control = {
            confirmar: async () => {
                if (!abierta) return;
                await client.query('COMMIT');
                abierta = false;
            },
            deshacer: async () => {
                if (!abierta) return;
                await client.query('ROLLBACK');
                abierta = false;
            },
        };
        const resultado = await fn(client, control);
        await control.confirmar();
        return resultado;
    } catch (err) {
        if (abierta) await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { conTransaccion };
