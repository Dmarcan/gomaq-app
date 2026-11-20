const test = require('node:test');
const assert = require('node:assert/strict');
const { USUARIOS, leerClaves } = require('../scripts/usuarios-demo');

// Las contrasenas demo no viven en el repositorio: el script las lee del entorno y debe fallar
// con un mensaje claro si faltan.
const entornoCompleto = () => Object.fromEntries(USUARIOS.map((u, i) => [u.variable, `clave-de-prueba-${i}`]));

test('leerClaves devuelve la clave de cada usuario desde el entorno', () => {
    const claves = leerClaves(entornoCompleto());
    for (const [i, u] of USUARIOS.entries()) assert.equal(claves[u.email], `clave-de-prueba-${i}`);
});

test('leerClaves falla nombrando las variables que faltan', () => {
    const env = entornoCompleto();
    delete env.GOMAQ_DEMO_CLAVE_MECANICO;
    assert.throws(() => leerClaves(env), /GOMAQ_DEMO_CLAVE_MECANICO/);
    assert.throws(() => leerClaves({}), /GOMAQ_DEMO_CLAVE_ADMINISTRATIVO/);
});

test('leerClaves rechaza claves de menos de 8 caracteres', () => {
    const env = { ...entornoCompleto(), GOMAQ_DEMO_CLAVE_CLIENTE: 'corta' };
    assert.throws(() => leerClaves(env), /GOMAQ_DEMO_CLAVE_CLIENTE/);
});
