// Endurecimiento del backend: limites del pool, /api/health con 503 y apagado ordenado.
// Arranca server.js de verdad con una base inalcanzable (no necesita Postgres).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');

const raiz = path.join(__dirname, '..');

function puertoLibre() {
    return new Promise((resolver, rechazar) => {
        const s = net.createServer();
        s.listen(0, () => {
            const { port } = s.address();
            s.close(() => resolver(port));
        });
        s.on('error', rechazar);
    });
}

function arrancar(puerto, base) {
    const hijo = spawn(process.execPath, ['server.js'], {
        cwd: raiz,
        env: {
            ...process.env,
            PORT: String(puerto),
            // puerto cerrado: la conexion se rechaza al instante
            DATABASE_URL: base,
            NOTIFICACIONES_EN_PROCESO: '0',
            DB_CONNECT_TIMEOUT_MS: '1500',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const salida = [];
    hijo.stdout.on('data', (d) => salida.push(String(d)));
    hijo.stderr.on('data', (d) => salida.push(String(d)));
    return { hijo, salida };
}

async function esperarEscucha(salida, hijo) {
    const limite = Date.now() + 15000;
    while (Date.now() < limite) {
        if (salida.join('').includes('escuchando en puerto')) return;
        if (hijo.exitCode !== null) throw new Error('el servidor se cerro: ' + salida.join(''));
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('el servidor no arranco: ' + salida.join(''));
}

test('pool: limites de espera por defecto y ajustables por entorno', () => {
    const codigo = `
        const pool = require('./src/config/db');
        console.log(JSON.stringify({
            conexion: pool.options.connectionTimeoutMillis,
            consulta: pool.options.statement_timeout,
            ociosa: pool.options.idle_in_transaction_session_timeout,
        }));
        pool.end();`;
    const { execFileSync } = require('node:child_process');
    const correr = (extra) => JSON.parse(execFileSync(process.execPath, ['-e', codigo], {
        cwd: raiz,
        env: { ...process.env, DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', ...extra },
    }).toString().trim());
    assert.deepStrictEqual(correr({}), { conexion: 5000, consulta: 30000, ociosa: 60000 });
    assert.deepStrictEqual(
        correr({ DB_CONNECT_TIMEOUT_MS: '1000', DB_STATEMENT_TIMEOUT_MS: '0', DB_IDLE_TX_TIMEOUT_MS: 'basura' }),
        { conexion: 1000, consulta: 0, ociosa: 60000 },
    );
});

test('/api/health responde 503 (no 500) cuando la base no esta disponible', async () => {
    const puerto = await puertoLibre();
    const { hijo, salida } = arrancar(puerto, 'postgres://u:p@127.0.0.1:1/x');
    try {
        await esperarEscucha(salida, hijo);
        const r = await fetch(`http://127.0.0.1:${puerto}/api/health`);
        assert.strictEqual(r.status, 503);
        assert.deepStrictEqual(await r.json(), { status: 'error', db: 'disconnected' });
    } finally {
        hijo.kill('SIGKILL');
    }
});

// En Windows kill('SIGTERM') termina el proceso sin pasar por el manejador: solo se prueba en Linux/macOS
test('SIGTERM cierra la API de forma ordenada (codigo 0)', { skip: process.platform === 'win32' }, async () => {
    const puerto = await puertoLibre();
    const { hijo, salida } = arrancar(puerto, 'postgres://u:p@127.0.0.1:1/x');
    try {
        await esperarEscucha(salida, hijo);
        const salio = new Promise((resolver) => hijo.once('exit', (codigo, senal) => resolver({ codigo, senal })));
        hijo.kill('SIGTERM');
        const r = await Promise.race([
            salio,
            new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('no cerro en 10 s')), 10000)),
        ]);
        assert.deepStrictEqual(r, { codigo: 0, senal: null });
        assert.match(salida.join(''), /SIGTERM recibida/);
    } finally {
        hijo.kill('SIGKILL');
    }
});

test('migracion 039: solo agrega indices y revisa duplicados antes del UNIQUE', () => {
    const sql = fs.readFileSync(path.join(raiz, '..', 'db', 'migrations', '039_indices_y_email_unico.sql'), 'utf8');
    assert.doesNotMatch(sql, /\b(DROP|DELETE|TRUNCATE)\b/i);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS usuarios_email_lower_unico ON usuarios \(lower\(email\)\)/);
    assert.ok(sql.indexOf('RAISE EXCEPTION') < sql.indexOf('CREATE UNIQUE INDEX'));
});
