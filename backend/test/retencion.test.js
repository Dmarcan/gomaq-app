// Retencion de datos personales: reglas, plazos y que no toque lo que no debe. Las pruebas con Postgres necesitan GOMAQ_TEST_ESCRITURA=1.
const test = require('node:test');
const { after } = test;
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

test('regla de sesiones: borra la vencida o revocada hace mas del plazo y deja la reciente y la vigente', async (t) => {
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
    }
});

test('ejecutarRetencion borra solo lo vencido de cada tabla y deja lo reciente, lo pendiente y lo vigente', async (t) => {
    if (process.env.GOMAQ_TEST_ESCRITURA !== '1') return t.skip('necesita Postgres (GOMAQ_TEST_ESCRITURA=1)');
    exigirBaseLocal();
    const pool = require('../src/config/db');
    const marca = `ret-e2e-${Date.now()}`;
    const dest = (n) => `${marca}-${n}`;
    try {
        // ejecutarRetencion usa su propia conexion y hace COMMIT: no cabe en una transaccion de prueba,
        // asi que se inserta con marca unica y se limpia lo propio en el finally.
        const notif = (nombre, estado, dias) => pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload, estado, created_at)
             VALUES ('email', $1, '{}', $2, now() - make_interval(days => $3))`, [dest(nombre), estado, dias]);
        await notif('pendiente200', 'pendiente', 200);   // pendiente: se queda aunque sea vieja
        await notif('enviado200', 'enviado', 200);       // terminada y vieja: se borra
        await notif('error200', 'error', 200);           // error definitivo y viejo: se borra
        await notif('enviado10', 'enviado', 10);         // reciente: se queda
        // Decision pendiente: la regla actual NO borra las canceladas (solo enviado y error).
        // Si se decide que tambien se borren, cambiar este caso y el IN de utils/retencion.js.
        await notif('cancelado200', 'cancelado', 200);

        const solicitud = (nombre, estado, dias) => pool.query(
            `INSERT INTO solicitudes_cliente (nombre_contacto, email, password_hash, estado, created_at)
             VALUES ($1, $2, 'x', $3, now() - make_interval(days => $4))`, [marca, `${dest(nombre)}@gomaq.test`, estado, dias]);
        await solicitud('rechazada40', 'rechazada', 40);   // se borra
        await solicitud('pendiente40', 'pendiente', 40);   // pendiente: se queda

        const u = (await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES ($1, $2, 'x', 'mecanico') RETURNING id`,
            [marca, `${marca}@gomaq.test`])).rows[0].id;
        const codigo = (nombre, usado) => pool.query(
            `INSERT INTO codigos_cuenta (proposito, usuario_id, email, codigo_hmac, expira_at, usado_at, canal)
             VALUES ('recuperar_password', $1, $2, $3, now() + interval '10 days', $4::timestamptz, 'manual')`,
            [u, `${dest(nombre)}@gomaq.test`, 'a'.repeat(64), usado]);
        // usado hace 40 dias aunque su vencimiento sea futuro: LEAST toma la fecha de uso y se borra
        await pool.query(
            `INSERT INTO codigos_cuenta (proposito, usuario_id, email, codigo_hmac, expira_at, usado_at, canal)
             VALUES ('recuperar_password', $1, $2, $3, now() + interval '10 days', now() - interval '40 days', 'manual')`,
            [u, `${dest('usado40')}@gomaq.test`, 'a'.repeat(64)]);
        await codigo('vigente', null);                   // vigente y sin usar: se queda

        const resultado = await ejecutarRetencion(pool);
        for (const clave of ['notificaciones', 'solicitudes_rechazadas', 'codigos_cuenta']) {
            assert.ok(resultado[clave] >= 1, `${clave}: ${JSON.stringify(resultado)}`);
        }

        const quedan = async (tabla, columna, valores) => (await pool.query(
            `SELECT ${columna} AS v FROM ${tabla} WHERE ${columna} = ANY($1)`, [valores])).rows.map((r) => r.v).sort();
        const nombres = ['pendiente200', 'enviado200', 'error200', 'enviado10', 'cancelado200'].map(dest);
        assert.deepStrictEqual(await quedan('notificaciones_pendientes', 'destinatario', nombres),
            [dest('pendiente200'), dest('enviado10'), dest('cancelado200')].sort());
        const correos = (ns) => ns.map((n) => `${dest(n)}@gomaq.test`);
        assert.deepStrictEqual(await quedan('solicitudes_cliente', 'email', correos(['rechazada40', 'pendiente40'])),
            correos(['pendiente40']));
        assert.deepStrictEqual(await quedan('codigos_cuenta', 'email', correos(['usado40', 'vigente'])),
            correos(['vigente']));
    } finally {
        await pool.query(`DELETE FROM codigos_cuenta WHERE email LIKE $1`, [`${marca}-%`]).catch(() => {});
        await pool.query(`DELETE FROM notificaciones_pendientes WHERE destinatario LIKE $1`, [`${marca}-%`]).catch(() => {});
        await pool.query(`DELETE FROM solicitudes_cliente WHERE nombre_contacto = $1`, [marca]).catch(() => {});
        await pool.query(`DELETE FROM usuarios WHERE email = $1`, [`${marca}@gomaq.test`]).catch(() => {});
    }
});

test('ejecutarRetencion hace ROLLBACK, libera el cliente y propaga el error si falla un DELETE', async () => {
    const llamadas = [];
    let liberado = 0;
    let deletes = 0;
    const error = new Error('falla simulada en el tercer DELETE');
    const client = {
        async query(sql) {
            llamadas.push(sql);
            if (/^DELETE/.test(sql) && ++deletes === 3) throw error;
            return { rowCount: 0, rows: [] };
        },
        release() { liberado++; },
    };
    await assert.rejects(ejecutarRetencion({ connect: async () => client }), (e) => e === error);
    assert.strictEqual(deletes, 3);
    assert.ok(llamadas.includes('ROLLBACK'), llamadas.join(' | '));
    assert.ok(!llamadas.includes('COMMIT'));
    assert.strictEqual(llamadas[llamadas.length - 1], 'ROLLBACK');
    assert.strictEqual(liberado, 1);
});

test('iniciarRetencion queda apagada por defecto y solo RETENCION_ACTIVA=1 la enciende', (t) => {
    const previo = process.env.RETENCION_ACTIVA;
    t.after(() => { if (previo === undefined) delete process.env.RETENCION_ACTIVA; else process.env.RETENCION_ACTIVA = previo; });
    const log = { log() {}, error() {} };
    const poolQueLanza = { connect() { throw new Error('no debia tocar la base'); } };
    const timerFalso = () => ({ unref() {} });
    const setTimeoutMock = t.mock.method(globalThis, 'setTimeout', timerFalso);
    const setIntervalMock = t.mock.method(globalThis, 'setInterval', timerFalso);
    const clearTimeoutMock = t.mock.method(globalThis, 'clearTimeout', () => {});
    const clearIntervalMock = t.mock.method(globalThis, 'clearInterval', () => {});

    for (const valor of [undefined, '0', 'true']) {
        if (valor === undefined) delete process.env.RETENCION_ACTIVA; else process.env.RETENCION_ACTIVA = valor;
        const detener = iniciarRetencion(poolQueLanza, { log });
        assert.strictEqual(typeof detener, 'function');
        detener();
        assert.strictEqual(setTimeoutMock.mock.callCount(), 0, `RETENCION_ACTIVA=${valor}`);
        assert.strictEqual(setIntervalMock.mock.callCount(), 0, `RETENCION_ACTIVA=${valor}`);
    }

    process.env.RETENCION_ACTIVA = '1';
    const detener = iniciarRetencion(poolQueLanza, { log });
    assert.strictEqual(typeof detener, 'function');
    assert.strictEqual(setTimeoutMock.mock.callCount(), 1);
    assert.strictEqual(setIntervalMock.mock.callCount(), 1);
    detener();
    assert.strictEqual(clearTimeoutMock.mock.callCount(), 1);
    assert.strictEqual(clearIntervalMock.mock.callCount(), 1);
});

// el pool es uno solo para todo el archivo: se cierra al final, no dentro de cada prueba
after(async () => {
    if (process.env.GOMAQ_TEST_ESCRITURA === '1') await require('../src/config/db').end();
});
