// Documentos del equipo por rol y cliente, y guias idempotentes.
// Corren contra una base local; ver utils/entornoEscritura.js (GOMAQ_TEST_ESCRITURA=1 npm test).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { requiereBase, tokenClienteDe } = require('./utils/http');
const {
    pool,
    datos,
    tokens,
    entorno,
    HABILITADO,
    pedir,
    pedirConToken,
    purgarOrdenes,
    crearEquipo,
    algunCliente,
} = require('./utils/entornoEscritura');

describe('documentos del equipo por rol y cliente', () => {
    const esc = {};
    const clave = (d) => `${d.tipo}:${d.id}`;
    const tokenCliente = tokenClienteDe(987654);


    const guia = async (tipo, fecha, clienteId, extra = {}) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id, created_at)
         VALUES ($1, $2::tipo_guia, $3, $4, $5, COALESCE($6, now())) RETURNING id`,
        [esc.equipo.id, tipo, extra.sinDocumento ? null : `guias/${crypto.randomUUID()}.pdf`, fecha, clienteId, extra.creada || null])).rows[0].id;

    before(async () => {
        if (!HABILITADO) return;
        const nuevoCliente = async (nombre) => (await pool.query(
            "INSERT INTO clientes (nombre, email) VALUES ($1, 'doc@gomaq.test') RETURNING id", [`${nombre} ${crypto.randomUUID().slice(0, 6)}`])).rows[0].id;
        esc.acsa = await nuevoCliente('ACSA');
        esc.prize = await nuevoCliente('Prize');
        esc.servinut = await nuevoCliente('Servinut');
        esc.otro = await nuevoCliente('Sin documentos');
        esc.equipo = await crearEquipo(null);

        // arriendo 1: ACSA (despacho, OT, recepcion, factura del periodo)
        esc.g1 = await guia('despacho', '2026-01-02T09:00:00-03:00', esc.acsa);
        esc.ot1 = (await pool.query(
            "INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo, valorizacion) VALUES ($1, $2, 'finalizada', 'Revision ACSA', 777000) RETURNING id",
            [esc.equipo.id, esc.acsa])).rows[0].id;
        datos.ordenes.push(esc.ot1);
        esc.r1 = await guia('recepcion', '2026-01-20T10:00:00-03:00', esc.acsa);
        esc.f1 = (await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, cliente_id, folio, archivo_url, monto)
             VALUES ($1, $2, '2026-01-02', '2026-01-20', $3, 'D-1', 'facturas/acsa1.pdf', 100000) RETURNING id`,
            [esc.equipo.id, esc.g1, esc.acsa])).rows[0].id;
        // arriendo 2: Prize; la factura se inserta como el servidor anterior, solo con la recepcion (trigger de la 023)
        esc.g2 = await guia('despacho', '2026-02-02T09:00:00-03:00', esc.prize);
        esc.r2 = await guia('recepcion', '2026-02-10T10:00:00-03:00', esc.prize);
        esc.f2 = (await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url, monto) VALUES ($1, $2, 'D-2', 'facturas/prize.pdf', 90000) RETURNING id`,
            [esc.equipo.id, esc.r2])).rows[0].id;
        // una OT de taller entre Prize y Servinut, sin cliente
        esc.ot0 = (await pool.query(
            "INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo) VALUES ($1, NULL, 'finalizada', 'Taller sin cliente') RETURNING id",
            [esc.equipo.id])).rows[0].id;
        datos.ordenes.push(esc.ot0);
        // arriendo 3: Servinut, con una guia sin documento
        esc.g3 = await guia('despacho', '2026-03-02T09:00:00-03:00', esc.servinut, { sinDocumento: true });
        esc.r3 = await guia('recepcion', '2026-03-12T10:00:00-03:00', esc.servinut);
        // arriendo 4: ACSA otra vez, vigente hoy
        esc.g4 = await guia('despacho', '2026-04-02T09:00:00-03:00', esc.acsa);
        // documentos antiguos sin cliente (guia y factura) y una guia de ACSA anterior a la migracion 010
        esc.gNull = await guia('despacho', '2025-12-01T09:00:00-03:00', null);
        esc.fNull = (await pool.query(
            `INSERT INTO facturas (maquinaria_id, folio, archivo_url) VALUES ($1, 'D-NULL', 'facturas/sin-cliente.pdf') RETURNING id`,
            [esc.equipo.id])).rows[0].id;
        esc.gVieja = await guia('despacho', '2025-06-01T09:00:00-03:00', esc.acsa, { creada: '2000-01-01T00:00:00Z' });
    });

    after(async () => {
        if (!HABILITADO || !esc.equipo) return;
        // los clientes de prueba se borran aca: antes hay que soltar lo que los referencia
        await pool.query('DELETE FROM facturas WHERE maquinaria_id = $1', [esc.equipo.id]);
        await pool.query('DELETE FROM guias WHERE maquinaria_id = $1', [esc.equipo.id]);
        await purgarOrdenes([esc.ot0, esc.ot1]);
        await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [[esc.acsa, esc.prize, esc.servinut, esc.otro]]);
    });

    const conjunto = (r) => new Set(r.body.documentos.map(clave));
    const esperado = (...pares) => new Set(pares);

    test('cada cliente ve exactamente los documentos de sus arriendos, no los del equipo completo', async (t) => {
        if (!requiereBase(t)) return;
        const acsa = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.acsa));
        assert.equal(acsa.status, 200);
        assert.deepEqual(conjunto(acsa), esperado(
            `guia_despacho:${esc.g1}`, `guia_recepcion:${esc.r1}`, `orden_trabajo:${esc.ot1}`, `factura:${esc.f1}`, `guia_despacho:${esc.g4}`));
        const prize = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.prize));
        assert.deepEqual(conjunto(prize), esperado(`guia_despacho:${esc.g2}`, `guia_recepcion:${esc.r2}`, `factura:${esc.f2}`));
        const servinut = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.servinut));
        assert.deepEqual(conjunto(servinut), esperado(`guia_despacho:${esc.g3}`, `guia_recepcion:${esc.r3}`));
    });

    test('el trigger de la 023 dejo el cliente en la factura insertada solo con la recepcion', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pool.query('SELECT cliente_id FROM facturas WHERE id = $1', [esc.f2]);
        assert.equal(r.rows[0].cliente_id, esc.prize);
    });

    test('administrativo y gerente ven todo, tambien lo que no tiene cliente, y pueden filtrar por cliente', async (t) => {
        if (!requiereBase(t)) return;
        for (const rol of ['administrativo', 'gerente']) {
            const r = await pedir('GET', `/api/maquinarias/${esc.equipo.id}/documentos`, rol);
            assert.equal(r.status, 200);
            const claves = conjunto(r);
            for (const k of [`guia_despacho:${esc.gNull}`, `factura:${esc.fNull}`, `orden_trabajo:${esc.ot0}`, `guia_despacho:${esc.gVieja}`,
                `factura:${esc.f1}`, `factura:${esc.f2}`, `guia_recepcion:${esc.r3}`, `guia_despacho:${esc.g4}`]) {
                assert.ok(claves.has(k), `${rol} debe ver ${k}`);
            }
            const sinCliente = r.body.documentos.find((d) => clave(d) === `factura:${esc.fNull}`);
            assert.equal(sinCliente.cliente_id, null);
            assert.equal(sinCliente.cliente_nombre, null);
        }
        const filtrado = await pedir('GET', `/api/maquinarias/${esc.equipo.id}/documentos?cliente_id=${esc.prize}`, 'administrativo');
        assert.deepEqual(conjunto(filtrado), esperado(`guia_despacho:${esc.g2}`, `guia_recepcion:${esc.r2}`, `factura:${esc.f2}`));
    });

    test('un cliente no puede ampliar lo que ve con ?cliente_id', async (t) => {
        if (!requiereBase(t)) return;
        const base1 = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.prize));
        const otro = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos?cliente_id=${esc.acsa}`, tokenCliente(esc.prize));
        assert.deepEqual(conjunto(otro), conjunto(base1));
        const nulo = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos?cliente_id=`, tokenCliente(esc.prize));
        assert.deepEqual(conjunto(nulo), conjunto(base1));
    });

    test('la guia anterior a la migracion 010 no se muestra al cliente aunque lleve su cliente_id', async (t) => {
        if (!requiereBase(t)) return;
        const acsa = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.acsa));
        assert.ok(!conjunto(acsa).has(`guia_despacho:${esc.gVieja}`));
        const admin = await pedir('GET', `/api/maquinarias/${esc.equipo.id}/documentos`, 'administrativo');
        assert.ok(conjunto(admin).has(`guia_despacho:${esc.gVieja}`));
    });

    test('permisos y errores: mecanico 403, cliente sin empresa 400, cliente sin documentos 404, equipo inexistente 404, id invalido 400', async (t) => {
        if (!requiereBase(t)) return;
        const ruta = `/api/maquinarias/${esc.equipo.id}/documentos`;
        assert.equal((await pedir('GET', ruta, 'mecanico')).status, 403);
        assert.equal((await pedirConToken(ruta, tokens.cliente)).status, 400, 'cliente sin cliente_id');
        assert.equal((await pedirConToken(ruta, tokenCliente(esc.otro))).status, 404, 'cliente sin documentos de este equipo');
        assert.equal((await pedir('GET', '/api/maquinarias/99999999/documentos', 'administrativo')).status, 404);
        assert.equal((await pedir('GET', '/api/maquinarias/abc/documentos', 'administrativo')).status, 400);
        const sinSesion = await fetch(`${entorno.base}${ruta}`);
        assert.equal(sinSesion.status, 401);
    });

    test('la respuesta nunca trae archivo_url ni rutas privadas; usa URLs firmadas y la guia sin documento lleva url nula', async (t) => {
        if (!requiereBase(t)) return;
        for (const [rol, token] of [['cliente', tokenCliente(esc.servinut)], ['admin', tokens.administrativo]]) {
            const r = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, token);
            assert.equal(r.status, 200, rol);
            for (const d of r.body.documentos) {
                assert.equal('archivo_url' in d, false, `${rol}: sin archivo_url`);
                if (d.url) assert.match(d.url, /^https:\/\/firmada\.test\//);
            }
        }
        const sinDoc = (await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.servinut)))
            .body.documentos.find((d) => clave(d) === `guia_despacho:${esc.g3}`);
        assert.equal(sinDoc.sin_documento, true);
        assert.equal(sinDoc.url, null);
    });

    test('el cliente no ve la valorizacion de su orden; el administrativo si', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await pedirConToken(`/api/maquinarias/${esc.equipo.id}/documentos`, tokenCliente(esc.acsa));
        const ot = cliente.body.documentos.find((d) => d.tipo === 'orden_trabajo');
        assert.equal(ot.id, esc.ot1);
        assert.equal('valorizacion' in ot, false);
        assert.equal(ot.estado, 'finalizada');
        const admin = await pedir('GET', `/api/maquinarias/${esc.equipo.id}/documentos`, 'administrativo');
        assert.equal(admin.body.documentos.find((d) => d.tipo === 'orden_trabajo' && d.id === esc.ot1).valorizacion, 777000);
    });

    test('ordenados de lo mas nuevo a lo mas antiguo y con el nombre del cliente', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', `/api/maquinarias/${esc.equipo.id}/documentos`, 'administrativo');
        const fechas = r.body.documentos.map((d) => new Date(d.fecha).getTime());
        assert.deepEqual(fechas, [...fechas].sort((a, b) => b - a));
        const acsa = r.body.documentos.find((d) => clave(d) === `guia_despacho:${esc.g4}`);
        assert.match(acsa.cliente_nombre, /^ACSA /);
    });
});

describe('documentos del equipo: casos de borde', () => {
    const esc = {};
    const clave = (d) => `${d.tipo}:${d.id}`;
    const tokenCliente = tokenClienteDe(987655);
    const guia = async (equipoId, tipo, fecha, clienteId, extra = {}) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id, created_at)
         VALUES ($1, $2::tipo_guia, $3, $4, $5, COALESCE($6, now())) RETURNING id`,
        [equipoId, tipo, extra.archivo || `guias/${crypto.randomUUID()}.pdf`, fecha, clienteId, extra.creada || null])).rows[0].id;

    before(async () => {
        if (!HABILITADO) return;
        const nuevoCliente = async (nombre) => (await pool.query(
            "INSERT INTO clientes (nombre) VALUES ($1) RETURNING id", [`${nombre} ${crypto.randomUUID().slice(0, 6)}`])).rows[0].id;
        esc.a = await nuevoCliente('Cliente A');
        esc.b = await nuevoCliente('Cliente B');
        esc.equipo = await crearEquipo(null);
        esc.soloB = await crearEquipo(null);
        // equipo con documentos de A y B
        esc.gA = await guia(esc.equipo.id, 'despacho', '2026-02-01T09:00:00-03:00', esc.a);
        esc.gFalla = await guia(esc.equipo.id, 'recepcion', '2026-02-10T10:00:00-03:00', esc.a, { archivo: 'guias/firma-falla.pdf' });
        // despacho y recepcion anteriores a la migracion 010 (cliente copiado por el relleno)
        esc.dVieja = await guia(esc.equipo.id, 'despacho', '2025-05-01T09:00:00-03:00', esc.a, { creada: '2000-01-01T00:00:00Z' });
        esc.rVieja = await guia(esc.equipo.id, 'recepcion', '2025-05-20T10:00:00-03:00', esc.a, { creada: '2000-01-01T00:00:00Z' });
        // OT de B y factura de A que (por error de datos) apunta a esa OT: A no debe recibir el id de la OT de B
        esc.otB = (await pool.query(
            "INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo) VALUES ($1, $2, 'finalizada', 'OT de B') RETURNING id", [esc.equipo.id, esc.b])).rows[0].id;
        datos.ordenes.push(esc.otB);
        esc.otA = (await pool.query(
            "INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo) VALUES ($1, $2, 'finalizada', 'OT de A') RETURNING id", [esc.equipo.id, esc.a])).rows[0].id;
        datos.ordenes.push(esc.otA);
        // factura de reparacion SIN maquinaria_id: solo llega al equipo por su OT
        esc.fRep = (await pool.query(
            "INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, monto, cliente_id) VALUES ($1, 'R-1', 'facturas/rep.pdf', 55555, $2) RETURNING id",
            [esc.otA, esc.a])).rows[0].id;
        // facturas de arriendo colgadas de guias anteriores a la 010
        // (el despacho primero: el trigger de la 023 no debe dar el mismo despacho a la factura de la recepcion)
        esc.fDesVieja = (await pool.query(
            "INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, folio, archivo_url, cliente_id, monto) VALUES ($1, $2, '2025-05-01', '2025-05-20', 'V-DES', 'facturas/v2.pdf', $3, 1000) RETURNING id",
            [esc.equipo.id, esc.dVieja, esc.a])).rows[0].id;
        esc.fRecVieja = (await pool.query(
            "INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url, cliente_id, monto) VALUES ($1, $2, 'V-REC', 'facturas/v1.pdf', $3, 1000) RETURNING id",
            [esc.equipo.id, esc.rVieja, esc.a])).rows[0].id;
        // factura de A que apunta a la OT de B
        esc.fCruzada = (await pool.query(
            "INSERT INTO facturas (maquinaria_id, orden_trabajo_id, folio, archivo_url, cliente_id, monto) VALUES ($1, $2, 'X-1', 'facturas/x.pdf', $3, 2000) RETURNING id",
            [esc.equipo.id, esc.otB, esc.a])).rows[0].id;
        // equipo donde solo B tiene documentos
        esc.gSoloB = await guia(esc.soloB.id, 'despacho', '2026-03-01T09:00:00-03:00', esc.b);
    });

    after(async () => {
        if (!HABILITADO || !esc.equipo) return;
        await pool.query('DELETE FROM facturas WHERE maquinaria_id = ANY($1) OR orden_trabajo_id = ANY($2)', [[esc.equipo.id, esc.soloB.id], [esc.otA, esc.otB]]);
        await pool.query('DELETE FROM guias WHERE maquinaria_id = ANY($1)', [[esc.equipo.id, esc.soloB.id]]);
        await purgarOrdenes([esc.otA, esc.otB]);
        await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [[esc.a, esc.b]]);
    });

    const ruta = (id = esc.equipo.id, q = '') => `/api/maquinarias/${id}/documentos${q}`;
    const conjunto = (r) => new Set(r.body.documentos.map(clave));

    test('la factura de reparacion sin maquinaria_id llega al equipo por su OT y la ve su cliente', async (t) => {
        if (!requiereBase(t)) return;
        const a = await pedirConToken(ruta(), tokenCliente(esc.a));
        assert.ok(conjunto(a).has(`factura:${esc.fRep}`));
        const b = await pedirConToken(ruta(), tokenCliente(esc.b));
        assert.ok(!conjunto(b).has(`factura:${esc.fRep}`));
    });

    test('las facturas colgadas de una recepcion o de un despacho anteriores a la 010 no se muestran al cliente', async (t) => {
        if (!requiereBase(t)) return;
        const a = await pedirConToken(ruta(), tokenCliente(esc.a));
        for (const k of [`factura:${esc.fRecVieja}`, `factura:${esc.fDesVieja}`, `guia_despacho:${esc.dVieja}`, `guia_recepcion:${esc.rVieja}`]) {
            assert.ok(!conjunto(a).has(k), `el cliente no debe ver ${k}`);
        }
        const admin = await pedir('GET', ruta(), 'administrativo');
        for (const k of [`factura:${esc.fRecVieja}`, `factura:${esc.fDesVieja}`, `guia_despacho:${esc.dVieja}`]) {
            assert.ok(conjunto(admin).has(k), `administrativo ve ${k}`);
        }
    });

    test('sin registro de la migracion 010 el cliente no ve ninguna guia ni factura de guia (falla cerrado)', async (t) => {
        if (!requiereBase(t)) return;
        const original = (await pool.query("SELECT nombre FROM schema_migraciones WHERE nombre LIKE '010%'")).rows[0].nombre;
        try {
            await pool.query("UPDATE schema_migraciones SET nombre = 'x-' || nombre WHERE nombre = $1", [original]);
            const a = await pedirConToken(ruta(), tokenCliente(esc.a));
            assert.equal(a.status, 200);
            assert.ok([...conjunto(a)].every((k) => !k.startsWith('guia_')), 'ninguna guia');
            assert.ok(conjunto(a).has(`orden_trabajo:${esc.otA}`), 'las ordenes siguen visibles');
        } finally {
            await pool.query("UPDATE schema_migraciones SET nombre = $1 WHERE nombre = 'x-' || $1", [original]);
        }
        assert.ok((await pool.query('SELECT 1 FROM schema_migraciones WHERE nombre = $1', [original])).rows.length === 1, 'registro restaurado');
    });

    test('ids fuera de rango o mal formados dan 400 y no 500', async (t) => {
        if (!requiereBase(t)) return;
        for (const id of ['2147483648', '0', '-1', '1e3', '1.5', '99999999999999999999', 'abc']) {
            assert.equal((await pedir('GET', ruta(id), 'administrativo')).status, 400, `id ${id}`);
            assert.equal((await pedirConToken(ruta(id), tokenCliente(esc.a))).status, 400, `id ${id} (cliente)`);
        }
        // un cliente con cliente_id absurdo en el token tambien es 400
        assert.equal((await pedirConToken(ruta(), tokenCliente(2147483648))).status, 400);
    });

    test('?cliente_id invalido o repetido da 400 al administrativo; el cliente lo ignora', async (t) => {
        if (!requiereBase(t)) return;
        for (const q of ['?cliente_id=abc', '?cliente_id=0', '?cliente_id=2147483648', '?cliente_id=1&cliente_id=2', '?cliente_id[]=1']) {
            assert.equal((await pedir('GET', ruta(esc.equipo.id, q), 'administrativo')).status, 400, q);
        }
        assert.equal((await pedir('GET', ruta(esc.equipo.id, '?cliente_id='), 'administrativo')).status, 200, 'vacio = sin filtro');
        const limpio = await pedirConToken(ruta(), tokenCliente(esc.a));
        const raro = await pedirConToken(ruta(esc.equipo.id, '?cliente_id=abc&cliente_id=2'), tokenCliente(esc.a));
        assert.equal(raro.status, 200);
        assert.deepEqual(conjunto(raro), conjunto(limpio));
    });

    test('la respuesta no trae montos ni rutas de archivo', async (t) => {
        if (!requiereBase(t)) return;
        for (const token of [tokenCliente(esc.a), tokens.administrativo]) {
            const r = await pedirConToken(ruta(), token);
            // la ruta privada solo puede aparecer dentro de la URL firmada, nunca como dato propio
            const texto = JSON.stringify(r.body.documentos.map(({ url: _url, ...resto }) => resto));
            assert.ok(!/"monto"/.test(texto), 'sin monto');
            assert.ok(!/archivo_url|facturas\/|guias\//.test(texto), 'sin rutas privadas');
        }
    });

    test('un cliente que pide un equipo donde solo otro tiene documentos recibe el mismo 404 que con un id inexistente', async (t) => {
        if (!requiereBase(t)) return;
        const ajeno = await pedirConToken(ruta(esc.soloB.id), tokenCliente(esc.a));
        const inexistente = await pedirConToken(ruta(99999999), tokenCliente(esc.a));
        assert.equal(ajeno.status, 404);
        assert.equal(inexistente.status, 404);
        assert.deepEqual(ajeno.body, inexistente.body);
        // y B si ve lo suyo del mismo equipo
        const b = await pedirConToken(ruta(esc.soloB.id), tokenCliente(esc.b));
        assert.equal(b.status, 200);
    });

    test('al cliente no se le da el id de una OT que no es de su empresa', async (t) => {
        if (!requiereBase(t)) return;
        const a = await pedirConToken(ruta(), tokenCliente(esc.a));
        const cruzada = a.body.documentos.find((d) => clave(d) === `factura:${esc.fCruzada}`);
        assert.ok(cruzada, 'la factura es de A');
        assert.equal(cruzada.orden_trabajo_id, null);
        const propia = a.body.documentos.find((d) => clave(d) === `factura:${esc.fRep}`);
        assert.equal(propia.orden_trabajo_id, esc.otA);
        const admin = await pedir('GET', ruta(), 'administrativo');
        assert.equal(admin.body.documentos.find((d) => clave(d) === `factura:${esc.fCruzada}`).orden_trabajo_id, esc.otB);
    });

    test('un archivo que no se puede firmar deja ese documento sin enlace y el resto de la lista sigue', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', ruta(), 'administrativo');
        assert.equal(r.status, 200);
        const roto = r.body.documentos.find((d) => clave(d) === `guia_recepcion:${esc.gFalla}`);
        assert.equal(roto.url, null);
        const sano = r.body.documentos.find((d) => clave(d) === `guia_despacho:${esc.gA}`);
        assert.match(sano.url, /^https:\/\/firmada\.test\//);
    });
});

describe('guias idempotentes con uuid_cliente', () => {
    /** Envia una guia por la ruta real. Con `pdf` sube un archivo; si no, va sin documento. */
    async function enviarGuia(equipoId, campos, pdf = false) {
        const formulario = new FormData();
        for (const [clave, valor] of Object.entries(campos)) {
            if (valor !== undefined && valor !== null) formulario.append(clave, String(valor));
        }
        if (pdf) formulario.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'g.pdf');
        else formulario.append('sin_documento', 'true');
        const r = await fetch(`${entorno.base}/api/maquinarias/${equipoId}/guias`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario,
        });
        let cuerpo = null;
        try { cuerpo = await r.json(); } catch (_) { /* sin cuerpo */ }
        return { status: r.status, body: cuerpo };
    }

    const cuantasGuias = async (uuid) =>
        (await pool.query('SELECT count(*)::int AS n FROM guias WHERE uuid_cliente = $1', [uuid])).rows[0].n;

    test('el mismo uuid dos veces: una sola guia y el equipo no se vuelve a tocar', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const uuid = crypto.randomUUID();
        const primera = await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid });
        assert.equal(primera.status, 201);
        assert.equal(primera.body.uuid_cliente, uuid);
        // alguien mas libera el equipo; el reintento no debe volver a asignarlo
        await pool.query('UPDATE maquinarias SET cliente_id = NULL WHERE id = $1', [equipo.id]);
        const segunda = await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid });
        assert.equal(segunda.status, 200);
        assert.equal(segunda.body.ya_registrada, true);
        assert.equal(segunda.body.id, primera.body.id);
        assert.equal(await cuantasGuias(uuid), 1);
        const maq = await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [equipo.id]);
        assert.equal(maq.rows[0].cliente_id, null, 'el reintento no reaplico el cambio de cliente');
    });

    test('el reintento con PDF no vuelve a subir el archivo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const uuid = crypto.randomUUID();
        const antes = datos.storage.subidos.length;
        assert.equal((await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid }, true)).status, 201);
        assert.equal(datos.storage.subidos.length, antes + 1);
        const reintento = await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid }, true);
        assert.equal(reintento.status, 200);
        assert.equal(reintento.body.falta_documento, false);
        assert.equal(datos.storage.subidos.length, antes + 1, 'el reintento no sube otro PDF');
    });

    test('el mismo uuid con otro equipo o con otro tipo da 409', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const otro = await crearEquipo(null);
        const uuid = crypto.randomUUID();
        assert.equal((await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid })).status, 201);
        assert.equal((await enviarGuia(otro.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid })).status, 409);
        assert.equal((await enviarGuia(equipo.id, { tipo: 'recepcion', uuid_cliente: uuid })).status, 409);
        assert.equal(await cuantasGuias(uuid), 1);
        const maq = await pool.query('SELECT cliente_id FROM maquinarias WHERE id = $1', [otro.id]);
        assert.equal(maq.rows[0].cliente_id, null, 'el 409 no toco el otro equipo');
    });

    test('dos envios simultaneos con el mismo uuid dejan una sola guia', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        for (let vuelta = 0; vuelta < 5; vuelta++) {
            const equipo = await crearEquipo(null);
            const uuid = crypto.randomUUID();
            const envio = () => enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid });
            const [a, b] = await Promise.all([envio(), envio()]);
            assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.body, b.body]));
            assert.equal(a.body.id, b.body.id);
            assert.equal(await cuantasGuias(uuid), 1);
        }
    });

    test('sin uuid el comportamiento es el de siempre: cada envio crea su guia', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const a = await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente });
        const b = await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente });
        assert.equal(a.status, 201);
        assert.equal(b.status, 201);
        assert.notEqual(a.body.id, b.body.id);
        assert.equal(a.body.uuid_cliente, null);
    });

    test('un uuid mal formado da 400 y no crea nada', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        for (const malo of ['no-es-uuid', '123', '0x10', "' OR 1=1 --"]) {
            const r = await enviarGuia(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: malo });
            assert.equal(r.status, 400, malo);
        }
        const n = await pool.query('SELECT count(*)::int AS n FROM guias WHERE maquinaria_id = $1', [equipo.id]);
        assert.equal(n.rows[0].n, 0);
    });
});

describe('guias idempotentes: casos de borde', () => {
    async function enviar(equipoId, campos, pdf = false) {
        const formulario = new FormData();
        for (const [clave, valor] of Object.entries(campos)) {
            if (valor !== undefined && valor !== null) formulario.append(clave, String(valor));
        }
        if (pdf) formulario.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'g.pdf');
        else formulario.append('sin_documento', 'true');
        const r = await fetch(`${entorno.base}/api/maquinarias/${equipoId}/guias`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario,
        });
        let cuerpo = null;
        try { cuerpo = await r.json(); } catch (_) { /* sin cuerpo */ }
        return { status: r.status, body: cuerpo };
    }

    test('un uuid en mayusculas reenviado en minusculas es el mismo envio', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const uuid = crypto.randomUUID();
        const a = await enviar(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid.toUpperCase() });
        assert.equal(a.status, 201);
        const b = await enviar(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid.toLowerCase() });
        assert.equal(b.status, 200);
        assert.equal(b.body.id, a.body.id);
    });

    test('el reintento identico con fecha explicita es 200; si cambia cliente, fallida o fecha es 409', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = (await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 2')).rows.map((c) => c.id);
        const equipo = await crearEquipo(null);
        const uuid = crypto.randomUUID();
        const base1 = { tipo: 'despacho', cliente_id: clientes[0], uuid_cliente: uuid, fecha_hora: '2026-03-10T09:00:00-03:00' };
        const primera = await enviar(equipo.id, base1);
        assert.equal(primera.status, 201);
        assert.equal((await enviar(equipo.id, base1)).status, 200, 'identico');
        // la misma hora escrita con otro formato sigue siendo la misma fecha
        assert.equal((await enviar(equipo.id, { ...base1, fecha_hora: '2026-03-10T12:00:00Z' })).status, 200);
        assert.equal((await enviar(equipo.id, { ...base1, fecha_hora: '2026-03-11T09:00:00-03:00' })).status, 409, 'otra fecha');
        assert.equal((await enviar(equipo.id, { ...base1, fallido: 'true' })).status, 409, 'otra condicion de fallida');
        if (clientes.length > 1) {
            assert.equal((await enviar(equipo.id, { ...base1, cliente_id: clientes[1] })).status, 409, 'otro cliente');
        }
        const n = await pool.query('SELECT count(*)::int AS n FROM guias WHERE uuid_cliente = $1', [uuid]);
        assert.equal(n.rows[0].n, 1);
    });

    test('sin fecha_hora el reintento no compara la fecha (el INSERT usa now())', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const uuid = crypto.randomUUID();
        const campos = { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid };
        assert.equal((await enviar(equipo.id, campos)).status, 201);
        assert.equal((await enviar(equipo.id, campos)).status, 200);
    });

    test('la carrera con PDF no deja archivos huerfanos: todo PDF de mas se borra', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        for (let vuelta = 0; vuelta < 4; vuelta++) {
            const equipo = await crearEquipo(null);
            const uuid = crypto.randomUUID();
            const subidosAntes = datos.storage.subidos.length;
            const borradosAntes = datos.storage.borrados.length;
            const envio = () => enviar(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: uuid }, true);
            const [a, b] = await Promise.all([envio(), envio()]);
            assert.deepEqual([a.status, b.status].sort(), [200, 201]);
            const subidos = datos.storage.subidos.length - subidosAntes;
            const borrados = datos.storage.borrados.length - borradosAntes;
            assert.equal(subidos - borrados, 1, `queda un solo PDF (subidos ${subidos}, borrados ${borrados})`);
            const guia = await pool.query('SELECT archivo_url FROM guias WHERE uuid_cliente = $1', [uuid]);
            assert.ok(!datos.storage.borrados.includes(guia.rows[0].archivo_url), 'el PDF de la guia guardada no se borro');
        }
    });

    test('si falla el SELECT del uuid responde 500 y el servidor sigue vivo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const original = pool.query;
        let fallos = 0;
        pool.query = function (texto, ...resto) {
            if (typeof texto === 'string' && texto.includes('FROM guias WHERE uuid_cliente') && fallos === 0) {
                fallos += 1;
                return Promise.reject(new Error('fallo simulado de la base'));
            }
            return original.call(this, texto, ...resto);
        };
        try {
            const r = await enviar(equipo.id, { tipo: 'despacho', cliente_id: cliente, uuid_cliente: crypto.randomUUID() });
            assert.equal(r.status, 500);
        } finally {
            pool.query = original;
        }
        assert.equal(fallos, 1);
        assert.equal((await enviar(equipo.id, { tipo: 'despacho', cliente_id: cliente })).status, 201, 'el servidor sigue atendiendo');
    });
});
