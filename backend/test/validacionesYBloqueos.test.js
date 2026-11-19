// Validacion de dinero, cliente del equipo por guia, orden de bloqueo, cuentas del equipo y push.
// Corren contra una base local; ver utils/entornoEscritura.js (GOMAQ_TEST_ESCRITURA=1 npm test).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { requiereBase, leerRespuesta } = require('./utils/http');
const {
    pool,
    datos,
    tokens,
    entorno,
    HABILITADO,
    pedir,
    crearOt,
    MOTIVO_VALIDO,
    crearEquipo,
    algunCliente,
    cerrarOt,
    facturarDirecto,
    agregarLinea,
    esperarBloqueos,
} = require('./utils/entornoEscritura');

async function crearClienteDePrueba(nombre) {
    const r = await pool.query('INSERT INTO clientes (nombre) VALUES ($1) RETURNING id', [`${nombre} ${crypto.randomUUID().slice(0, 6)}`]);
    datos.clientes.push(r.rows[0].id);
    return r.rows[0].id;
}

const haceDias = (n) => new Date(Date.now() - n * 86400000).toISOString();

async function clienteDelEquipo(id) {
    return (await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [id])).rows[0].cliente_id;
}

describe('validacion de dinero y cantidades (hallazgos del QA)', () => {
    test('corregir el monto de una factura exige pesos enteros', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        await facturarDirecto(ot, 'T-3001');
        const id = (await pool.query('SELECT id FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows[0].id;
        for (const malo of [1234.5, -5, 'abc', '1e3']) {
            const r = await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { monto: malo });
            assert.equal(r.status, 400, String(malo));
        }
        assert.equal(Number((await pool.query('SELECT monto FROM facturas WHERE id = $1', [id])).rows[0].monto), 100000);
        const bien = await pedir('PATCH', `/api/facturacion/${id}`, 'administrativo', { monto: 123456 });
        assert.equal(bien.status, 200);
        assert.equal(Number(bien.body.monto), 123456);
    });

    test('la valorizacion de la OT exige pesos enteros', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, null);
        for (const malo of [5000.5, -10, 'abc', '1e3']) {
            const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: malo });
            assert.equal(r.status, 400, String(malo));
        }
        const bien = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 5000 });
        assert.equal(bien.status, 200);
    });

    test('crear un insumo valida el costo y conserva el 0', async (t) => {
        if (!requiereBase(t)) return;
        const crear = (costo) => pedir('POST', '/api/insumos', 'administrativo', { nombre: `Insumo QA ${Date.now()}`, unidad_medida: 'lt', costo_unitario: costo });
        for (const malo of [-50, 99.5, 'abc', '1e3']) {
            assert.equal((await crear(malo)).status, 400, String(malo));
        }
        const cero = await crear(0);
        assert.equal(cero.status, 201);
        assert.equal(Number(cero.body.costo_unitario), 0);
        const sin = await crear(undefined);
        assert.equal(sin.status, 201);
        assert.equal(sin.body.costo_unitario, null);
        const mal = await pedir('PATCH', `/api/insumos/${cero.body.id}`, 'administrativo', { costo_unitario: 12.5 });
        assert.equal(mal.status, 400);
        await pool.query('DELETE FROM insumos WHERE id = ANY($1)', [[cero.body.id, sin.body.id]]);
    });

    test('la cantidad de un repuesto acepta litros (2 decimales) pero no exponente', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        const agregar = (cantidad) => pedir('POST', `/api/insumos/orden/${ot}`, 'administrativo', { cantidad, descripcion: 'Aceite', precio_unitario: 1000 });
        for (const mala of ['1e3', '1.234', 0, -1, 'abc']) {
            assert.equal((await agregar(mala)).status, 400, String(mala));
        }
        assert.equal((await agregar(0.5)).status, 201);
    });

    test('un id de insumo no numerico responde 400 y no 500', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('POST', '/api/insumos/abc/ingreso', 'administrativo', { cantidad: 1 });
        assert.equal(r.status, 400);
    });
});

describe('el cliente del equipo sale de la guia mas reciente por fecha', () => {
    const guia = (equipo, cuerpo) => pedir('POST', `/api/maquinarias/${equipo}/guias`, 'administrativo', { sin_documento: true, ...cuerpo });

    test('una recepcion atrasada no deja sin cliente a un equipo con un despacho mas nuevo', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearClienteDePrueba('Cliente A');
        const b = await crearClienteDePrueba('Cliente B');
        const equipo = await crearEquipo();
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: a, fecha_hora: haceDias(20) })).status, 201);
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: b, fecha_hora: haceDias(1) })).status, 201);
        assert.equal(await clienteDelEquipo(equipo.id), b);
        // llega tarde la recepcion que cerraba el arriendo de A, 10 dias atras
        const recepcion = await guia(equipo.id, { tipo: 'recepcion', fecha_hora: haceDias(10) });
        assert.equal(recepcion.status, 201);
        assert.equal(await clienteDelEquipo(equipo.id), b, 'el equipo sigue con B: su despacho es mas nuevo que la recepcion');
        // la guia de recepcion queda a nombre del cliente que tenia el equipo en SU fecha (A)
        assert.equal(recepcion.body.cliente_id, a);
    });

    test('un despacho atrasado no pisa un despacho mas nuevo', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearClienteDePrueba('Cliente A');
        const b = await crearClienteDePrueba('Cliente B');
        const equipo = await crearEquipo();
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: b, fecha_hora: haceDias(1) })).status, 201);
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: a, fecha_hora: haceDias(5) })).status, 201);
        assert.equal(await clienteDelEquipo(equipo.id), b);
    });

    test('un despacho atrasado no ocupa un equipo cuya ultima guia es una recepcion', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearClienteDePrueba('Cliente A');
        const equipo = await crearEquipo();
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: a, fecha_hora: haceDias(30) })).status, 201);
        assert.equal((await guia(equipo.id, { tipo: 'recepcion', fecha_hora: haceDias(1) })).status, 201);
        assert.equal(await clienteDelEquipo(equipo.id), null);
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: a, fecha_hora: haceDias(10) })).status, 201);
        assert.equal(await clienteDelEquipo(equipo.id), null, 'la recepcion mas reciente manda');
    });

    test('una guia fallida no cambia el cliente del equipo', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearClienteDePrueba('Cliente A');
        const b = await crearClienteDePrueba('Cliente B');
        const equipo = await crearEquipo();
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: a, fecha_hora: haceDias(5) })).status, 201);
        assert.equal((await guia(equipo.id, { tipo: 'despacho', cliente_id: b, fecha_hora: haceDias(1), fallido: true })).status, 201);
        assert.equal(await clienteDelEquipo(equipo.id), a);
    });

    test('despachos simultaneos a clientes distintos: queda el de la guia con fecha mas reciente', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearClienteDePrueba('Cliente A');
        const b = await crearClienteDePrueba('Cliente B');
        for (let i = 0; i < 12; i++) {
            const equipo = await crearEquipo();
            // el orden de llegada cambia entre vueltas: la ganadora es siempre la de fecha mas nueva
            const viejo = () => guia(equipo.id, { tipo: 'despacho', cliente_id: a, fecha_hora: haceDias(2) });
            const nuevo = () => guia(equipo.id, { tipo: 'despacho', cliente_id: b, fecha_hora: haceDias(1) });
            const resultados = await Promise.all(i % 2 === 0 ? [viejo(), nuevo()] : [nuevo(), viejo()]);
            assert.deepEqual(resultados.map((r) => r.status), [201, 201], `vuelta ${i}`);
            assert.equal(await clienteDelEquipo(equipo.id), b, `vuelta ${i}`);
        }
    });

    test('la guia espera si otra transaccion tiene bloqueado el equipo', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearClienteDePrueba('Cliente A');
        const equipo = await crearEquipo();
        const otra = await pool.connect();
        try {
            await otra.query('BEGIN');
            await otra.query('SELECT 1 FROM maquinarias WHERE id = $1 FOR NO KEY UPDATE', [equipo.id]);
            let terminada = false;
            const pendiente = guia(equipo.id, { tipo: 'despacho', cliente_id: a }).then((r) => { terminada = true; return r; });
            await esperarBloqueos(1, '%FROM maquinarias%');
            assert.equal(terminada, false, 'la guia no debe avanzar mientras el equipo esta bloqueado');
            await otra.query('COMMIT');
            assert.equal((await pendiente).status, 201);
        } finally {
            otra.release();
        }
        assert.equal(await clienteDelEquipo(equipo.id), a);
    });
});

describe('orden de bloqueo OT -> equipo sin ciclos', () => {
    test('un cierre de OT y una lectura de horometro con esa OT no se bloquean entre si', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo();
        const ot = await crearOt('en_terreno', datos.mecanicoId, equipo.id);
        const otra = await pool.connect();
        try {
            // esta transaccion hace lo que hace una lectura de horometro: toma el equipo y despues
            // inserta una lectura que apunta a la OT (KEY SHARE sobre la OT)
            await otra.query('BEGIN');
            await otra.query('SELECT 1 FROM maquinarias WHERE id = $1 FOR NO KEY UPDATE', [equipo.id]);
            // el cierre toma la OT y pide el equipo: queda esperando a la transaccion de arriba
            const cierre = pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { sin_persona: true });
            await esperarBloqueos(1, '%FROM maquinarias%');
            // con FOR UPDATE sobre la OT esto formaba un ciclo (deadlock); con FOR NO KEY UPDATE no
            await otra.query(
                `INSERT INTO lecturas_horometro (maquinaria_id, valor, origen, orden_trabajo_id, usuario_id)
                 VALUES ($1, 10, 'panel', $2, $3)`,
                [equipo.id, ot, datos.mecanicoId]
            );
            await otra.query('COMMIT');
            const r = await cierre;
            assert.equal(r.status, 200, JSON.stringify(r.body));
        } finally {
            await otra.query('ROLLBACK').catch(() => {});
            otra.release();
        }
    });

    test('dos mecanicos abriendo una OT en terreno sobre el mismo equipo a la vez no se bloquean', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo();
        const usados = [];
        for (let vuelta = 0; vuelta < 8; vuelta++) {
            const abrir = (rol) => {
                const uuid = crypto.randomUUID();
                return pedir('POST', '/api/ordenes-trabajo/en-terreno', rol, { maquinaria_id: equipo.id, uuid_cliente: uuid });
            };
            const rs = await Promise.all([abrir('mecanico'), abrir('mecanicoDos'), abrir('mecanico'), abrir('mecanicoDos')]);
            for (const r of rs) {
                assert.equal(r.status, 201, `vuelta ${vuelta}: ${JSON.stringify(r.body)}`);
                usados.push(r.body.id);
            }
        }
        datos.ordenes.push(...usados);
    });

    test('una lectura de horometro con una OT que no existe responde 400', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo();
        const r = await pedir('POST', `/api/horometro/maquinaria/${equipo.id}`, 'administrativo', { valor: 5, orden_trabajo_id: 2000000000 });
        assert.equal(r.status, 400);
    });
});

describe('cuentas del equipo: asignar a un desactivado y aprobar con correo repetido', () => {
    test('asignar una OT a un mecanico desactivado responde 400', async (t) => {
        if (!requiereBase(t)) return;
        const correo = `desactivado-${crypto.randomUUID()}@gomaq.test`;
        const u = await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, estado_cuenta)
             VALUES ('Mecanico desactivado de prueba', $1, 'x', 'mecanico', 'rechazado') RETURNING id`,
            [correo]
        );
        try {
            const ot = await crearOt('pendiente', null);
            const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: u.rows[0].id });
            assert.equal(r.status, 400, JSON.stringify(r.body));
            assert.match(r.body.error, /desactivado/);
        } finally {
            await pool.query('DELETE FROM usuarios WHERE id = $1', [u.rows[0].id]);
        }
    });

    test('un administrativo no puede cambiar la clave, el estado ni pedir codigos de una cuenta de gerente', async (t) => {
        if (!requiereBase(t)) return;
        const gerente = await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, estado_cuenta)
             VALUES ('Gerente de prueba', $1, 'hash-original', 'gerente', 'activo') RETURNING id`,
            [`gerente-${crypto.randomUUID()}@gomaq.test`]
        );
        const id = gerente.rows[0].id;
        const inicio = (await pool.query('SELECT now() AS t')).rows[0].t;
        await pool.query('UPDATE usuarios SET recibe_alertas_mantencion = true WHERE id = $1', [id]);
        try {
            const clave = await pedir('POST', `/api/usuarios/${id}/password`, 'administrativo', { password: 'ClaveNueva-123' });
            assert.equal(clave.status, 403, JSON.stringify(clave.body));
            const estado = await pedir('PATCH', `/api/usuarios/${id}/estado`, 'administrativo', { activo: false });
            assert.equal(estado.status, 403, JSON.stringify(estado.body));
            const codigo = await pedir('POST', `/api/usuarios/${id}/codigo-restablecer`, 'administrativo', { canal: 'manual' });
            assert.equal(codigo.status, 403, JSON.stringify(codigo.body));
            const invitacion = await pedir('POST', `/api/usuarios/${id}/invitacion`, 'administrativo', { canal: 'manual' });
            assert.equal(invitacion.status, 403, JSON.stringify(invitacion.body));
            const alertas = await pedir('PATCH', `/api/usuarios/${id}/alertas`, 'administrativo', { recibe_alertas_mantencion: false });
            assert.equal(alertas.status, 403, JSON.stringify(alertas.body));

            const fila = (await pool.query('SELECT password_hash, estado_cuenta, recibe_alertas_mantencion FROM usuarios WHERE id = $1', [id])).rows[0];
            assert.equal(fila.password_hash, 'hash-original', 'la clave no cambio');
            assert.equal(fila.estado_cuenta, 'activo', 'sigue activa');
            assert.equal(fila.recibe_alertas_mantencion, true, 'sus alertas no cambiaron');
            assert.equal((await pedir('PATCH', `/api/usuarios/${id}/alertas`, 'gerente', { recibe_alertas_mantencion: false })).status, 200);
            const codigos = await pool.query('SELECT 1 FROM codigos_cuenta WHERE usuario_id = $1', [id]);
            assert.equal(codigos.rows.length, 0, 'no se genero ningun codigo');

            // un gerente si puede gestionar a otro gerente
            const siGerente = await pedir('POST', `/api/usuarios/${id}/password`, 'gerente', { password: 'ClaveNueva-123' });
            assert.equal(siGerente.status, 200, JSON.stringify(siGerente.body));
            // y el administrativo sigue gestionando a mecanicos y administrativos
            const mecanico = await pedir('POST', `/api/usuarios/${datos.mecanicoId}/codigo-restablecer`, 'administrativo', { canal: 'manual' });
            assert.equal(mecanico.status, 200, JSON.stringify(mecanico.body));
        } finally {
            await pool.query('DELETE FROM codigos_cuenta WHERE usuario_id = $1 AND created_at >= $2', [datos.mecanicoId, inicio]);
            await pool.query('DELETE FROM sesiones WHERE usuario_id = $1', [id]);
            await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
        }
    });

    test('aprobar una solicitud cuyo correo ya tiene cuenta (otra capitalizacion) responde 409', async (t) => {
        if (!requiereBase(t)) return;
        const correo = `duplicado-${crypto.randomUUID()}@gomaq.test`;
        const u = await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, estado_cuenta)
             VALUES ('Cuenta existente de prueba', $1, 'x', 'cliente', 'activo') RETURNING id`,
            [correo]
        );
        const s = await pool.query(
            `INSERT INTO solicitudes_cliente (nombre_contacto, email, password_hash) VALUES ('Contacto de prueba', $1, 'x') RETURNING id`,
            [correo.toUpperCase()]
        );
        try {
            const r = await pedir('POST', `/api/usuarios/solicitudes/${s.rows[0].id}/aprobar`, 'administrativo', {});
            assert.equal(r.status, 409, JSON.stringify(r.body));
        } finally {
            await pool.query('DELETE FROM solicitudes_cliente WHERE id = $1', [s.rows[0].id]);
            await pool.query('DELETE FROM usuarios WHERE id = $1', [u.rows[0].id]);
        }
    });

    test('aprobar una solicitud encola exactamente un correo de cuenta aprobada y el worker lo envia', async (t) => {
        if (!requiereBase(t)) return;
        const { procesarUna } = require('../src/workers/notificaciones');
        const correo = `aprobada-${crypto.randomUUID()}@gomaq.test`;
        const s = await pool.query(
            `INSERT INTO solicitudes_cliente (nombre_contacto, email, password_hash, correo_verificado_at)
             VALUES ('Contacto <Aprobado>', $1, 'x', now()) RETURNING id`,
            [correo]
        );
        const id = s.rows[0].id;
        const avisosDe = () => pool.query(
            `SELECT * FROM notificaciones_pendientes WHERE canal = 'email' AND destinatario = $1`, [correo]);
        const fetchOriginal = globalThis.fetch;
        const claveOriginal = process.env.RESEND_API_KEY;
        const panelOriginal = process.env.PANEL_URL;
        try {
            process.env.PANEL_URL = 'https://panel.gomaq.test';
            const r = await pedir('POST', `/api/usuarios/solicitudes/${id}/aprobar`, 'administrativo', {});
            assert.equal(r.status, 200, JSON.stringify(r.body));

            const filas = (await avisosDe()).rows;
            assert.equal(filas.length, 1, 'una sola fila');
            assert.equal(filas[0].estado, 'pendiente');
            assert.equal(filas[0].payload.tipo, 'cuenta_aprobada');
            assert.equal(filas[0].payload.nombre_contacto, 'Contacto <Aprobado>');
            assert.equal(filas[0].payload.url, 'https://panel.gomaq.test', 'la URL sale de la configuracion, no del host de la peticion');
            assert.deepEqual(Object.keys(filas[0].payload).sort(), ['nombre_contacto', 'tipo', 'url']);

            // aprobar de nuevo no manda otro correo
            const otra = await pedir('POST', `/api/usuarios/solicitudes/${id}/aprobar`, 'administrativo', {});
            assert.equal(otra.status, 404);
            assert.equal((await avisosDe()).rows.length, 1);

            // el worker, con Resend simulado, lo envia con el logo como unico adjunto
            const envios = [];
            process.env.RESEND_API_KEY = 're_prueba';
            globalThis.fetch = async (url, opciones) => {
                envios.push({ url, cuerpo: JSON.parse(opciones.body) });
                return { ok: true, status: 200, json: async () => ({ id: 'correo-simulado' }), text: async () => '{}' };
            };
            await procesarUna(filas[0]);
            assert.equal(envios.length, 1);
            assert.deepEqual(envios[0].cuerpo.to, [correo]);
            assert.equal(envios[0].cuerpo.subject, 'Tu cuenta de GOMAQ fue aprobada');
            assert.match(envios[0].cuerpo.html, /Contacto &lt;Aprobado&gt;/);
            assert.ok(envios[0].cuerpo.attachments.every((a) => a.content_id), 'solo el logo incrustado');
            const despues = (await avisosDe()).rows[0];
            assert.equal(despues.estado, 'enviado');
            assert.ok(despues.enviado_at);
        } finally {
            globalThis.fetch = fetchOriginal;
            if (claveOriginal === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = claveOriginal;
            if (panelOriginal === undefined) delete process.env.PANEL_URL; else process.env.PANEL_URL = panelOriginal;
            await pool.query(`DELETE FROM notificaciones_pendientes WHERE canal = 'email' AND destinatario = $1`, [correo]);
            const sol = await pool.query('SELECT cliente_id, usuario_id FROM solicitudes_cliente WHERE id = $1', [id]);
            await pool.query('DELETE FROM solicitudes_cliente WHERE id = $1', [id]);
            if (sol.rows[0] && sol.rows[0].usuario_id) await pool.query('DELETE FROM usuarios WHERE id = $1', [sol.rows[0].usuario_id]);
            if (sol.rows[0] && sol.rows[0].cliente_id) await pool.query('DELETE FROM clientes WHERE id = $1', [sol.rows[0].cliente_id]);
        }
    });
});

describe('push: dispositivos, avisos de OT y canal del worker', () => {
    const { crearSesion } = require('../src/services/sesiones');
    const { procesarUna, usarEnvio } = require('../src/workers/notificaciones');
    let inicio;

    /** Cuenta de prueba (se borra al terminar la corrida) y su token. */
    async function crearUsuario(rol, estado = 'activo') {
        const r = await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, estado_cuenta)
             VALUES ('Prueba push', $1, 'x', $2::rol_usuario, $3) RETURNING id`,
            [`push-${crypto.randomUUID()}@gomaq.test`, rol, estado]
        );
        const id = r.rows[0].id;
        datos.usuariosPush.push(id);
        return { id, token: jwt.sign({ id, rol, cliente_id: null }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
    }

    const tokenFcm = () => `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');

    async function llamar(metodo, ruta, token, cuerpo, cabeceras = {}) {
        const headers = { 'Content-Type': 'application/json', ...cabeceras };
        if (token) headers.Authorization = `Bearer ${token}`;
        const r = await fetch(`${entorno.base}${ruta}`, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
        return leerRespuesta(r);
    }

    const registrar = (token, tokenDispositivo, extra = {}) =>
        llamar('POST', '/api/dispositivos', token, { token: tokenDispositivo, plataforma: 'android', app: 'terreno', ...extra });

    async function dispositivo(tokenDispositivo) {
        return (await pool.query('SELECT * FROM dispositivos_push WHERE token = $1', [tokenDispositivo])).rows[0];
    }

    /** Registra un dispositivo activo directo en la base. */
    async function crearDispositivo(usuarioId, app = 'terreno') {
        const r = await pool.query(
            `INSERT INTO dispositivos_push (usuario_id, plataforma, app, token) VALUES ($1, 'android', $2, $3) RETURNING id`,
            [usuarioId, app, tokenFcm()]
        );
        return Number(r.rows[0].id);
    }

    async function filasPush(ordenId, tipo) {
        return (await pool.query(
            `SELECT destinatario, payload FROM notificaciones_pendientes
             WHERE canal = 'push' AND payload->>'tipo' = $1 AND (payload->>'orden_trabajo_id')::int = $2 ORDER BY id`,
            [tipo, ordenId])).rows;
    }

    async function conPush(fn) {
        process.env.PUSH_HABILITADO = '1';
        try { return await fn(); } finally { delete process.env.PUSH_HABILITADO; }
    }

    before(() => { inicio = new Date(Date.now() - 2000); });

    after(async () => {
        if (!HABILITADO) return;
        usarEnvio(null);
        // las filas push de OT que no registraron las pruebas (se borran las del periodo)
        await pool.query(`DELETE FROM notificaciones_pendientes WHERE canal = 'push' AND created_at >= $1`, [inicio]);
    });

    test('sin token de sesion el registro y la baja responden 401', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await llamar('POST', '/api/dispositivos', null, { token: tokenFcm(), plataforma: 'android', app: 'terreno' })).status, 401);
        assert.equal((await llamar('DELETE', '/api/dispositivos', null, { token: tokenFcm() })).status, 401);
    });

    test('un mecanico registra su dispositivo; registrar el mismo token otra vez no duplica', async (t) => {
        if (!requiereBase(t)) return;
        const mec = await crearUsuario('mecanico');
        const tok = tokenFcm();
        const r = await registrar(mec.token, tok);
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.deepEqual(Object.keys(r.body), ['id'], 'la respuesta no devuelve el token');
        const fila = await dispositivo(tok);
        assert.equal(fila.usuario_id, mec.id);
        assert.equal(fila.app, 'terreno');
        assert.equal(fila.plataforma, 'android');
        assert.equal(fila.activo, true);
        assert.equal(fila.sesion_id, null, 'un JWT antiguo no tiene sesion en la base');
        const otra = await registrar(mec.token, tok);
        assert.equal(otra.status, 201);
        assert.equal(otra.body.id, r.body.id);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM dispositivos_push WHERE token = $1', [tok])).rows[0].n, 1);
    });

    test('el registro valida el token, la plataforma y la app', async (t) => {
        if (!requiereBase(t)) return;
        const mec = await crearUsuario('mecanico');
        for (const malo of [undefined, null, 123, '', 'corto', 'x'.repeat(5000), `${tokenFcm()} con espacios`, `${tokenFcm()}\n`, { $ne: 1 }, [tokenFcm()]]) {
            assert.equal((await registrar(mec.token, malo)).status, 400, JSON.stringify(malo));
        }
        assert.equal((await registrar(mec.token, tokenFcm(), { plataforma: 'ios' })).status, 400);
        assert.equal((await registrar(mec.token, tokenFcm(), { plataforma: undefined })).status, 400);
        assert.equal((await registrar(mec.token, tokenFcm(), { app: 'otra' })).status, 400);
        assert.equal((await llamar('POST', '/api/dispositivos', mec.token, undefined)).status, 400);
    });

    test('la app terreno es solo del rol mecanico; el panel lo usan los demas', async (t) => {
        if (!requiereBase(t)) return;
        for (const rol of ['administrativo', 'gerente', 'cliente']) {
            const u = await crearUsuario(rol);
            const bloqueado = tokenFcm();
            assert.equal((await registrar(u.token, bloqueado, { app: 'terreno' })).status, 403, rol);
            assert.equal(await dispositivo(bloqueado), undefined, 'no deja fila');
            assert.equal((await registrar(u.token, tokenFcm(), { app: 'panel', plataforma: 'web' })).status, 201, rol);
        }
    });

    test('cada usuario solo toca sus dispositivos: borrar un token ajeno responde 204 y no hace nada', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearUsuario('mecanico');
        const b = await crearUsuario('mecanico');
        const tokA = tokenFcm();
        assert.equal((await registrar(a.token, tokA)).status, 201);
        const ajeno = await llamar('DELETE', '/api/dispositivos', b.token, { token: tokA });
        assert.equal(ajeno.status, 204);
        assert.equal((await dispositivo(tokA)).activo, true, 'el token de A sigue activo');
        assert.equal((await llamar('DELETE', '/api/dispositivos', b.token, { token: tokenFcm() })).status, 204, 'token que no existe');
        assert.equal((await llamar('DELETE', '/api/dispositivos', b.token, { token: 'basura' })).status, 204, 'token invalido');
        assert.equal((await llamar('DELETE', '/api/dispositivos', b.token, undefined)).status, 204, 'sin cuerpo');
        assert.equal((await llamar('DELETE', '/api/dispositivos', a.token, { token: tokA })).status, 204);
        assert.equal((await dispositivo(tokA)).activo, false, 'A si puede apagar el suyo');
    });

    test('si el telefono pasa a otro mecanico, el token se reasigna y el anterior deja de recibir en el', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearUsuario('mecanico');
        const b = await crearUsuario('mecanico');
        const tok = tokenFcm();
        await registrar(a.token, tok);
        await llamar('DELETE', '/api/dispositivos', a.token, { token: tok });
        assert.equal((await registrar(b.token, tok)).status, 201);
        const fila = await dispositivo(tok);
        assert.equal(fila.usuario_id, b.id);
        assert.equal(fila.activo, true);
    });

    test('tope de 10 dispositivos activos por usuario: quedan los mas recientes', async (t) => {
        if (!requiereBase(t)) return;
        const mec = await crearUsuario('mecanico');
        const tokens = [];
        for (let i = 0; i < 12; i++) {
            const tok = tokenFcm();
            tokens.push(tok);
            assert.equal((await registrar(mec.token, tok)).status, 201);
        }
        const activos = await pool.query('SELECT token FROM dispositivos_push WHERE usuario_id = $1 AND activo', [mec.id]);
        assert.equal(activos.rows.length, 10);
        assert.equal((await dispositivo(tokens[0])).activo, false, 'el mas viejo se apago');
        assert.equal((await dispositivo(tokens[1])).activo, false);
        assert.equal((await dispositivo(tokens[11])).activo, true, 'el nuevo queda');
    });

    test('con sesion de la base el dispositivo queda ligado a ella y el logout lo desactiva', async (t) => {
        if (!requiereBase(t)) return;
        const mec = await crearUsuario('mecanico');
        const sesion = await crearSesion(pool, mec.id, { app: 'terreno' });
        const tokSesion = tokenFcm();
        const tokJwt = tokenFcm();
        assert.equal((await registrar(sesion.token, tokSesion)).status, 201);
        assert.equal((await registrar(mec.token, tokJwt)).status, 201, 'otro telefono con un JWT antiguo');
        assert.equal(String((await dispositivo(tokSesion)).sesion_id), String(sesion.sid));
        const salida = await llamar('POST', '/api/auth/logout', sesion.token);
        assert.equal(salida.status, 204);
        assert.equal((await dispositivo(tokSesion)).activo, false, 'el de la sesion cerrada se apaga');
        assert.equal((await dispositivo(tokJwt)).activo, true, 'los de otras sesiones siguen');
        // con la sesion revocada ya no se puede registrar
        assert.equal((await registrar(sesion.token, tokenFcm())).status, 401);
    });

    test('ot_disponible: con el flag apagado la OT sin tecnico no encola nada', async (t) => {
        if (!requiereBase(t)) return;
        const libre = await crearUsuario('mecanico');
        await crearDispositivo(libre.id);
        const equipo = await crearEquipo(null);
        const r = await pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, motivo: 'prueba push' });
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        assert.deepEqual(await filasPush(r.body.id, 'ot_disponible'), []);
    });

    test('ot_disponible: llega a los mecanicos libres con dispositivo y no a ocupados, inactivos ni a la oficina', async (t) => {
        if (!requiereBase(t)) return;
        const libre = await crearUsuario('mecanico');
        const libreDos = await crearUsuario('mecanico');
        const ocupado = await crearUsuario('mecanico');
        const inactivo = await crearUsuario('mecanico', 'rechazado');
        const sinDispositivo = await crearUsuario('mecanico');
        const oficina = await crearUsuario('administrativo');
        const dLibre = await crearDispositivo(libre.id);
        const dLibreDos = await crearDispositivo(libreDos.id);
        const dLibreDosb = await crearDispositivo(libreDos.id);
        await crearDispositivo(ocupado.id);
        await crearDispositivo(inactivo.id);
        await crearDispositivo(oficina.id, 'panel');
        const apagado = await crearDispositivo(libre.id);
        await pool.query('UPDATE dispositivos_push SET activo = false WHERE id = $1', [apagado]);
        // el ocupado tiene una OT en camino; uno con la OT solo asignada (aun no la acepta) sigue libre
        await crearOt('en_camino', ocupado.id);
        const conAsignada = await crearUsuario('mecanico');
        const dConAsignada = await crearDispositivo(conAsignada.id);
        await crearOt('asignada', conAsignada.id);
        const terminado = await crearUsuario('mecanico');
        const dTerminado = await crearDispositivo(terminado.id);
        await crearOt('finalizada', terminado.id);

        const equipo = await crearEquipo(null);
        const r = await conPush(() => pedir('POST', '/api/ordenes-trabajo', 'administrativo', { maquinaria_id: equipo.id, motivo: 'prueba push' }));
        assert.equal(r.status, 201);
        datos.ordenes.push(r.body.id);
        const filas = await filasPush(r.body.id, 'ot_disponible');
        const destinos = filas.map((f) => Number(f.destinatario)).sort((x, y) => x - y);
        // los dispositivos de mecanicos libres de esta prueba (puede haber otros de otras corridas: se filtra por los propios)
        const propios = new Set([dLibre, dLibreDos, dLibreDosb, dConAsignada, dTerminado]);
        assert.deepEqual(destinos.filter((d) => propios.has(d)), [...propios].sort((x, y) => x - y));
        assert.ok(!destinos.includes(apagado), 'un dispositivo apagado no recibe');
        const ajenos = destinos.filter((d) => !propios.has(d));
        const dispositivosAjenos = (await pool.query(
            `SELECT d.id FROM dispositivos_push d JOIN usuarios u ON u.id = d.usuario_id
             WHERE d.id = ANY($1) AND (u.id = ANY($2))`, [ajenos, [ocupado.id, inactivo.id, oficina.id, sinDispositivo.id]])).rows;
        assert.deepEqual(dispositivosAjenos, [], 'ni ocupados, ni inactivos, ni la oficina');
        const payload = filas[0].payload;
        assert.equal(payload.tipo, 'ot_disponible');
        assert.equal(payload.orden_trabajo_id, r.body.id);
        assert.ok(payload.usuario_id);
    });

    test('ot_disponible: tambien sale al convertir la solicitud del cliente en OT', async (t) => {
        if (!requiereBase(t)) return;
        const clienteId = await algunCliente();
        if (!clienteId) return t.skip('la base no tiene clientes');
        const libre = await crearUsuario('mecanico');
        const d = await crearDispositivo(libre.id);
        const equipo = await crearEquipo(clienteId);
        const sol = await pool.query(
            `INSERT INTO solicitudes (cliente_id, maquinaria_id, descripcion) VALUES ($1, $2, 'solicitud push') RETURNING id`,
            [clienteId, equipo.id]
        );
        datos.solicitudes.push(sol.rows[0].id);
        const r = await conPush(() => pedir('PATCH', `/api/solicitudes/${sol.rows[0].id}/convertir`, 'administrativo'));
        assert.equal(r.status, 200);
        const ot = r.body.orden_trabajo.id;
        datos.ordenes.push(ot);
        assert.ok((await filasPush(ot, 'ot_disponible')).some((f) => Number(f.destinatario) === d));
    });

    test('ot_disponible: la OT que abre el propio mecanico en terreno no avisa a nadie', async (t) => {
        if (!requiereBase(t)) return;
        const mec = await crearUsuario('mecanico');
        const otro = await crearUsuario('mecanico');
        await crearDispositivo(otro.id);
        const equipo = await crearEquipo(null);
        const r = await conPush(() => llamar('POST', '/api/ordenes-trabajo/en-terreno', mec.token,
            { maquinaria_id: equipo.id, motivo: 'segundo equipo', uuid_cliente: crypto.randomUUID() }));
        assert.equal(r.status, 201, JSON.stringify(r.body));
        datos.ordenes.push(r.body.id);
        assert.deepEqual(await filasPush(r.body.id, 'ot_disponible'), []);
    });

    test('asignar y reasignar: una fila push por dispositivo con el flag; sin el flag, ninguna', async (t) => {
        if (!requiereBase(t)) return;
        const a = await crearUsuario('mecanico');
        const b = await crearUsuario('mecanico');
        const dA1 = await crearDispositivo(a.id);
        const dA2 = await crearDispositivo(a.id);
        const dB = await crearDispositivo(b.id);
        const sinFlag = await crearOt('pendiente', null);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${sinFlag}/asignar`, 'administrativo', { mecanico_id: a.id })).status, 200);
        assert.deepEqual(await filasPush(sinFlag, 'ot_asignada'), []);

        const ot = await crearOt('pendiente', null);
        const asignar = (mecanicoId) => pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: mecanicoId });
        await conPush(async () => {
            assert.equal((await asignar(a.id)).status, 200);
            assert.equal((await asignar(a.id)).status, 200, 'doble clic');
            assert.equal((await asignar(b.id)).status, 200, 'reasignacion');
        });
        const asignadas = await filasPush(ot, 'ot_asignada');
        assert.deepEqual(asignadas.map((f) => Number(f.destinatario)).sort((x, y) => x - y), [dA1, dA2, dB].sort((x, y) => x - y));
        const reasignadas = await filasPush(ot, 'ot_reasignada');
        assert.deepEqual(reasignadas.map((f) => Number(f.destinatario)).sort((x, y) => x - y), [dA1, dA2].sort((x, y) => x - y));
        assert.ok(asignadas.every((f) => f.payload.usuario_id), 'cada fila lleva su usuario');
    });

    test('canal push del worker: sin credenciales de FCM queda pendiente, en espera, sin gastar intentos', async (t) => {
        if (!requiereBase(t)) return;
        const mec = await crearUsuario('mecanico');
        const d = await crearDispositivo(mec.id);
        const ot = await crearOt('asignada', mec.id);
        const n = (await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('push', $1, $2) RETURNING *`,
            [String(d), JSON.stringify({ tipo: 'ot_asignada', orden_trabajo_id: ot, usuario_id: mec.id })])).rows[0];
        const previo = process.env.FCM_CUENTA_SERVICIO;
        delete process.env.FCM_CUENTA_SERVICIO;
        usarEnvio(null);
        try {
            await procesarUna(n);
        } finally {
            if (previo !== undefined) process.env.FCM_CUENTA_SERVICIO = previo;
        }
        const fila = (await pool.query('SELECT estado, intentos, proximo_intento > now() + interval \'50 minutes\' AS espera FROM notificaciones_pendientes WHERE id = $1', [n.id])).rows[0];
        assert.equal(fila.estado, 'pendiente');
        assert.equal(fila.intentos, 0);
        assert.equal(fila.espera, true);
    });

    test('canal push del worker: se cancela si el dispositivo se desactivo, la sesion se cerro o la OT ya fue tomada', async (t) => {
        if (!requiereBase(t)) return;
        let enviados = 0;
        usarEnvio(async () => { enviados += 1; });
        const encolar = async (payload, dispositivoId) => (await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('push', $1, $2) RETURNING *`,
            [String(dispositivoId), JSON.stringify(payload)])).rows[0];
        const estadoDe = async (n) => (await pool.query('SELECT estado, ultimo_error FROM notificaciones_pendientes WHERE id = $1', [n.id])).rows[0];
        try {
            const mec = await crearUsuario('mecanico');
            const ot = await crearOt('asignada', mec.id);

            // sano: se envia
            const d1 = await crearDispositivo(mec.id);
            const sano = await encolar({ tipo: 'ot_asignada', orden_trabajo_id: ot, usuario_id: mec.id }, d1);
            await procesarUna(sano);
            assert.equal((await estadoDe(sano)).estado, 'enviado');
            assert.equal(enviados, 1);

            // dispositivo desactivado
            const d2 = await crearDispositivo(mec.id);
            await pool.query('UPDATE dispositivos_push SET activo = false WHERE id = $1', [d2]);
            const inactivo = await encolar({ tipo: 'ot_asignada', orden_trabajo_id: ot, usuario_id: mec.id }, d2);
            await procesarUna(inactivo);
            assert.equal((await estadoDe(inactivo)).estado, 'cancelado');

            // el dispositivo ahora es de otro usuario
            const otro = await crearUsuario('mecanico');
            const d3 = await crearDispositivo(otro.id);
            const deOtro = await encolar({ tipo: 'ot_asignada', orden_trabajo_id: ot, usuario_id: mec.id }, d3);
            await procesarUna(deOtro);
            assert.equal((await estadoDe(deOtro)).estado, 'cancelado');

            // sesion revocada
            const sesion = await crearSesion(pool, mec.id, { app: 'terreno' });
            const d4 = Number((await pool.query(
                `INSERT INTO dispositivos_push (usuario_id, sesion_id, plataforma, app, token) VALUES ($1, $2, 'android', 'terreno', $3) RETURNING id`,
                [mec.id, sesion.sid, tokenFcm()])).rows[0].id);
            await pool.query(`UPDATE sesiones SET revocada_at = now() WHERE id = $1`, [sesion.sid]);
            const revocada = await encolar({ tipo: 'ot_asignada', orden_trabajo_id: ot, usuario_id: mec.id }, d4);
            await procesarUna(revocada);
            assert.equal((await estadoDe(revocada)).estado, 'cancelado');

            // aviso viejo (mas de 6 h)
            const d5 = await crearDispositivo(mec.id);
            const viejo = await encolar({ tipo: 'ot_asignada', orden_trabajo_id: ot, usuario_id: mec.id }, d5);
            await pool.query(`UPDATE notificaciones_pendientes SET created_at = now() - interval '7 hours' WHERE id = $1`, [viejo.id]);
            await procesarUna(viejo);
            assert.equal((await estadoDe(viejo)).estado, 'cancelado');

            // ot_disponible: sigue sin asignar se envia; ya tomada se cancela
            const libre = await crearOt('pendiente', null);
            const d6 = await crearDispositivo(mec.id);
            const disponible = await encolar({ tipo: 'ot_disponible', orden_trabajo_id: libre, usuario_id: mec.id }, d6);
            await procesarUna(disponible);
            assert.equal((await estadoDe(disponible)).estado, 'enviado');
            const tomada = await encolar({ tipo: 'ot_disponible', orden_trabajo_id: ot, usuario_id: mec.id }, d6);
            await procesarUna(tomada);
            const t2 = await estadoDe(tomada);
            assert.equal(t2.estado, 'cancelado');
            assert.match(t2.ultimo_error, /tomada/);
            assert.equal(enviados, 2, 'solo los dos vigentes salieron');
        } finally {
            usarEnvio(null);
        }
    });

    test('canal push del worker: un token descartado por FCM apaga el dispositivo y cancela el aviso', async (t) => {
        if (!requiereBase(t)) return;
        const mec = await crearUsuario('mecanico');
        const d = await crearDispositivo(mec.id);
        const ot = await crearOt('asignada', mec.id);
        const n = (await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('push', $1, $2) RETURNING *`,
            [String(d), JSON.stringify({ tipo: 'ot_asignada', orden_trabajo_id: ot, usuario_id: mec.id })])).rows[0];
        usarEnvio(async () => { throw Object.assign(new Error('FCM respondio 404 (UNREGISTERED)'), { descartar: true }); });
        try {
            await procesarUna(n);
        } finally {
            usarEnvio(null);
        }
        const fila = (await pool.query('SELECT estado, intentos FROM notificaciones_pendientes WHERE id = $1', [n.id])).rows[0];
        assert.equal(fila.estado, 'cancelado');
        assert.equal(fila.intentos, 0);
        assert.equal((await pool.query('SELECT activo FROM dispositivos_push WHERE id = $1', [d])).rows[0].activo, false);
    });
    // ----- gerencia, administrativo y cliente (F3 y F4 del backend) -----

    /** Cuenta de prueba de cualquier rol, con empresa si es cliente. Como crearUsuario, pero con `cliente_id` y nombre. */
    async function crearUsuarioDe(rol, { clienteId = null, estado = 'activo', nombre = 'Prueba push' } = {}) {
        const r = await pool.query(
            `INSERT INTO usuarios (nombre, email, password_hash, rol, estado_cuenta, cliente_id)
             VALUES ($1, $2, 'x', $3::rol_usuario, $4, $5) RETURNING id`,
            [nombre, `push-${crypto.randomUUID()}@gomaq.test`, rol, estado, clienteId]
        );
        const id = r.rows[0].id;
        datos.usuariosPush.push(id);
        return { id, token: jwt.sign({ id, rol, cliente_id: clienteId }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
    }

    /**
     * Da un dispositivo del panel al gerente de la semilla (quien ejecuta la accion en las pruebas de exclusion) y lo
     * borra al terminar: el usuario no es de la prueba, asi que su dispositivo no se limpia solo.
     */
    async function conGerenteDeSemilla(fn) {
        const semilla = (await pool.query("SELECT id FROM usuarios WHERE email = 'admin@gomaq.test'")).rows[0].id;
        const d = await crearDispositivo(semilla, 'panel');
        try {
            return await fn(d);
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE canal = $1 AND destinatario = $2', ['push', String(d)]);
            await pool.query('DELETE FROM dispositivos_push WHERE id = $1', [d]);
        }
    }

    /** Ids de los dispositivos que recibieron un aviso de una OT, solo de los `propios` (otras corridas pueden dejar los suyos). */
    async function destinosPropios(ordenId, tipo, propios) {
        const filas = await filasPush(ordenId, tipo);
        const set = new Set(propios.map(Number));
        return filas.map((f) => Number(f.destinatario)).filter((d) => set.has(d)).sort((x, y) => x - y);
    }
    const ordenados = (...ids) => ids.map(Number).sort((x, y) => x - y);

    /** Los usuarios de oficina de una prueba, cada uno con su dispositivo del panel, y algunos que NO deben recibir. */
    async function oficinaDePrueba() {
        const g1 = await crearUsuarioDe('gerente');
        const g2 = await crearUsuarioDe('gerente');
        const adm = await crearUsuarioDe('administrativo');
        const dG1 = await crearDispositivo(g1.id, 'panel');
        const dG1b = await crearDispositivo(g1.id, 'panel');
        const dG2 = await crearDispositivo(g2.id, 'panel');
        const dAdm = await crearDispositivo(adm.id, 'panel');
        // los que no reciben: cuenta inactiva, dispositivo apagado, dispositivo de la app terreno, mecanico y cliente
        const inactivo = await crearUsuarioDe('administrativo', { estado: 'rechazado' });
        const dInactivo = await crearDispositivo(inactivo.id, 'panel');
        const apagado = await crearDispositivo(adm.id, 'panel');
        await pool.query('UPDATE dispositivos_push SET activo = false WHERE id = $1', [apagado]);
        const dTerreno = await crearDispositivo((await crearUsuarioDe('gerente')).id, 'terreno');
        const dMecanico = await crearDispositivo((await crearUsuarioDe('mecanico')).id, 'panel');
        const dCliente = await crearDispositivo((await crearUsuarioDe('cliente', { clienteId: await algunCliente() })).id, 'panel');
        return {
            g1, g2, adm, dG1, dG1b, dG2, dAdm,
            reciben: [dG1, dG1b, dG2, dAdm],
            recibenGerentes: [dG1, dG1b, dG2],
            noReciben: [dInactivo, apagado, dTerreno, dMecanico, dCliente],
        };
    }

    test('ot_por_valorizar: con el flag apagado no se encola nada; con el flag llega a gerentes y administrativos', async (t) => {
        if (!requiereBase(t)) return;
        const of = await oficinaDePrueba();
        const cerrarConRepuesto = async () => {
            const ot = await crearOt('en_reparacion');
            await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
            const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { observacion_final: 'listo' });
            assert.equal(r.status, 200, JSON.stringify(r.body));
            return ot;
        };
        const sinFlag = await cerrarConRepuesto();
        assert.deepEqual(await filasPush(sinFlag, 'ot_por_valorizar'), []);

        const ot = await conPush(cerrarConRepuesto);
        assert.deepEqual(await destinosPropios(ot, 'ot_por_valorizar', [...of.reciben, ...of.noReciben]), ordenados(...of.reciben));
        const filas = await filasPush(ot, 'ot_por_valorizar');
        assert.ok(filas.every((f) => f.payload.usuario_id), 'cada fila lleva su usuario');
        // el reintento del cierre (ya aplicado) no repite el aviso
        const antes = filas.length;
        await conPush(() => pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { observacion_final: 'listo' }));
        assert.equal((await filasPush(ot, 'ot_por_valorizar')).length, antes);
    });

    test('factura_anulada: solo a gerentes (no al administrativo) y no a quien la anula', async (t) => {
        if (!requiereBase(t)) return;
        const of = await oficinaDePrueba();
        const ot = await crearOt();
        await facturarDirecto(ot, `T-${crypto.randomUUID().slice(0, 8)}`);
        const factura = (await pool.query('SELECT id FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows[0];
        // la anula el gerente de la semilla: sus dispositivos quedan fuera, los demas gerentes reciben
        await conGerenteDeSemilla(async (dEjecuta) => {
            const resp = await conPush(() => pedir('POST', `/api/ordenes-trabajo/${ot}/factura/${factura.id}/anular`, 'gerente',
                { ...MOTIVO_VALIDO }, { 'Idempotency-Key': crypto.randomUUID() }));
            assert.equal(resp.status, 200, JSON.stringify(resp.body));
            assert.deepEqual(await destinosPropios(ot, 'factura_anulada', [...of.reciben, ...of.noReciben, dEjecuta]), ordenados(...of.recibenGerentes));
        });
        const [fila] = await filasPush(ot, 'factura_anulada');
        assert.deepEqual(Object.keys(fila.payload).sort(), ['folio', 'orden_trabajo_id', 'tipo', 'usuario_id'], 'sin monto ni motivo');
    });

    test('factura_anulada con el flag apagado no encola nada', async (t) => {
        if (!requiereBase(t)) return;
        await oficinaDePrueba();
        const ot = await crearOt();
        await facturarDirecto(ot, `T-${crypto.randomUUID().slice(0, 8)}`);
        const factura = (await pool.query('SELECT id FROM facturas WHERE orden_trabajo_id = $1', [ot])).rows[0];
        const r = await pedir('POST', `/api/ordenes-trabajo/${ot}/factura/${factura.id}/anular`, 'administrativo', { ...MOTIVO_VALIDO }, { 'Idempotency-Key': crypto.randomUUID() });
        assert.equal(r.status, 200);
        assert.deepEqual(await filasPush(ot, 'factura_anulada'), []);
    });

    test('ajuste_inventario por perdida: a todos los gerentes con dispositivo y no al administrativo que registra el conteo', async (t) => {
        if (!requiereBase(t)) return;
        const of = await oficinaDePrueba();
        const ubic = await pool.query("INSERT INTO ubicaciones_stock (nombre, tipo) VALUES ('Aviso push F3', 'bodega') RETURNING id");
        datos.ubicaciones.push(ubic.rows[0].id);
        const insumo = await pool.query("INSERT INTO insumos (nombre, unidad_medida) VALUES ('Insumo push F3', 'un') RETURNING id");
        datos.insumos.push(insumo.rows[0].id);
        await pool.query('INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad) VALUES ($1, $2, 10)', [ubic.rows[0].id, insumo.rows[0].id]);
        const contar = (contada, esperada) => pedir('POST', '/api/insumos/ajuste', 'administrativo', {
            ubicacion_id: ubic.rows[0].id, insumo_id: insumo.rows[0].id, cantidad_contada: contada, cantidad_esperada: esperada,
            motivo_codigo: 'perdida_robo', uuid_cliente: crypto.randomUUID(),
        });
        const delInsumo = async () => (await pool.query(
            `SELECT destinatario FROM notificaciones_pendientes WHERE canal = 'push' AND payload->>'tipo' = 'ajuste_inventario'
               AND payload->>'insumo_nombre' = 'Insumo push F3' AND created_at >= $1 ORDER BY id`, [inicio])).rows.map((f) => Number(f.destinatario));
        assert.equal((await contar(8, 10)).status, 201, 'sin flag');
        assert.deepEqual(await delInsumo(), []);
        // el conteo solo lo registra el administrativo: el aviso es de gerencia y no le llega a el
        const r = await conPush(() => contar(5, 8));
        assert.equal(r.status, 201, JSON.stringify(r.body));
        const propios = new Set([...of.reciben, ...of.noReciben].map(Number));
        assert.deepEqual((await delInsumo()).filter((d) => propios.has(d)).sort((x, y) => x - y), ordenados(...of.recibenGerentes));
    });

    test('mantencion_proxima: a los dispositivos de quienes tienen el aviso encendido; solo se marca si se encolo algo', async (t) => {
        if (!requiereBase(t)) return;
        const { encolarAvisoMantencion } = require('../src/routes/horometro');
        const quiere = await crearUsuarioDe('gerente');
        const quiereAdm = await crearUsuarioDe('administrativo');
        const noQuiere = await crearUsuarioDe('administrativo');
        const mecanicoConAviso = await crearUsuarioDe('mecanico');
        const dQuiere = await crearDispositivo(quiere.id, 'panel');
        const dQuiereAdm = await crearDispositivo(quiereAdm.id, 'panel');
        await crearDispositivo(noQuiere.id, 'panel');
        await crearDispositivo(mecanicoConAviso.id, 'panel');
        await pool.query('UPDATE usuarios SET recibe_alertas_mantencion = true WHERE id = ANY($1)', [[quiere.id, quiereAdm.id, mecanicoConAviso.id]]);
        const equipo = await crearEquipo(null);
        const maquinaria = { id: equipo.id, codigo: equipo.codigo, intervalo_mantencion_horas: 250 };
        const estado = { horas_usadas: 240, horas_restantes: 10, vencida: false };
        const enviada = async () => (await pool.query('SELECT alerta_mantencion_enviada AS e FROM maquinarias WHERE id = $1', [equipo.id])).rows[0].e;
        const filas = async () => (await pool.query(
            `SELECT destinatario FROM notificaciones_pendientes WHERE canal = 'push' AND payload->>'tipo' = 'mantencion_proxima'
               AND (payload->>'maquinaria_id')::int = $1 ORDER BY id`, [equipo.id])).rows.map((f) => Number(f.destinatario));

        assert.equal(await encolarAvisoMantencion(pool, maquinaria, estado), 0, 'sin flag');
        assert.deepEqual(await filas(), []);
        assert.equal(await enviada(), false, 'sin encolar no se marca como enviada');

        assert.equal(await conPush(() => encolarAvisoMantencion(pool, maquinaria, estado)), 2);
        assert.deepEqual((await filas()).sort((x, y) => x - y), ordenados(dQuiere, dQuiereAdm), 'ni el que no lo quiere ni el mecanico');
        assert.equal(await enviada(), true);
    });

    test('asistencia_nueva: la asistencia del cliente avisa a gerentes y administrativos, sin texto libre; sin flag, a nadie', async (t) => {
        if (!requiereBase(t)) return;
        const of = await oficinaDePrueba();
        const clienteId = await crearClienteDePrueba('Cliente asistencia push');
        const tokenCliente = (await crearUsuarioDe('cliente', { clienteId })).token;
        const pedirAsistencia = async (equipoId) => {
            const r = await llamar('POST', '/api/solicitudes', tokenCliente,
                { maquinaria_id: equipoId, descripcion: 'Texto libre reservado del cliente', gravedad: 'fuera_de_servicio' });
            assert.equal(r.status, 201, JSON.stringify(r.body));
            datos.solicitudes.push(r.body.id);
            datos.ordenes.push(r.body.orden_trabajo_id);
            return r.body.orden_trabajo_id;
        };
        const sinFlag = await pedirAsistencia((await crearEquipo(clienteId)).id);
        assert.deepEqual(await filasPush(sinFlag, 'asistencia_nueva'), []);

        const ot = await conPush(async () => pedirAsistencia((await crearEquipo(clienteId)).id));
        assert.deepEqual(await destinosPropios(ot, 'asistencia_nueva', [...of.reciben, ...of.noReciben]), ordenados(...of.reciben));
        const [fila] = await filasPush(ot, 'asistencia_nueva');
        assert.deepEqual(Object.keys(fila.payload).sort(), ['maquinaria_codigo', 'orden_trabajo_id', 'tipo', 'usuario_id']);
        assert.ok(!JSON.stringify(fila.payload).includes('reservado') && !JSON.stringify(fila.payload).includes('fuera_de_servicio'));
    });

    /** Dos empresas con sus usuarios cliente y dispositivos del panel. */
    async function empresasDePrueba() {
        const clienteA = await crearClienteDePrueba('Empresa A push');
        const clienteB = await crearClienteDePrueba('Empresa B push');
        const a1 = await crearUsuarioDe('cliente', { clienteId: clienteA });
        const a2 = await crearUsuarioDe('cliente', { clienteId: clienteA });
        const aInactivo = await crearUsuarioDe('cliente', { clienteId: clienteA, estado: 'rechazado' });
        const b1 = await crearUsuarioDe('cliente', { clienteId: clienteB });
        const dA1 = await crearDispositivo(a1.id, 'panel');
        const dA2 = await crearDispositivo(a2.id, 'panel');
        const dA2b = await crearDispositivo(a2.id, 'panel');
        const dAInactivo = await crearDispositivo(aInactivo.id, 'panel');
        const dB1 = await crearDispositivo(b1.id, 'panel');
        // un administrativo y un cliente sin dispositivo no cuentan
        await crearUsuarioDe('cliente', { clienteId: clienteA });
        const dOficina = await crearDispositivo((await crearUsuarioDe('administrativo')).id, 'panel');
        return { clienteA, clienteB, deA: [dA1, dA2, dA2b], noReciben: [dAInactivo, dB1, dOficina] };
    }

    test('mecanico_asignado y ot_finalizada: push solo a los usuarios de LA empresa de la orden, nunca de otra', async (t) => {
        if (!requiereBase(t)) return;
        const e = await empresasDePrueba();
        const equipoA = await crearEquipo(e.clienteA);
        const equipoSinFlag = await crearEquipo(e.clienteA);

        // sin flag: asignar y cerrar no encolan nada
        const otSinFlag = await crearOt('pendiente', null, equipoSinFlag.id);
        assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${otSinFlag}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId })).status, 200);
        assert.deepEqual(await filasPush(otSinFlag, 'mecanico_asignado'), []);

        const ot = await crearOt('pendiente', null, equipoA.id);
        await conPush(async () => {
            const asignada = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId });
            assert.equal(asignada.status, 200, JSON.stringify(asignada.body));
            await pool.query("UPDATE ordenes_trabajo SET estado = 'en_reparacion' WHERE id = $1", [ot]);
            const cerrada = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/finalizar`, 'mecanico', { observacion_final: 'observacion reservada del cierre' });
            assert.equal(cerrada.status, 200, JSON.stringify(cerrada.body));
        });
        const todos = [...e.deA, ...e.noReciben];
        assert.deepEqual(await destinosPropios(ot, 'mecanico_asignado', todos), ordenados(...e.deA));
        assert.deepEqual(await destinosPropios(ot, 'ot_finalizada', todos), ordenados(...e.deA));
        // el payload encolado es minimo: ni el RUT, vehiculo o nombre del mecanico ni la observacion final
        for (const tipo of ['mecanico_asignado', 'ot_finalizada']) {
            for (const f of await filasPush(ot, tipo)) {
                assert.deepEqual(Object.keys(f.payload).sort(), ['cliente_id', 'maquinaria_codigo', 'orden_trabajo_id', 'tipo', 'usuario_id'], tipo);
                assert.equal(f.payload.cliente_id, e.clienteA);
            }
        }
    });

    test('mecanico_asignado: un cliente sin dispositivo, o un equipo sin cliente, no encola nada', async (t) => {
        if (!requiereBase(t)) return;
        const sinDispositivo = await crearClienteDePrueba('Empresa sin telefono push');
        await crearUsuarioDe('cliente', { clienteId: sinDispositivo });
        await empresasDePrueba();
        const otSin = await crearOt('pendiente', null, (await crearEquipo(sinDispositivo)).id);
        const otInterna = await crearOt('pendiente', null, (await crearEquipo(null)).id);
        await conPush(async () => {
            assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${otSin}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId })).status, 200);
            assert.equal((await pedir('PATCH', `/api/ordenes-trabajo/${otInterna}/asignar`, 'administrativo', { mecanico_id: datos.mecanicoId })).status, 200);
        });
        assert.deepEqual(await filasPush(otSin, 'mecanico_asignado'), []);
        assert.deepEqual(await filasPush(otInterna, 'mecanico_asignado'), [], 'una OT interna no avisa a ninguna empresa');
    });

    test('canal push del worker: revalida app, rol y empresa antes de enviar los avisos de gerencia y de cliente', async (t) => {
        if (!requiereBase(t)) return;
        let enviados = 0;
        usarEnvio(async () => { enviados += 1; });
        const encolar = async (payload, dispositivoId) => (await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('push', $1, $2) RETURNING *`,
            [String(dispositivoId), JSON.stringify(payload)])).rows[0];
        const estadoDe = async (n) => (await pool.query('SELECT estado, ultimo_error FROM notificaciones_pendientes WHERE id = $1', [n.id])).rows[0];
        try {
            const ot = await crearOt('asignada', datos.mecanicoId);
            const clienteId = await crearClienteDePrueba('Empresa worker push');
            const otraEmpresa = await crearClienteDePrueba('Otra empresa worker push');
            const adm = await crearUsuarioDe('administrativo');
            const dAdm = await crearDispositivo(adm.id, 'panel');
            const cli = await crearUsuarioDe('cliente', { clienteId });
            const dCli = await crearDispositivo(cli.id, 'panel');

            // vigentes: oficina en el panel y cliente de su empresa
            const ok1 = await encolar({ tipo: 'ot_por_valorizar', orden_trabajo_id: ot, usuario_id: adm.id }, dAdm);
            const ok2 = await encolar({ tipo: 'ot_finalizada', orden_trabajo_id: ot, usuario_id: cli.id, cliente_id: clienteId }, dCli);
            await procesarUna(ok1);
            await procesarUna(ok2);
            assert.equal((await estadoDe(ok1)).estado, 'enviado');
            assert.equal((await estadoDe(ok2)).estado, 'enviado');
            assert.equal(enviados, 2);

            // el aviso de gerencia en un telefono de la app terreno
            const gerente = await crearUsuarioDe('gerente');
            const dTerreno = await crearDispositivo(gerente.id, 'terreno');
            const enTerreno = await encolar({ tipo: 'factura_anulada', orden_trabajo_id: ot, usuario_id: gerente.id }, dTerreno);
            await procesarUna(enTerreno);
            assert.equal((await estadoDe(enTerreno)).estado, 'cancelado');
            assert.match((await estadoDe(enTerreno)).ultimo_error, /otra app/);

            // el administrativo no recibe lo reservado al gerente
            const soloGerente = await encolar({ tipo: 'ajuste_inventario', usuario_id: adm.id }, dAdm);
            await procesarUna(soloGerente);
            assert.equal((await estadoDe(soloGerente)).estado, 'cancelado');
            assert.match((await estadoDe(soloGerente)).ultimo_error, /rol/);

            // el rol cambio despues de encolar el aviso al cliente
            await pool.query("UPDATE usuarios SET rol = 'administrativo' WHERE id = $1", [cli.id]);
            const cambioRol = await encolar({ tipo: 'ot_finalizada', orden_trabajo_id: ot, usuario_id: cli.id, cliente_id: clienteId }, dCli);
            await procesarUna(cambioRol);
            assert.equal((await estadoDe(cambioRol)).estado, 'cancelado');
            await pool.query("UPDATE usuarios SET rol = 'cliente' WHERE id = $1", [cli.id]);

            // el usuario paso a otra empresa
            await pool.query('UPDATE usuarios SET cliente_id = $2 WHERE id = $1', [cli.id, otraEmpresa]);
            const otraEmp = await encolar({ tipo: 'mecanico_asignado', orden_trabajo_id: ot, usuario_id: cli.id, cliente_id: clienteId }, dCli);
            await procesarUna(otraEmp);
            assert.equal((await estadoDe(otraEmp)).estado, 'cancelado');
            assert.match((await estadoDe(otraEmp)).ultimo_error, /empresa/);

            // cuenta inactiva
            await pool.query("UPDATE usuarios SET estado_cuenta = 'rechazado' WHERE id = $1", [adm.id]);
            const inactiva = await encolar({ tipo: 'ot_por_valorizar', orden_trabajo_id: ot, usuario_id: adm.id }, dAdm);
            await procesarUna(inactiva);
            assert.equal((await estadoDe(inactiva)).estado, 'cancelado');
            assert.equal(enviados, 2, 'solo los dos vigentes salieron');
        } finally {
            usarEnvio(null);
        }
    });

    test('GET /notificaciones: el push muestra nombre y rol del usuario (no el token) y se filtra por canal', async (t) => {
        if (!requiereBase(t)) return;
        const adm = await crearUsuarioDe('administrativo', { nombre: 'Ana Prueba Push' });
        const d = await crearDispositivo(adm.id, 'panel');
        const token = (await pool.query('SELECT token FROM dispositivos_push WHERE id = $1', [d])).rows[0].token;
        const push = (await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('push', $1, $2) RETURNING id`,
            [String(d), JSON.stringify({ tipo: 'ot_por_valorizar', orden_trabajo_id: 1, usuario_id: adm.id })])).rows[0].id;
        const raro = (await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('push', '999999', $1) RETURNING id`,
            [JSON.stringify({ tipo: 'ot_por_valorizar', usuario_id: 'no-es-numero' })])).rows[0].id;
        const correo = (await pool.query(
            `INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'x@gomaq.test', $1) RETURNING id`,
            [JSON.stringify({ tipo: 'factura_emitida' })])).rows[0].id;
        try {
            const r = await pedir('GET', '/api/notificaciones?canal=push', 'gerente');
            assert.equal(r.status, 200);
            assert.ok(r.body.every((n) => n.canal === 'push'), 'solo push');
            const fila = r.body.find((n) => n.id === push);
            assert.equal(fila.usuario_nombre, 'Ana Prueba Push');
            assert.equal(fila.usuario_rol, 'administrativo');
            assert.ok(!JSON.stringify(r.body).includes(token), 'el token del dispositivo no se expone');
            const sinUsuario = r.body.find((n) => n.id === raro);
            assert.equal(sinUsuario.usuario_nombre, null, 'un usuario_id no numerico no rompe la lista');

            const mixta = await pedir('GET', '/api/notificaciones', 'administrativo');
            assert.equal(mixta.status, 200);
            assert.ok(mixta.body.some((n) => n.id === correo && n.usuario_nombre === null), 'el correo no trae usuario');
            const soloCorreo = await pedir('GET', '/api/notificaciones?canal=email', 'administrativo');
            assert.ok(soloCorreo.body.length > 0 && soloCorreo.body.every((n) => n.canal === 'email'));
            assert.ok(!soloCorreo.body.some((n) => n.id === push));
            assert.equal((await pedir('GET', '/api/notificaciones?canal=sms', 'administrativo')).status, 400);
            assert.equal((await pedir('GET', '/api/notificaciones?canal=push', 'mecanico')).status, 403);
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = ANY($1)', [[push, raro, correo]]);
        }
    });

});
