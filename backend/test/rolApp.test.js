// Rol limitado `gomaq_app` (migracion 041): puede leer y escribir filas, pero no cambiar el esquema ni
// reescribir el historial de ordenes. Usa SET ROLE dentro de una transaccion que se deshace; necesita
// Postgres y que quien corre la prueba pueda asumir el rol (superusuario, como en el CI).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '041_rol_app.sql'), 'utf8');

test('migracion 041: crea el rol sin login y no usa permisos amplios', () => {
    assert.match(sql, /CREATE ROLE gomaq_app NOLOGIN/);
    assert.doesNotMatch(sql, /SUPERUSER|CREATEDB|CREATEROLE|\bALL PRIVILEGES\b|GRANT CREATE/i);
    assert.match(sql, /REVOKE UPDATE, DELETE ON ordenes_eventos FROM gomaq_app/);
    assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON schema_migraciones FROM gomaq_app/);
});

test('migrar.js y los scripts de carga prefieren DATABASE_URL_MIGRACION', () => {
    for (const f of ['migrar.js', 'cargar_demo.js', 'cargar_clientes.js', 'cargar_equipos.js']) {
        const texto = fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8');
        assert.match(texto, /DATABASE_URL_MIGRACION \|\| process\.env\.DATABASE_URL/, f);
        assert.doesNotMatch(texto.replace(/DATABASE_URL_MIGRACION \|\| process\.env\.DATABASE_URL/g, ''), /new Client\(\{ connectionString: process\.env\.DATABASE_URL/, f);
    }
});

test('migracion 042: deja apagados los atributos de privilegio del rol', async (t) => {
    const sql042 = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '042_rol_app_atributos.sql'), 'utf8');
    assert.match(sql042, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
    if (process.env.GOMAQ_TEST_ESCRITURA !== '1') return t.skip('necesita Postgres (GOMAQ_TEST_ESCRITURA=1)');
    const pool = require('../src/config/db');
    {
        const r = await pool.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'gomaq_app'");
        assert.deepStrictEqual(r.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    }
});

test('el rol puede escribir filas pero no cambiar el esquema ni el historial', async (t) => {
    if (process.env.GOMAQ_TEST_ESCRITURA !== '1') return t.skip('necesita Postgres (GOMAQ_TEST_ESCRITURA=1)');
    const pool = require('../src/config/db');
    const c = await pool.connect();
    const denegado = async (consulta) => {
        await c.query('SAVEPOINT s');
        try {
            await c.query(consulta);
        } catch (err) {
            await c.query('ROLLBACK TO SAVEPOINT s');
            assert.strictEqual(err.code, '42501', `${consulta}: ${err.message}`);
            return;
        }
        throw new Error(`debia negarse: ${consulta}`);
    };
    try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE gomaq_app');
        // lo normal sigue funcionando
        await c.query('SELECT count(*) FROM usuarios');
        await c.query("INSERT INTO configuracion (clave, valor) VALUES ('prueba_rol_app', '1')");
        await c.query("UPDATE configuracion SET valor = '2' WHERE clave = 'prueba_rol_app'");
        await c.query("DELETE FROM configuracion WHERE clave = 'prueba_rol_app'");
        // lo peligroso no
        await denegado('CREATE TABLE prueba_rol_app (id int)');
        await denegado('ALTER TABLE usuarios ADD COLUMN prueba_rol_app int');
        await denegado('DROP TABLE configuracion');
        await denegado('TRUNCATE usuarios');
        await denegado("UPDATE ordenes_eventos SET tipo = tipo WHERE false");
        await denegado('DELETE FROM ordenes_eventos WHERE false');
        await denegado("INSERT INTO schema_migraciones (nombre) VALUES ('999_prueba.sql')");
    } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
        await pool.end();
    }
});
