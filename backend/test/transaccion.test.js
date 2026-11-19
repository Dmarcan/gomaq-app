const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { conTransaccion } = require('../src/utils/transaccion');

/** Pool falso: anota cada consulta y cada liberacion; `fallar` hace fallar la consulta que contenga ese texto. */
function poolFalso({ fallar } = {}) {
    const registro = [];
    const client = {
        query: async (texto) => {
            registro.push(texto);
            if (fallar && texto === fallar) throw new Error(`fallo simulado en ${texto}`);
            return { rows: [] };
        },
        release: () => registro.push('release'),
    };
    return { registro, pool: { connect: async () => client } };
}

describe('conTransaccion', () => {
    test('confirma al terminar, devuelve el resultado y suelta la conexion', async () => {
        const { pool, registro } = poolFalso();
        const r = await conTransaccion(pool, async (client) => {
            await client.query('INSERT 1');
            return 42;
        });
        assert.equal(r, 42);
        assert.deepEqual(registro, ['BEGIN', 'INSERT 1', 'COMMIT', 'release']);
    });

    test('un error deshace, se propaga tal cual y suelta la conexion', async () => {
        const { pool, registro } = poolFalso();
        const falla = new Error('boom');
        await assert.rejects(
            conTransaccion(pool, async (client) => {
                await client.query('INSERT 1');
                throw falla;
            }),
            (e) => e === falla
        );
        assert.deepEqual(registro, ['BEGIN', 'INSERT 1', 'ROLLBACK', 'release']);
    });

    test('deshacer cierra con ROLLBACK y el final no confirma', async () => {
        const { pool, registro } = poolFalso();
        const r = await conTransaccion(pool, async (client, { deshacer }) => {
            await client.query('SELECT 1');
            await deshacer();
            return 'rechazado';
        });
        assert.equal(r, 'rechazado');
        assert.deepEqual(registro, ['BEGIN', 'SELECT 1', 'ROLLBACK', 'release']);
    });

    test('un error despues de deshacer no repite el ROLLBACK', async () => {
        const { pool, registro } = poolFalso();
        await assert.rejects(conTransaccion(pool, async (_client, { deshacer }) => {
            await deshacer();
            throw new Error('tarde');
        }), /tarde/);
        assert.deepEqual(registro, ['BEGIN', 'ROLLBACK', 'release']);
    });

    test('confirmar hace el COMMIT en ese punto y lo que sigue corre ya confirmado', async () => {
        const { pool, registro } = poolFalso();
        await conTransaccion(pool, async (client, { confirmar }) => {
            await client.query('UPDATE 1');
            await confirmar();
            registro.push('respuesta');
        });
        assert.deepEqual(registro, ['BEGIN', 'UPDATE 1', 'COMMIT', 'respuesta', 'release']);
    });

    test('si falla el COMMIT intenta el ROLLBACK, propaga el error y suelta la conexion', async () => {
        const { pool, registro } = poolFalso({ fallar: 'COMMIT' });
        await assert.rejects(conTransaccion(pool, async () => 1), /fallo simulado en COMMIT/);
        assert.deepEqual(registro, ['BEGIN', 'COMMIT', 'ROLLBACK', 'release']);
    });

    test('inicio reemplaza al BEGIN', async () => {
        const { pool, registro } = poolFalso();
        await conTransaccion(pool, async () => {}, { inicio: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' });
        assert.equal(registro[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    });

    test('si no hay conexion el error sale sin intentar nada mas', async () => {
        const pool = { connect: async () => { throw new Error('sin conexion'); } };
        await assert.rejects(conTransaccion(pool, async () => 1), /sin conexion/);
    });

    test('si falla el BEGIN no hay ROLLBACK (no se abrio nada) y la conexion se suelta', async () => {
        const { pool, registro } = poolFalso({ fallar: 'BEGIN' });
        await assert.rejects(conTransaccion(pool, async () => 1), /fallo simulado en BEGIN/);
        assert.deepEqual(registro, ['BEGIN', 'release']);
    });
});
