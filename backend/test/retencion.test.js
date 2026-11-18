// Retencion de datos personales: reglas, plazos y que no toque lo que no debe. Con Postgres (GOMAQ_TEST_ESCRITURA=1).
const test = require('node:test');
const { exigirBaseLocal } = require('./_entornoPruebas');
const assert = require('node:assert');
const { PLAZOS_DIAS, REGLAS, validarPlazos, contarRetencion, ejecutarRetencion, iniciarRetencion } = require('../src/utils/retencion');

test('plazos acordados y validacion', () => {
    assert.deepStrictEqual(PLAZOS_DIAS, { notificaciones: 180, solicitudes_rechazadas: 30, sesiones: 30, codigos_cuenta: 30 });
    assert.throws(() => validarPlazos({ sesiones: 0 }), /invalido/);
    assert.throws(() => validarPlazos({ sesiones: 1.5 }), /invalido/);
    assert.strictEqual(validarPlazos({ sesiones: 7 }).sesiones, 7);
});

test('solo toca las cuatro tablas de datos de acceso y avisos', () => {
    assert.deepStrictEqual(REGLAS.map((r) => r.tabla).sort(), ['codigos_cuenta', 'notificaciones_pendientes', 'sesiones', 'solicitudes_cliente']);
    for (const r of REGLAS) assert.match(r.donde, /make_interval\(days => \$1\)/);
});

test('la tarea del worker esta apagada salvo que se active', () => {
    const logs = [];
    const detener = iniciarRetencion({ connect() { throw new Error('no debia tocar la base'); } }, { activa: false, log: { log: (m) => logs.push(m), error: (m) => logs.push(m) } });
    assert.strictEqual(typeof detener, 'function');
    assert.deepStrictEqual(logs, []);
});

test('borra solo lo vencido y no toca lo reciente ni lo pendiente', async (t) => {
    if (process.env.GOMAQ_TEST_ESCRITURA !== '1') return t.skip('necesita Postgres (GOMAQ_TEST_ESCRITURA=1)');
    exigirBaseLocal();
    const pool = require('../src/config/db');
    const marca = `ret-${Date.now()}`;
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        const u = (await c.query(`INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES ($1, $2, 'x', 'mecanico') RETURNING id`, [marca, `${marca}@gomaq.test`])).rows[0].id;
        const nuevaSesion = (hash, expira, revocada) => c.query(
            `INSERT INTO sesiones (usuario_id, token_hash, expira_at, inactividad_min, revocada_at) VALUES ($1, $2, now() + $3::interval, 60, $4)`,
            [u, hash.padEnd(64, '0'), expira, revocada]);
        await nuevaSesion('vieja', '-60 days', null);            // vencida hace 60 dias: se borra
        await nuevaSesion('reciente', '-5 days', null);          // vencida hace 5: se queda
        await nuevaSesion('vigente', '10 days', null);           // vigente: se queda
        await nuevaSesion('revocadavieja', '10 days', null);
        await c.query(`UPDATE sesiones SET revocada_at = now() - interval '45 days' WHERE token_hash = $1`, ['revocadavieja'.padEnd(64, '0')]);
        const antes = await contarRetencion(c);
        assert.ok(antes.sesiones >= 2, JSON.stringify(antes));
        const hashes = async () => (await c.query('SELECT token_hash FROM sesiones WHERE usuario_id = $1', [u])).rows.map((r) => r.token_hash.replace(/0+$/, ''));
        assert.deepStrictEqual((await hashes()).sort(), ['reciente', 'revocadavieja', 'vieja', 'vigente']);
        // misma transaccion: ejecutarRetencion usa su propia conexion, asi que se borra con la regla directa
        await c.query(`DELETE FROM sesiones WHERE ${REGLAS.find((r) => r.clave === 'sesiones').donde}`, [30]);
        assert.deepStrictEqual((await hashes()).sort(), ['reciente', 'vigente']);
    } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
        await pool.end();
    }
});
