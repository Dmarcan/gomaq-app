// Invitar cuentas internas, recuperar y cambiar la contrasena (codigos de un solo uso, migracion 034).
//
// Las validaciones que responden antes de tocar la base corren siempre. Los flujos completos escriben
// en la base local, igual que escritura.test.js:
//
//   GOMAQ_TEST_ESCRITURA=1 npm test
//
// Nunca se llama a Resend: la llamada a su API se intercepta y se lee el codigo del texto del correo.

require('dotenv').config();
process.env.JWT_SECRET = 'secreto-solo-para-pruebas-de-codigos-de-cuenta';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { URL_RESEND } = require('../src/services/correoResend');

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);
const MARCA = `codigos-${Date.now()}`;
const correoPrueba = (n) => `${MARCA}-${n}@gomaq.test`;

let servidor;
let base;
let pool;
const tokens = {};
const correosEnviados = [];
const fetchReal = globalThis.fetch;

// cada peticion con su propia IP (CF-Connecting-IP desde loopback): los limites por IP no se cruzan
let ipSiguiente = 1;
async function pedir(metodo, ruta, { token, cuerpo } = {}) {
    const ip = `10.77.${Math.floor(ipSiguiente / 250)}.${(ipSiguiente++ % 250) + 1}`;
    const r = await fetchReal(`${base}${ruta}`, {
        method: metodo,
        headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': ip,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    let json = null;
    try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
    return { status: r.status, body: json, headers: r.headers };
}

/** El codigo de 6 digitos dentro del texto ("123 456"). */
function codigoDelTexto(texto) {
    const m = /código: (\d{3}) (\d{3})/.exec(texto || '');
    assert.ok(m, `el texto trae el código: ${texto}`);
    return `${m[1]}${m[2]}`;
}

function sinCorreoConfigurado() {
    delete process.env.RESEND_API_KEY;
    delete process.env.CORREO_REMITENTE;
}

function conCorreoConfigurado() {
    process.env.RESEND_API_KEY = 're_prueba';
    process.env.CORREO_REMITENTE = 'GOMAQ <avisos@correo.example>';
}

before(async () => {
    sinCorreoConfigurado();
    // la API de Resend se reemplaza: se guarda lo que se habria enviado y se responde como Resend
    globalThis.fetch = async (url, opciones) => {
        if (url === URL_RESEND) {
            correosEnviados.push(JSON.parse(opciones.body));
            return new Response(JSON.stringify({ id: `prueba-${correosEnviados.length}` }), { status: 200 });
        }
        return fetchReal(url, opciones);
    };

    const express = require('express');
    const auth = require('../src/middleware/auth');
    if (HABILITADO) pool = require('../src/config/db');
    // tokens de relleno (ids >= 987000) valen lo que firman; los reales se revisan en la base
    auth.usarBuscadorDeUsuarios(async (id, claims) => {
        if (id >= 987000 || !HABILITADO) return { rol: claims.rol, cliente_id: null, estado_cuenta: 'activo' };
        const r = await pool.query('SELECT rol, cliente_id, estado_cuenta, password_cambiada_at FROM usuarios WHERE id = $1', [id]);
        return r.rows[0] || null;
    });

    const app = express();
    app.use(express.json());
    app.use('/api/auth', require('../src/routes/auth'));
    app.use('/api/usuarios', require('../src/routes/usuarios'));
    await new Promise((resolve) => { servidor = app.listen(0, resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;

    const firmar = (u) => jwt.sign({ id: u.id, rol: u.rol, cliente_id: null, pc: u.pc || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
    tokens.relleno = firmar({ id: 987650, rol: 'administrativo' });
    if (HABILITADO) {
        const r = await pool.query(
            `SELECT id, rol, email, COALESCE(floor(extract(epoch FROM password_cambiada_at) * 1000), 0)::float8 AS pc FROM usuarios WHERE email IN ('administrativo@gomaq.test', 'admin@gomaq.test')`
        );
        const porEmail = Object.fromEntries(r.rows.map((u) => [u.email, u]));
        tokens.administrativo = firmar(porEmail['administrativo@gomaq.test']);
        tokens.gerente = firmar(porEmail['admin@gomaq.test']);
    }
});

after(async () => {
    globalThis.fetch = fetchReal;
    if (servidor) await new Promise((resolve) => servidor.close(resolve));
    if (pool) {
        await pool.query(`DELETE FROM usuarios WHERE email LIKE $1`, [`${MARCA}-%`]);
        await pool.end();
    }
});

function requiereBase(t) {
    if (!HABILITADO) {
        t.skip('pruebas de escritura deshabilitadas: usar GOMAQ_TEST_ESCRITURA=1 con una base local');
        return false;
    }
    return true;
}

describe('validaciones antes de tocar la base', () => {
    test('invitar exige nombre, correo, rol interno y canal', async () => {
        const r = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.relleno, cuerpo: { nombre: 'Ana', email: 'ana@gomaq.test', rol: 'cliente', canal: 'manual' },
        });
        assert.equal(r.status, 400);
        const sinCanal = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.relleno, cuerpo: { nombre: 'Ana', email: 'ana@gomaq.test', rol: 'mecanico' },
        });
        assert.equal(sinCanal.status, 400);
    });

    test('el canal correo se rechaza si no esta configurado, y la configuracion lo dice', async () => {
        sinCorreoConfigurado();
        const r = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.relleno, cuerpo: { nombre: 'Ana', email: 'ana@gomaq.test', rol: 'mecanico', canal: 'correo' },
        });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /Copiar mensaje/);
        const config = await pedir('GET', '/api/usuarios/invitaciones/config', { token: tokens.relleno });
        assert.equal(config.status, 200);
        assert.equal(config.body.correo_disponible, false);

        process.env.RESEND_API_KEY = 're_prueba';
        process.env.CORREO_REMITENTE = 'onboarding@resend.dev';
        const pruebas = await pedir('GET', '/api/usuarios/invitaciones/config', { token: tokens.relleno });
        assert.equal(pruebas.body.correo_disponible, false, 'el remitente de pruebas de Resend no llega a nadie más');
        sinCorreoConfigurado();
    });

    test('las rutas de administracion piden sesion y rol', async () => {
        assert.equal((await pedir('POST', '/api/usuarios/invitaciones', { cuerpo: {} })).status, 401);
        const mecanico = jwt.sign({ id: 987651, rol: 'mecanico' }, process.env.JWT_SECRET);
        assert.equal((await pedir('POST', '/api/usuarios/invitaciones', { token: mecanico, cuerpo: {} })).status, 403);
        assert.equal((await pedir('POST', '/api/usuarios/5/codigo-restablecer', { token: mecanico, cuerpo: { canal: 'manual' } })).status, 403);
    });

    test('recuperar responde lo mismo aunque no haya correo configurado', async () => {
        sinCorreoConfigurado();
        const r = await pedir('POST', '/api/auth/recuperar', { cuerpo: { email: 'nadie@gomaq.test' } });
        assert.equal(r.status, 200);
        assert.equal(r.body.ok, true);
        assert.equal((await pedir('POST', '/api/auth/recuperar', { cuerpo: {} })).status, 400);
    });

    test('confirmar exige correo, codigo de 6 digitos y una clave valida', async () => {
        const r = await pedir('POST', '/api/auth/codigo/confirmar', { cuerpo: { email: 'a@gomaq.test', codigo: '12', password: 'clave-larga' } });
        assert.equal(r.status, 400);
        const corta = await pedir('POST', '/api/auth/codigo/confirmar', { cuerpo: { email: 'a@gomaq.test', codigo: '123456', password: 'corta' } });
        assert.equal(corta.status, 400);
    });

    test('cambiar la clave propia exige sesion', async () => {
        assert.equal((await pedir('POST', '/api/auth/cambiar-password', { cuerpo: { actual: 'x', nueva: 'clave-nueva-1' } })).status, 401);
    });
});

describe('invitar una cuenta interna', () => {
    test('canal manual: la cuenta queda pendiente, el codigo sale una vez y la persona elige su clave', async (t) => {
        if (!requiereBase(t)) return;
        const email = correoPrueba('mecanico');
        const r = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.administrativo, cuerpo: { nombre: 'Mecánico Invitado', email, rol: 'mecanico', canal: 'manual' },
        });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.usuario.estado_cuenta, 'pendiente');
        assert.equal(r.headers.get('cache-control'), 'no-store');
        assert.match(r.body.invitacion.mensaje, new RegExp(email.replace(/[.]/g, '\\.')));
        const codigo = codigoDelTexto(r.body.invitacion.mensaje);

        // la base guarda solo el HMAC
        const fila = await pool.query('SELECT codigo_hmac, canal, creado_por FROM codigos_cuenta WHERE usuario_id = $1', [r.body.usuario.id]);
        assert.equal(fila.rows.length, 1);
        assert.ok(!fila.rows[0].codigo_hmac.includes(codigo));
        assert.equal(fila.rows[0].canal, 'manual');

        const lista = await pedir('GET', '/api/usuarios?rol=mecanico', { token: tokens.administrativo });
        const enLista = lista.body.find((u) => u.id === r.body.usuario.id);
        assert.equal(enLista.invitacion.estado, 'vigente');
        assert.ok(!('inv_expira_at' in enLista), 'no se filtran columnas internas');

        // pendiente: no entra ni se activa a mano
        assert.equal((await pedir('POST', '/api/auth/login', { cuerpo: { email, password: 'cualquier-cosa' } })).status, 401);
        const activar = await pedir('PATCH', `/api/usuarios/${r.body.usuario.id}/estado`, { token: tokens.administrativo, cuerpo: { activo: true } });
        assert.equal(activar.status, 409);

        const otro = codigo === '000000' ? '000001' : '000000';
        const malo = await pedir('POST', '/api/auth/codigo/confirmar', { cuerpo: { email, codigo: otro, password: 'mi-clave-nueva-1' } });
        assert.equal(malo.status, 400);

        const bueno = await pedir('POST', '/api/auth/codigo/confirmar', { cuerpo: { email: email.toUpperCase(), codigo, password: 'mi-clave-nueva-1' } });
        assert.equal(bueno.status, 200, JSON.stringify(bueno.body));
        assert.equal(bueno.body.proposito, 'invitacion');

        const login = await pedir('POST', '/api/auth/login', { cuerpo: { email, password: 'mi-clave-nueva-1' } });
        assert.equal(login.status, 200);
        assert.equal(login.body.usuario.rol, 'mecanico');

        const otraVez = await pedir('POST', '/api/auth/codigo/confirmar', { cuerpo: { email, codigo, password: 'otra-clave-nueva' } });
        assert.equal(otraVez.status, 400, 'un codigo se usa una sola vez');

        const reinvitar = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.administrativo, cuerpo: { nombre: 'Otra Persona', email, rol: 'mecanico', canal: 'manual' },
        });
        assert.equal(reinvitar.status, 409, 'una cuenta activa no se reinvita');
    });

    test('reinvitar el mismo correo deja sin efecto el codigo anterior', async (t) => {
        if (!requiereBase(t)) return;
        const email = correoPrueba('reinvitar');
        const primera = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.administrativo, cuerpo: { nombre: 'Primera', email, rol: 'mecanico', canal: 'manual' },
        });
        const segunda = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.gerente, cuerpo: { nombre: 'Segunda', email, rol: 'administrativo', canal: 'manual' },
        });
        assert.equal(segunda.status, 200);
        assert.equal(segunda.body.usuario.id, primera.body.usuario.id);
        assert.equal(segunda.body.usuario.rol, 'administrativo');

        const viejo = await pedir('POST', '/api/auth/codigo/confirmar', {
            cuerpo: { email, codigo: codigoDelTexto(primera.body.invitacion.mensaje), password: 'clave-de-prueba-1' },
        });
        assert.equal(viejo.status, 400);
        const nuevo = await pedir('POST', '/api/auth/codigo/confirmar', {
            cuerpo: { email, codigo: codigoDelTexto(segunda.body.invitacion.mensaje), password: 'clave-de-prueba-1' },
        });
        assert.equal(nuevo.status, 200);
    });

    test('cinco intentos fallidos bloquean el codigo', async (t) => {
        if (!requiereBase(t)) return;
        const email = correoPrueba('intentos');
        const r = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.administrativo, cuerpo: { nombre: 'Intentos', email, rol: 'mecanico', canal: 'manual' },
        });
        const codigo = codigoDelTexto(r.body.invitacion.mensaje);
        const otro = codigo === '000000' ? '000001' : '000000';
        for (let i = 0; i < 5; i++) {
            assert.equal((await pedir('POST', '/api/auth/codigo/confirmar', { cuerpo: { email, codigo: otro, password: 'clave-de-prueba-1' } })).status, 400);
        }
        const tarde = await pedir('POST', '/api/auth/codigo/confirmar', { cuerpo: { email, codigo, password: 'clave-de-prueba-1' } });
        assert.equal(tarde.status, 400);
        const lista = await pedir('GET', '/api/usuarios?rol=mecanico', { token: tokens.administrativo });
        assert.equal(lista.body.find((u) => u.id === r.body.usuario.id).invitacion.estado, 'bloqueada');
    });

    test('correos ocupados y revocar', async (t) => {
        if (!requiereBase(t)) return;
        const ocupado = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.administrativo, cuerpo: { nombre: 'Otra Persona', email: 'administrativo@gomaq.test', rol: 'mecanico', canal: 'manual' },
        });
        assert.equal(ocupado.status, 409);

        const email = correoPrueba('revocar');
        const r = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.administrativo, cuerpo: { nombre: 'Revocar', email, rol: 'mecanico', canal: 'manual' },
        });
        const revocar = await pedir('POST', `/api/usuarios/${r.body.usuario.id}/invitacion/revocar`, { token: tokens.administrativo, cuerpo: {} });
        assert.equal(revocar.status, 200);
        assert.equal(revocar.body.eliminada, true);
        const queda = await pool.query('SELECT 1 FROM usuarios WHERE id = $1', [r.body.usuario.id]);
        assert.equal(queda.rows.length, 0);
        const canje = await pedir('POST', '/api/auth/codigo/confirmar', {
            cuerpo: { email, codigo: codigoDelTexto(r.body.invitacion.mensaje), password: 'clave-de-prueba-1' },
        });
        assert.equal(canje.status, 400);
    });

    test('solo un gerente crea, invita o reinvita a un gerente', async (t) => {
        if (!requiereBase(t)) return;
        const email = correoPrueba('rol-gerente');
        const negada = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.administrativo, cuerpo: { nombre: 'Aspirante', email, rol: 'gerente', canal: 'manual' },
        });
        assert.equal(negada.status, 403);
        const sinCuenta = await pool.query('SELECT 1 FROM usuarios WHERE lower(email) = $1', [email]);
        assert.equal(sinCuenta.rows.length, 0, 'no se crea la cuenta');

        const clave = await pedir('POST', '/api/usuarios', {
            token: tokens.administrativo, cuerpo: { nombre: 'Aspirante', email, rol: 'gerente', password: 'clave-de-prueba-1' },
        });
        assert.equal(clave.status, 403);

        // la cuenta de gerente pendiente la invita un gerente; un administrativo no puede reinvitarla ni degradarla
        const ok = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.gerente, cuerpo: { nombre: 'Gerente Nuevo', email, rol: 'gerente', canal: 'manual' },
        });
        assert.equal(ok.status, 201, JSON.stringify(ok.body));
        const reinvitar = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.administrativo, cuerpo: { nombre: 'Gerente Nuevo', email, rol: 'mecanico', canal: 'manual' },
        });
        assert.equal(reinvitar.status, 403);
        const sigue = await pool.query('SELECT rol FROM usuarios WHERE id = $1', [ok.body.usuario.id]);
        assert.equal(sigue.rows[0].rol, 'gerente');
    });

    test('un codigo de invitacion no sirve si el correo de la cuenta cambio', async (t) => {
        if (!requiereBase(t)) return;
        const email = correoPrueba('correo-cambiado');
        const r = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.administrativo, cuerpo: { nombre: 'Correo Cambiado', email, rol: 'mecanico', canal: 'manual' },
        });
        const codigo = codigoDelTexto(r.body.invitacion.mensaje);
        const nuevo = correoPrueba('correo-nuevo');
        await pool.query('UPDATE usuarios SET email = $1 WHERE id = $2', [nuevo, r.body.usuario.id]);
        for (const correo of [email, nuevo]) {
            const canje = await pedir('POST', '/api/auth/codigo/confirmar', { cuerpo: { email: correo, codigo, password: 'clave-de-prueba-1' } });
            assert.equal(canje.status, 400, `no debe canjear con ${correo}`);
        }
        const estado = await pool.query('SELECT estado_cuenta FROM usuarios WHERE id = $1', [r.body.usuario.id]);
        assert.equal(estado.rows[0].estado_cuenta, 'pendiente');
    });

    test('revocar una invitacion que la base referencia la deja rechazada y sin codigo', async (t) => {
        if (!requiereBase(t)) return;
        const maquina = await pool.query('SELECT id FROM maquinarias LIMIT 1');
        if (maquina.rows.length === 0) return t.skip('no hay maquinarias en la base de pruebas');
        const email = correoPrueba('revocar-fk');
        const r = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.administrativo, cuerpo: { nombre: 'Revocar FK', email, rol: 'mecanico', canal: 'manual' },
        });
        const ot = await pool.query(
            `INSERT INTO ordenes_trabajo (maquinaria_id, mecanico_id, estado, motivo) VALUES ($1, $2, 'pendiente', 'Prueba revocar') RETURNING id`,
            [maquina.rows[0].id, r.body.usuario.id]
        );
        try {
            const revocar = await pedir('POST', `/api/usuarios/${r.body.usuario.id}/invitacion/revocar`, { token: tokens.administrativo, cuerpo: {} });
            assert.equal(revocar.status, 200, JSON.stringify(revocar.body));
            assert.equal(revocar.body.eliminada, false);
            const cuenta = await pool.query('SELECT estado_cuenta FROM usuarios WHERE id = $1', [r.body.usuario.id]);
            assert.equal(cuenta.rows[0].estado_cuenta, 'rechazado');
            const canje = await pedir('POST', '/api/auth/codigo/confirmar', {
                cuerpo: { email, codigo: codigoDelTexto(r.body.invitacion.mensaje), password: 'clave-de-prueba-1' },
            });
            assert.equal(canje.status, 400);
        } finally {
            await pool.query('DELETE FROM ordenes_trabajo WHERE id = $1', [ot.rows[0].id]);
        }
    });
});

describe('restablecer, recuperar y cambiar la contrasena', () => {
    const email = correoPrueba('clave');
    let usuarioId;

    before(async () => {
        if (!HABILITADO) return;
        const r = await pedir('POST', '/api/usuarios/invitaciones', {
            token: tokens.administrativo, cuerpo: { nombre: 'Clave', email, rol: 'mecanico', canal: 'manual' },
        });
        usuarioId = r.body.usuario.id;
        await pedir('POST', '/api/auth/codigo/confirmar', {
            cuerpo: { email, codigo: codigoDelTexto(r.body.invitacion.mensaje), password: 'clave-inicial-1' },
        });
    });

    test('el administrador genera un codigo manual (sin correo real) y la persona elige la clave', async (t) => {
        if (!requiereBase(t)) return;
        const canalInvalido = await pedir('POST', `/api/usuarios/${usuarioId}/codigo-restablecer`, { token: tokens.administrativo, cuerpo: { canal: 'whatsapp' } });
        assert.equal(canalInvalido.status, 400);
        const r = await pedir('POST', `/api/usuarios/${usuarioId}/codigo-restablecer`, { token: tokens.administrativo, cuerpo: { canal: 'manual' } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.match(r.body.mensaje, /\/recuperar/);

        // la clave actual sigue valiendo hasta que se canjee el codigo
        assert.equal((await pedir('POST', '/api/auth/login', { cuerpo: { email, password: 'clave-inicial-1' } })).status, 200);
        const canje = await pedir('POST', '/api/auth/codigo/confirmar', {
            cuerpo: { email, codigo: codigoDelTexto(r.body.mensaje), password: 'clave-restablecida-1' },
        });
        assert.equal(canje.status, 200);
        assert.equal(canje.body.proposito, 'recuperar_password');
        assert.equal((await pedir('POST', '/api/auth/login', { cuerpo: { email, password: 'clave-inicial-1' } })).status, 401);
        assert.equal((await pedir('POST', '/api/auth/login', { cuerpo: { email, password: 'clave-restablecida-1' } })).status, 200);
    });

    test('olvide mi contrasena: mismo texto exista o no la cuenta, y el codigo llega por correo', async (t) => {
        if (!requiereBase(t)) return;
        conCorreoConfigurado();
        try {
            const antes = correosEnviados.length;
            const existe = await pedir('POST', '/api/auth/recuperar', { cuerpo: { email: email.toUpperCase() } });
            const noExiste = await pedir('POST', '/api/auth/recuperar', { cuerpo: { email: correoPrueba('no-existe') } });
            assert.equal(existe.status, 200);
            assert.deepEqual(existe.body, noExiste.body);

            // el correo sale despues de responder
            for (let i = 0; i < 50 && correosEnviados.length === antes; i++) await new Promise((r) => setTimeout(r, 20));
            assert.equal(correosEnviados.length, antes + 1, 'solo la cuenta que existe recibe correo');
            const enviado = correosEnviados[correosEnviados.length - 1];
            assert.deepEqual(enviado.to, [email]);

            // un segundo pedido dentro del minuto no manda otro correo
            await pedir('POST', '/api/auth/recuperar', { cuerpo: { email } });
            await new Promise((r) => setTimeout(r, 200));
            assert.equal(correosEnviados.length, antes + 1);

            const canje = await pedir('POST', '/api/auth/codigo/confirmar', {
                cuerpo: { email, codigo: codigoDelTexto(enviado.text), password: 'clave-por-correo-1' },
            });
            assert.equal(canje.status, 200);
            assert.equal((await pedir('POST', '/api/auth/login', { cuerpo: { email, password: 'clave-por-correo-1' } })).status, 200);
        } finally {
            sinCorreoConfigurado();
        }
    });

    test('cambiar la clave propia corta las otras sesiones y entrega un token nuevo', async (t) => {
        if (!requiereBase(t)) return;
        const login = await pedir('POST', '/api/auth/login', { cuerpo: { email, password: 'clave-por-correo-1' } });
        const tokenViejo = login.body.token;
        const mala = await pedir('POST', '/api/auth/cambiar-password', { token: tokenViejo, cuerpo: { actual: 'no-es-esta', nueva: 'clave-cambiada-1' } });
        assert.equal(mala.status, 400, 'una clave actual equivocada no debe cerrar la sesion con un 401');
        const igual = await pedir('POST', '/api/auth/cambiar-password', { token: tokenViejo, cuerpo: { actual: 'clave-por-correo-1', nueva: 'clave-por-correo-1' } });
        assert.equal(igual.status, 400);

        const r = await pedir('POST', '/api/auth/cambiar-password', { token: tokenViejo, cuerpo: { actual: 'clave-por-correo-1', nueva: 'clave-cambiada-1' } });
        assert.equal(r.status, 200);
        assert.equal((await pedir('GET', '/api/usuarios/mi-perfil', { token: tokenViejo })).status, 401);
        assert.equal((await pedir('GET', '/api/usuarios/mi-perfil', { token: r.body.token })).status, 200);
    });

    test('una cuenta desactivada no recupera la clave con un codigo pendiente', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', `/api/usuarios/${usuarioId}/codigo-restablecer`, { token: tokens.administrativo, cuerpo: { canal: 'manual' } });
        await pedir('PATCH', `/api/usuarios/${usuarioId}/estado`, { token: tokens.administrativo, cuerpo: { activo: false } });
        const canje = await pedir('POST', '/api/auth/codigo/confirmar', {
            cuerpo: { email, codigo: codigoDelTexto(r.body.mensaje), password: 'clave-de-desactivada' },
        });
        assert.equal(canje.status, 400);
    });
});
