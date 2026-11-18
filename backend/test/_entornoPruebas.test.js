// Guarda de entorno de las pruebas: no necesita base de datos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirBaseLocal } = require('./_entornoPruebas');

const VARIABLES = ['DATABASE_URL', 'DATABASE_URL_MIGRACION', 'GOMAQ_TEST_HOST_PERMITIDO', 'ORS_API_KEY', 'RESEND_API_KEY'];

/** Corre `fn` con el entorno indicado y lo restaura despues, pase lo que pase. */
function conEntorno(valores, fn) {
    const guardado = Object.fromEntries(VARIABLES.map((v) => [v, process.env[v]]));
    for (const v of VARIABLES) delete process.env[v];
    Object.assign(process.env, valores);
    try {
        return fn();
    } finally {
        for (const v of VARIABLES) {
            if (guardado[v] === undefined) delete process.env[v]; else process.env[v] = guardado[v];
        }
    }
}

test('una base remota hace fallar la guarda', () => {
    conEntorno({ DATABASE_URL: 'postgres://u:p@algo.rlwy.net:5432/x' }, () => {
        assert.throws(() => exigirBaseLocal(), /solo corren contra una base local/);
    });
});

test('localhost, 127.0.0.1 y ::1 pasan', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        conEntorno({ DATABASE_URL: `postgres://u:p@${host}:5432/x` }, () => {
            assert.doesNotThrow(() => exigirBaseLocal(), host);
        });
    }
});

test('sin ninguna URL no lanza', () => {
    conEntorno({}, () => assert.doesNotThrow(() => exigirBaseLocal()));
});

test('DATABASE_URL_MIGRACION remota falla aunque DATABASE_URL sea local', () => {
    conEntorno({
        DATABASE_URL: 'postgres://u:p@localhost:5432/x',
        DATABASE_URL_MIGRACION: 'postgres://u:p@algo.rlwy.net:5432/x',
    }, () => {
        assert.throws(() => exigirBaseLocal(), /DATABASE_URL_MIGRACION/);
    });
});

test('GOMAQ_TEST_HOST_PERMITIDO habilita un host concreto y solo ese', () => {
    conEntorno({ DATABASE_URL: 'postgres://u:p@base.prueba.example:5432/x', GOMAQ_TEST_HOST_PERMITIDO: 'base.prueba.example' }, () => {
        assert.doesNotThrow(() => exigirBaseLocal());
    });
    conEntorno({ DATABASE_URL: 'postgres://u:p@otra.example:5432/x', GOMAQ_TEST_HOST_PERMITIDO: 'base.prueba.example' }, () => {
        assert.throws(() => exigirBaseLocal());
    });
});

test('borra las llaves de servicios externos', () => {
    conEntorno({ DATABASE_URL: 'postgres://u:p@localhost:5432/x', ORS_API_KEY: 'a', RESEND_API_KEY: 'b' }, () => {
        exigirBaseLocal();
        assert.equal(process.env.ORS_API_KEY, undefined);
        assert.equal(process.env.RESEND_API_KEY, undefined);
    });
});
