// Mi perfil y mis avisos (RF-05 y RF-06): GET/PATCH /api/usuarios/mi-perfil y el filtro de los avisos silenciados al
// encolar. Rutas en memoria sobre la base de DATABASE_URL, con las cuentas de la semilla; lo que se cambia se
// restaura al terminar. Tokens firmados con un secreto de la prueba.
//
//   GOMAQ_TEST_ESCRITURA=1 npm test

require('dotenv').config();
const { exigirBaseLocal } = require('./_entornoPruebas');
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-mi-perfil-y-avisos';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { requiereBase, servirApp } = require('./utils/http');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

let servidor;
let base;
let pool;
const usuarios = {}; // clave: administrativo | gerente | mecanico | cliente -> { id, token, original }
const dispositivos = [];
const marca = crypto.randomUUID().slice(0, 8);

const CORREOS = {
    administrativo: 'administrativo@gomaq.test',
    gerente: 'admin@gomaq.test',
    mecanico: 'mecanico@gomaq.test',
    cliente: 'cliente@gomaq.test',
};

async function llamar(metodo, quien, cuerpo) {
    const r = await fetch(`${base}/api/usuarios/mi-perfil`, {
        method: metodo,
        headers: { Authorization: `Bearer ${usuarios[quien].token}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    let body = null;
    try { body = await r.json(); } catch (_) { /* sin cuerpo */ }
    return { status: r.status, body };
}

const activoDe = (perfil, tipo) => perfil.avisos.find((a) => a.tipo === tipo).activo;

async function dispositivo(quien, app) {
    const r = await pool.query(
        `INSERT INTO dispositivos_push (usuario_id, plataforma, app, token) VALUES ($1, $2, $3, $4) RETURNING id`,
        [usuarios[quien].id, app === 'terreno' ? 'android' : 'web', app, `${marca}-${quien}-${crypto.randomUUID()}`]
    );
    dispositivos.push(r.rows[0].id);
    return r.rows[0].id;
}

before(async () => {
    if (!HABILITADO) return;
    exigirBaseLocal();
    const express = require('express');
    pool = require('../src/config/db');
    require('../src/middleware/auth').usarBuscadorDeUsuarios(async (id) => {
        const r = await pool.query('SELECT rol, cliente_id, estado_cuenta, password_cambiada_at FROM usuarios WHERE id = $1', [id]);
        return r.rows[0] || null;
    });
    const app = express();
    app.use(express.json());
    app.use('/api/usuarios', require('../src/routes/usuarios'));
    ({ servidor, base } = await servirApp(app));
    for (const [clave, correo] of Object.entries(CORREOS)) {
        const u = (await pool.query(
            `SELECT id, rol, cliente_id, nombre, telefono_whatsapp, rut, avisos_silenciados, recibe_alertas_mantencion FROM usuarios WHERE email = $1`, [correo]
        )).rows[0];
        usuarios[clave] = { id: u.id, original: u, token: jwt.sign({ id: u.id, rol: u.rol, cliente_id: u.cliente_id }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
    }
});

after(async () => {
    if (!HABILITADO) return;
    if (dispositivos.length) {
        await pool.query(`DELETE FROM notificaciones_pendientes WHERE canal = 'push' AND destinatario = ANY($1)`, [dispositivos.map(String)]);
        await pool.query('DELETE FROM dispositivos_push WHERE id = ANY($1)', [dispositivos]);
    }
    for (const { id, original } of Object.values(usuarios)) {
        await pool.query(
            `UPDATE usuarios SET nombre = $2, telefono_whatsapp = $3, rut = $4, avisos_silenciados = $5, recibe_alertas_mantencion = $6 WHERE id = $1`,
            [id, original.nombre, original.telefono_whatsapp, original.rut, original.avisos_silenciados, original.recibe_alertas_mantencion]
        );
    }
    await new Promise((resolve) => servidor.close(resolve));
    await pool.end();
});

test('GET: cada rol recibe solo los avisos que le llegan, sin exponer las columnas internas', async (t) => {
    if (!requiereBase(t)) return;
    await pool.query(`UPDATE usuarios SET avisos_silenciados = '{}', recibe_alertas_mantencion = false WHERE id = ANY($1)`, [Object.values(usuarios).map((u) => u.id)]);
    const esperado = {
        administrativo: ['ot_por_valorizar', 'asistencia_nueva', 'mantencion_proxima'],
        gerente: ['ot_por_valorizar', 'asistencia_nueva', 'mantencion_proxima', 'factura_anulada', 'ajuste_inventario'],
        mecanico: ['ot_asignada', 'ot_reasignada', 'ot_disponible'],
        cliente: ['mecanico_asignado', 'ot_finalizada'],
    };
    for (const [quien, tipos] of Object.entries(esperado)) {
        const r = await llamar('GET', quien);
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.avisos.map((a) => a.tipo), tipos, quien);
        assert.ok(r.body.avisos.every((a) => a.titulo && a.descripcion));
        assert.equal('avisos_silenciados' in r.body, false);
        assert.equal('recibe_alertas_mantencion' in r.body, false);
        assert.equal(r.body.email, CORREOS[quien]);
    }
    const adm = (await llamar('GET', 'administrativo')).body;
    assert.equal(activoDe(adm, 'ot_por_valorizar'), true);
    assert.equal(activoDe(adm, 'mantencion_proxima'), false, 'la mantencion parte apagada (recibe_alertas_mantencion)');
});

test('PATCH avisos: apagar y encender un tipo, y la mantencion usa su propia columna', async (t) => {
    if (!requiereBase(t)) return;
    let r = await llamar('PATCH', 'administrativo', { avisos: { ot_por_valorizar: false, mantencion_proxima: true } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(activoDe(r.body, 'ot_por_valorizar'), false);
    assert.equal(activoDe(r.body, 'mantencion_proxima'), true);
    assert.equal(activoDe(r.body, 'asistencia_nueva'), true);
    const fila = (await pool.query('SELECT avisos_silenciados, recibe_alertas_mantencion FROM usuarios WHERE id = $1', [usuarios.administrativo.id])).rows[0];
    assert.deepEqual(fila.avisos_silenciados, ['ot_por_valorizar']);
    assert.equal(fila.recibe_alertas_mantencion, true);

    r = await llamar('PATCH', 'administrativo', { avisos: { ot_por_valorizar: true, asistencia_nueva: false } });
    assert.deepEqual((await pool.query('SELECT avisos_silenciados FROM usuarios WHERE id = $1', [usuarios.administrativo.id])).rows[0].avisos_silenciados, ['asistencia_nueva']);
    assert.equal(activoDe(r.body, 'ot_por_valorizar'), true);
});

test('PATCH avisos: rechaza tipos de otro rol, inventados y valores que no son booleanos, sin cambiar nada', async (t) => {
    if (!requiereBase(t)) return;
    const antes = (await pool.query('SELECT avisos_silenciados FROM usuarios WHERE id = $1', [usuarios.administrativo.id])).rows[0].avisos_silenciados;
    for (const malo of [{ factura_anulada: false }, { inventado: false }, { ot_por_valorizar: 'no' }, [], 'todos', null]) {
        const r = await llamar('PATCH', 'administrativo', { avisos: malo });
        assert.equal(r.status, 400, JSON.stringify(malo));
    }
    const despues = (await pool.query('SELECT avisos_silenciados FROM usuarios WHERE id = $1', [usuarios.administrativo.id])).rows[0].avisos_silenciados;
    assert.deepEqual(despues, antes);
    // el mecanico no puede configurar avisos de la oficina
    assert.equal((await llamar('PATCH', 'mecanico', { avisos: { ot_por_valorizar: false } })).status, 400);
    assert.equal((await llamar('PATCH', 'cliente', { avisos: { ot_asignada: false } })).status, 400);
});

test('PATCH datos: nombre y telefono se corrigen, el correo no cambia y un cuerpo vacio es 400', async (t) => {
    if (!requiereBase(t)) return;
    const r = await llamar('PATCH', 'gerente', { nombre: `  Gerente ${marca}  `, telefono_whatsapp: '+56 9 1111 2222', email: 'otro@x.cl', rol: 'administrativo' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.nombre, `Gerente ${marca}`);
    assert.equal(r.body.telefono_whatsapp, '+56 9 1111 2222');
    assert.equal(r.body.email, CORREOS.gerente, 'el correo es el inicio de sesion: no se cambia desde aqui');
    assert.equal(r.body.rol, 'gerente', 'el rol tampoco');
    assert.equal((await llamar('PATCH', 'gerente', { nombre: '   ' })).status, 400);
    assert.equal((await llamar('PATCH', 'gerente', {})).status, 400);
});

test('compatibilidad: la app del mecanico, que manda solo telefono o RUT, sigue funcionando y no toca los avisos', async (t) => {
    if (!requiereBase(t)) return;
    await llamar('PATCH', 'mecanico', { avisos: { ot_asignada: false } });
    const r = await llamar('PATCH', 'mecanico', { telefono_whatsapp: '+56 9 3333 4444' });
    assert.equal(r.status, 200);
    assert.equal(r.body.telefono_whatsapp, '+56 9 3333 4444');
    assert.equal(activoDe(r.body, 'ot_asignada'), false, 'cambiar el telefono no revive un aviso apagado');
    assert.equal((await llamar('PATCH', 'mecanico', { rut: '11.111.111-2' })).status, 400, 'un RUT con digito verificador malo sigue rechazandose');
});

test('un aviso apagado no se encola para ese usuario pero sigue llegando a los demas', async (t) => {
    if (!requiereBase(t)) return;
    const avisos = require('../src/utils/avisos');
    const previo = process.env.PUSH_HABILITADO;
    process.env.PUSH_HABILITADO = '1';
    try {
        await pool.query(`UPDATE usuarios SET avisos_silenciados = '{}' WHERE id = ANY($1)`, [Object.values(usuarios).map((u) => u.id)]);
        const dAdm = await dispositivo('administrativo', 'panel');
        const dGer = await dispositivo('gerente', 'panel');
        const dMec = await dispositivo('mecanico', 'terreno');
        const destinatarios = async (tipo) => (await pool.query(
            `SELECT destinatario FROM notificaciones_pendientes WHERE canal = 'push' AND payload->>'tipo' = $1 AND destinatario = ANY($2) ORDER BY id`,
            [tipo, [dAdm, dGer, dMec].map(String)]
        )).rows.map((f) => f.destinatario);
        const limpiar = () => pool.query(`DELETE FROM notificaciones_pendientes WHERE canal = 'push' AND destinatario = ANY($1)`, [[dAdm, dGer, dMec].map(String)]);

        // oficina: los dos reciben
        await avisos.avisarPorValorizar(pool, 987654, 'prueba');
        assert.deepEqual((await destinatarios('ot_por_valorizar')).sort(), [String(dAdm), String(dGer)].sort());
        await limpiar();
        // el administrativo apaga ese tipo: solo llega al gerente
        assert.equal((await llamar('PATCH', 'administrativo', { avisos: { ot_por_valorizar: false } })).status, 200);
        await avisos.avisarPorValorizar(pool, 987654, 'prueba');
        assert.deepEqual(await destinatarios('ot_por_valorizar'), [String(dGer)]);
        await limpiar();
        // apagar un tipo no apaga los otros
        await avisos.avisarAsistenciaNueva(pool, 987654);
        assert.deepEqual((await destinatarios('asistencia_nueva')).sort(), [String(dAdm), String(dGer)].sort());
        await limpiar();

        // mecanico: ot_asignada apagada no se encola; ot_reasignada si
        assert.equal((await llamar('PATCH', 'mecanico', { avisos: { ot_asignada: false } })).status, 200);
        await avisos.encolarAMecanico(pool, usuarios.mecanico.id, { tipo: 'ot_asignada', orden_trabajo_id: 987654 });
        await avisos.encolarAMecanico(pool, usuarios.mecanico.id, { tipo: 'ot_reasignada', orden_trabajo_id: 987654 });
        assert.deepEqual(await destinatarios('ot_asignada'), []);
        assert.deepEqual(await destinatarios('ot_reasignada'), [String(dMec)]);
        await limpiar();
        // ot_disponible (consulta propia): apagada, no le llega al mecanico
        assert.equal((await llamar('PATCH', 'mecanico', { avisos: { ot_disponible: false } })).status, 200);
        await avisos.avisarOtDisponible(pool, 987654);
        assert.deepEqual(await destinatarios('ot_disponible'), []);
    } finally {
        if (previo === undefined) delete process.env.PUSH_HABILITADO; else process.env.PUSH_HABILITADO = previo;
    }
});
