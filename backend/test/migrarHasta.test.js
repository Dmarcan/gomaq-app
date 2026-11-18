// Opcion --hasta de scripts/migrar.js (sin base de datos). Sin la opcion el script debe seguir
// aplicando todo, como en cada despliegue: leerHasta devuelve null y no filtra nada.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { leerHasta } = require('../scripts/migrar');

const disponibles = ['001_a.sql', '041_rol_app.sql', '042_rol_app_atributos.sql'];

test('sin --hasta no hay tope', () => {
    assert.strictEqual(leerHasta(['node', 'migrar.js'], disponibles), null);
});

test('--hasta con un numero existente devuelve ese numero', () => {
    assert.strictEqual(leerHasta(['node', 'migrar.js', '--hasta', '041'], disponibles), '041');
});

test('--hasta sin valor, con formato invalido o sin ceros falla con un mensaje claro', () => {
    for (const argv of [['--hasta'], ['--hasta', '42'], ['--hasta', 'abc'], ['--hasta', '0421'], ['--hasta', '']]) {
        assert.throws(() => leerHasta(['node', 'migrar.js', ...argv], disponibles), /Uso: --hasta/);
    }
});

test('--hasta con un numero que no existe falla', () => {
    assert.throws(() => leerHasta(['node', 'migrar.js', '--hasta', '999'], disponibles), /no existe una migracion/);
});

test('--marcar-hasta no se confunde con --hasta', () => {
    assert.strictEqual(leerHasta(['node', 'migrar.js', '--marcar-hasta', '016'], disponibles), null);
});

test('la version base del fixture existe entre las migraciones', () => {
    const fuente = fs.readFileSync(path.join(__dirname, '../scripts/probar_migraciones_con_datos.js'), 'utf8');
    const base = /MIGRACIONES_VERSION_BASE \|\| '(\d{3})'/.exec(fuente)[1];
    const migraciones = fs.readdirSync(path.join(__dirname, '../../db/migrations'));
    assert.ok(migraciones.some((f) => f.startsWith(`${base}_`)), `la migracion base ${base} no existe`);
});
