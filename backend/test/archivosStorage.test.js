const test = require('node:test');
const assert = require('node:assert/strict');
const { borrarArchivoSubido } = require('../src/utils/archivosStorage');

/** Cliente de Storage falso: `remove` responde lo que se le diga. */
function clienteFalso(respuesta) {
    const llamadas = [];
    return {
        llamadas,
        storage: {
            from: (bucket) => ({
                remove: async (rutas) => {
                    llamadas.push({ bucket, rutas });
                    if (respuesta instanceof Error) throw respuesta;
                    return respuesta;
                },
            }),
        },
    };
}

/** Captura lo que se escribe en console.error durante la prueba. */
async function conLog(fn) {
    const original = console.error;
    const lineas = [];
    console.error = (...args) => lineas.push(args.join(' '));
    try {
        return { resultado: await fn(), lineas };
    } finally {
        console.error = original;
    }
}

test('borra el archivo del bucket indicado y devuelve true', async () => {
    const c = clienteFalso({ data: [{}], error: null });
    const { resultado, lineas } = await conLog(() => borrarArchivoSubido('documentos-gomaq', 'facturas/1/a.pdf', c));
    assert.equal(resultado, true);
    assert.deepEqual(c.llamadas, [{ bucket: 'documentos-gomaq', rutas: ['facturas/1/a.pdf'] }]);
    assert.deepEqual(lineas, []);
});

test('un error del servicio (la libreria no rechaza, devuelve { error }) queda en el log y no lanza', async () => {
    const c = clienteFalso({ data: null, error: new Error('Bucket not found') });
    const { resultado, lineas } = await conLog(() => borrarArchivoSubido('documentos-gomaq', 'facturas/1/a.pdf', c));
    assert.equal(resultado, false);
    assert.equal(lineas.length, 1);
    assert.match(lineas[0], /documentos-gomaq\/facturas\/1\/a\.pdf/);
    assert.match(lineas[0], /Bucket not found/);
});

test('una excepcion de red queda en el log y no lanza', async () => {
    const c = clienteFalso(new Error('fetch failed'));
    const { resultado, lineas } = await conLog(() => borrarArchivoSubido('equipos-gomaq', 'fotos/9.jpg', c));
    assert.equal(resultado, false);
    assert.equal(lineas.length, 1);
    assert.match(lineas[0], /fetch failed/);
});
