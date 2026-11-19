// Cobro segun la hora de corte, fin de arriendo guardado y equipos anteriores del portal del cliente.
// Corren contra una base local; ver utils/entornoEscritura.js (GOMAQ_TEST_ESCRITURA=1 npm test).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { diasEntre } = require('../src/utils/diasArriendo');
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

describe('cambio de cliente y recepcion: el dia se cobra segun la hora de corte', () => {
    const guiaSql = async (equipoId, tipo, fecha, clienteId) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, $2::tipo_guia, 'x', $3, $4) RETURNING id`,
        [equipoId, tipo, fecha, clienteId])).rows[0].id;

    const dosClientes = async () => {
        const r = await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 2');
        if (r.rows.length < 2) return null;
        return [r.rows[0].id, r.rows[1].id];
    };

    const propuesta = (d) => pedir('GET', `/api/facturacion/arriendos/${d}/propuesta`, 'administrativo');
    const enCurso = async (equipoId) => (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'administrativo')).body
        .arriendos.find((a) => a.maquinaria_id === equipoId);
    const pendiente = async (equipoId) => (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body
        .arriendos.find((a) => a.maquinaria_id === equipoId);

    test('ACSA a Prize a las 10:00: el dia 10 se cobra a Prize y ACSA termina el 9', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = await dosClientes();
        if (!clientes) return t.skip('la semilla tiene menos de dos clientes');
        const [acsa, prize] = clientes;
        const equipo = await crearEquipo(null);
        const dA = await guiaSql(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', acsa);
        const dP = await guiaSql(equipo.id, 'despacho', '2026-03-10T10:00:00-03:00', prize);
        const pA = await propuesta(dA);
        assert.equal(pA.status, 200);
        assert.equal(pA.body.falta_recepcion, true);
        assert.equal(pA.body.desde, '2026-03-01');
        assert.equal(pA.body.fin, '2026-03-09');
        // `dias` llega hasta el primer fin de periodo (dia 5 de facturacion), no hasta el fin del arriendo
        assert.equal(pA.body.opciones_hasta.at(-1), '2026-03-09');
        assert.equal(diasEntre(pA.body.desde, pA.body.fin), 9);
        const pendA = await pendiente(equipo.id);
        assert.equal(pendA.cliente_id, acsa);
        assert.equal(pendA.dias, 9);
        assert.equal(pendA.falta_recepcion, true);
        // Prize esta en curso y parte el mismo dia 10
        const curso = await enCurso(equipo.id);
        assert.equal(curso.guia_despacho_id, dP);
        assert.equal(curso.cliente_id, prize);
        assert.equal(curso.inicio_cobro, '2026-03-10');
        assert.equal(curso.desde, '2026-03-10');
    });

    test('ACSA a Prize a las 15:00: el dia 10 se cobra a ACSA y Prize parte el 11', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = await dosClientes();
        if (!clientes) return t.skip('la semilla tiene menos de dos clientes');
        const [acsa, prize] = clientes;
        const equipo = await crearEquipo(null);
        const dA = await guiaSql(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', acsa);
        await guiaSql(equipo.id, 'despacho', '2026-03-10T15:00:00-03:00', prize);
        const pA = await propuesta(dA);
        assert.equal(pA.body.fin, '2026-03-10');
        assert.equal(diasEntre(pA.body.desde, pA.body.fin), 10);
        const curso = await enCurso(equipo.id);
        assert.equal(curso.cliente_id, prize);
        assert.equal(curso.inicio_cobro, '2026-03-11');
        assert.equal(curso.desde, '2026-03-11');
    });

    test('los dias de ACSA y de Prize son contiguos y suman el total, a cualquier hora', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = await dosClientes();
        if (!clientes) return t.skip('la semilla tiene menos de dos clientes');
        const [acsa, prize] = clientes;
        for (const hora of ['00:00', '09:59', '12:59', '13:00', '23:59']) {
            const equipo = await crearEquipo(null);
            const dA = await guiaSql(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', acsa);
            const dP = await guiaSql(equipo.id, 'despacho', `2026-03-10T${hora}:00-03:00`, prize);
            const pA = await propuesta(dA);
            const curso = await enCurso(equipo.id);
            assert.equal(curso.guia_despacho_id, dP);
            const finA = new Date(`${pA.body.fin}T00:00:00Z`).getTime();
            const inicioP = new Date(`${curso.inicio_cobro}T00:00:00Z`).getTime();
            assert.equal(inicioP - finA, 86400000, `fin de ACSA ${pA.body.fin} e inicio de Prize ${curso.inicio_cobro} a las ${hora}`);
        }
    });

    test('el cliente anterior que empezo el mismo dia del cambio queda en 0 dias: nada que facturar', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = await dosClientes();
        if (!clientes) return t.skip('la semilla tiene menos de dos clientes');
        const [acsa, prize] = clientes;
        const equipo = await crearEquipo(null);
        const dA = await guiaSql(equipo.id, 'despacho', '2026-03-10T09:00:00-03:00', acsa);
        await guiaSql(equipo.id, 'despacho', '2026-03-10T10:00:00-03:00', prize);
        const pA = await propuesta(dA);
        assert.equal(pA.body.dias, 0);
        assert.equal(pA.body.nada_que_facturar, true);
        const pend = await pendiente(equipo.id);
        assert.equal(pend, undefined, 'sin dias por facturar no aparece en la lista');
    });

    test('recepcion normal por la ruta real: 10:00 no cobra el dia, 13:00 si', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        for (const [hora, fin] of [['10:00', '2026-03-09'], ['12:59', '2026-03-09'], ['13:00', '2026-03-10']]) {
            const equipo = await crearEquipo(null);
            const dA = await guiaSql(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
            await pool.query('UPDATE maquinarias SET cliente_id = $1 WHERE id = $2', [cliente, equipo.id]);
            const formulario = new FormData();
            formulario.append('tipo', 'recepcion');
            formulario.append('sin_documento', 'true');
            formulario.append('fecha_hora', `2026-03-10T${hora}:00-03:00`);
            const r = await fetch(`${entorno.base}/api/maquinarias/${equipo.id}/guias`, {
                method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario });
            assert.equal(r.status, 201, hora);
            const p = await propuesta(dA);
            assert.equal(p.body.fin, fin, `recepcion a las ${hora}`);
        }
    });
});

describe('fin de arriendo guardado: la configuracion nueva rige solo hacia adelante', () => {
    const SQL_028 = () => require('fs').readFileSync(
        require('path').join(__dirname, '../../db/migrations/028_fin_arriendo_hora_corte.sql'), 'utf8');
    const guiaSql = async (equipoId, tipo, fecha, clienteId) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, $2::tipo_guia, 'x', $3, $4) RETURNING id`,
        [equipoId, tipo, fecha, clienteId])).rows[0].id;
    const dosClientes = async () => {
        const r = await pool.query('SELECT id FROM clientes ORDER BY id LIMIT 2');
        return r.rows.length < 2 ? null : [r.rows[0].id, r.rows[1].id];
    };
    const propuesta = (d) => pedir('GET', `/api/facturacion/arriendos/${d}/propuesta`, 'administrativo');
    const pendiente = async (equipoId) => (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body
        .arriendos.find((a) => a.maquinaria_id === equipoId);
    const restaurarConfiguracion = async () => {
        for (const [clave, valor] of Object.entries({ dia_facturacion: 5, hora_corte_despacho: 13, corte_cierra_periodo: true })) {
            await pool.query('UPDATE configuracion SET valor = $2::jsonb, actualizado_por = NULL WHERE clave = $1', [clave, JSON.stringify(valor)]);
        }
    };
    const aplicarMigracion = async () => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SQL_028());
            await client.query('COMMIT');
        } finally {
            client.release();
        }
    };

    test('factura final emitida antes de la migracion (recepcion a las 10): no queda facturado de mas ni pendiente', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guiaSql(equipo.id, 'despacho', '2026-10-01T09:00:00-03:00', cliente);
        const r = await guiaSql(equipo.id, 'recepcion', '2026-11-05T10:00:00-03:00', cliente);
        // como estaba antes de la 028: la recepcion sin fin guardado y la factura final hasta el dia de la recepcion
        await pool.query('UPDATE guias SET fin_cobro = NULL WHERE id = $1', [r]);
        await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, guia_recepcion_id, periodo_desde, periodo_hasta, folio, archivo_url, monto)
             VALUES ($1, $2, $3, '2026-10-01', '2026-11-05', 'T-2801', 'x', 1000)`, [equipo.id, d, r]);
        await aplicarMigracion();
        const fin = (await pool.query("SELECT to_char(fin_cobro, 'YYYY-MM-DD') AS d FROM guias WHERE id = $1", [r])).rows[0].d;
        assert.equal(fin, '2026-11-05', 'el relleno usa la regla con la que se facturo');
        const p = await propuesta(d);
        assert.equal(p.body.fin, '2026-11-05');
        assert.equal(p.body.facturado_de_mas, false);
        assert.equal(p.body.nada_que_facturar, true);
        assert.equal(await pendiente(equipo.id), undefined, 'no aparece en /pendientes');
    });

    test('una recepcion nueva a las 10:00 si termina el dia anterior', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guiaSql(equipo.id, 'despacho', '2026-10-01T09:00:00-03:00', cliente);
        await guiaSql(equipo.id, 'recepcion', '2026-11-05T10:00:00-03:00', cliente);
        assert.equal((await propuesta(d)).body.fin, '2026-11-04');
    });

    test('el relleno respeta incluir_dia_recepcion=false con el que se facturo y es idempotente', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const r = await guiaSql(equipo.id, 'recepcion', '2026-03-05T10:00:00-03:00', cliente);
        await pool.query('UPDATE guias SET fin_cobro = NULL WHERE id = $1', [r]);
        try {
            await pool.query("UPDATE configuracion SET valor = 'false' WHERE clave = 'incluir_dia_recepcion'");
            await aplicarMigracion();
            await aplicarMigracion();
        } finally {
            await pool.query("UPDATE configuracion SET valor = 'true', actualizado_por = NULL WHERE clave = 'incluir_dia_recepcion'");
        }
        const fin = (await pool.query("SELECT to_char(fin_cobro, 'YYYY-MM-DD') AS d FROM guias WHERE id = $1", [r])).rows[0].d;
        assert.equal(fin, '2026-03-04');
    });

    test('cambiar la hora de corte despues de registrar el cambio de cliente y la recepcion no altera ningun fin ni inicio', async (t) => {
        if (!requiereBase(t)) return;
        const clientes = await dosClientes();
        if (!clientes) return t.skip('la semilla tiene menos de dos clientes');
        const [acsa, prize] = clientes;
        const equipo = await crearEquipo(null);
        const dA = await guiaSql(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', acsa);
        const dP = await guiaSql(equipo.id, 'despacho', '2026-03-10T12:00:00-03:00', prize);
        const rP = await guiaSql(equipo.id, 'recepcion', '2026-03-20T11:00:00-03:00', prize);
        const foto = async () => {
            const a = (await propuesta(dA)).body;
            const p = (await propuesta(dP)).body;
            return { finA: a.fin, desdeA: a.desde, desdeP: p.desde, finP: p.fin };
        };
        const antes = await foto();
        assert.deepEqual(antes, { finA: '2026-03-09', desdeA: '2026-03-01', desdeP: '2026-03-10', finP: '2026-03-19' });
        try {
            for (const corte of [0, 9, 12, 23]) {
                assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { hora_corte_despacho: corte })).status, 200);
                assert.deepEqual(await foto(), antes, `con corte ${corte} nada cambia`);
            }
        } finally {
            await restaurarConfiguracion();
        }
        assert.ok(rP);
    });

    test('el PUT con solo incluir_dia_recepcion (obsoleta) responde 200 sin guardar ni tocar quien/cuando', async (t) => {
        if (!requiereBase(t)) return;
        const antes = (await pool.query("SELECT valor::text AS v, actualizado_por, actualizado_at FROM configuracion WHERE clave = 'incluir_dia_recepcion'")).rows[0];
        const r = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { incluir_dia_recepcion: !(antes.v === 'true') });
        assert.equal(r.status, 200);
        assert.equal('incluir_dia_recepcion' in r.body, false);
        const despues = (await pool.query("SELECT valor::text AS v, actualizado_por, actualizado_at FROM configuracion WHERE clave = 'incluir_dia_recepcion'")).rows[0];
        assert.deepEqual(despues, antes, 'la fila no cambia');
        // una clave obsoleta junto a una vigente guarda solo la vigente
        const r2 = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { incluir_dia_recepcion: false, dia_facturacion: 6 });
        assert.equal(r2.status, 200);
        assert.equal(r2.body.dia_facturacion, 6);
        await restaurarConfiguracion();
    });

    test('recepcion antes del corte en los flujos de periodos: parcial, facturado de mas y recepcion repetida', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        // periodo parcial: el fin es el dia anterior a la recepcion de las 10
        const e1 = await crearEquipo(null);
        const d1 = await guiaSql(e1.id, 'despacho', '2026-08-01T09:00:00-03:00', cliente);
        await guiaSql(e1.id, 'recepcion', '2026-10-20T10:00:00-03:00', cliente);
        const p1 = await propuesta(d1);
        assert.equal(p1.body.fin, '2026-10-19');
        assert.equal(p1.body.opciones_hasta[p1.body.opciones_hasta.length - 1], '2026-10-19');
        // recepcion repetida (huerfana): no cambia el fin del arriendo
        await guiaSql(e1.id, 'recepcion', '2026-10-22T10:00:00-03:00', cliente);
        assert.equal((await propuesta(d1)).body.fin, '2026-10-19');
        // facturado de mas: se facturo hasta el 20 y la recepcion (a las 10) registrada despues cierra el 19
        const e2 = await crearEquipo(null);
        const d2 = await guiaSql(e2.id, 'despacho', '2026-10-01T09:00:00-03:00', cliente);
        await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, folio, archivo_url)
             VALUES ($1, $2, '2026-10-01', '2026-10-20', 'T-2802', 'x')`, [e2.id, d2]);
        await guiaSql(e2.id, 'recepcion', '2026-10-20T10:00:00-03:00', cliente);
        const p2 = await propuesta(d2);
        assert.equal(p2.body.fin, '2026-10-19');
        assert.equal(p2.body.facturado_de_mas, true);
    });
});

describe('portal del cliente: equipos anteriores (mias/historicos)', () => {
    const esc = {};
    const tokenCliente = tokenClienteDe(987655);


    const guia = async (equipoId, tipo, fecha, clienteId, creada = null) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id, created_at)
         VALUES ($1, $2::tipo_guia, 'x', $3, $4, COALESCE($5, now())) RETURNING id`,
        [equipoId, tipo, fecha, clienteId, creada])).rows[0].id;

    before(async () => {
        if (!HABILITADO) return;
        const nuevoCliente = async (nombre) => (await pool.query(
            "INSERT INTO clientes (nombre, email) VALUES ($1, 'hist@gomaq.test') RETURNING id", [`${nombre} ${crypto.randomUUID().slice(0, 6)}`])).rows[0].id;
        esc.acsa = await nuevoCliente('ACSA');
        esc.prize = await nuevoCliente('Prize');
        esc.servinut = await nuevoCliente('Servinut');
        esc.sin = await nuevoCliente('Sin documentos');
        // equipo 1: ACSA, Prize, Servinut y de nuevo ACSA (vigente hoy)
        esc.e1 = await crearEquipo(null);
        await guia(esc.e1.id, 'despacho', '2026-01-02T09:00:00-03:00', esc.acsa);
        await guia(esc.e1.id, 'recepcion', '2026-01-20T10:00:00-03:00', esc.acsa);
        await guia(esc.e1.id, 'despacho', '2026-02-02T09:00:00-03:00', esc.prize);
        await guia(esc.e1.id, 'recepcion', '2026-02-10T10:00:00-03:00', esc.prize);
        await guia(esc.e1.id, 'despacho', '2026-03-02T09:00:00-03:00', esc.servinut);
        await guia(esc.e1.id, 'recepcion', '2026-03-12T10:00:00-03:00', esc.servinut);
        await guia(esc.e1.id, 'despacho', '2026-04-02T09:00:00-03:00', esc.acsa);
        await pool.query('UPDATE maquinarias SET cliente_id = $1 WHERE id = $2', [esc.acsa, esc.e1.id]);
        // equipo 2: solo de ACSA (Prize no debe verlo)
        esc.e2 = await crearEquipo(null);
        await guia(esc.e2.id, 'despacho', '2026-05-02T09:00:00-03:00', esc.acsa);
        // equipo 3: Prize solo tiene una guia anterior a la migracion 010 (relleno poco confiable): no debe verlo
        esc.e3 = await crearEquipo(null);
        await guia(esc.e3.id, 'despacho', '2025-06-01T09:00:00-03:00', esc.prize, '2000-01-01T00:00:00Z');
        // equipo 4: Servinut tiene solo una factura de reparacion (por su OT), sin guias
        esc.e4 = await crearEquipo(null);
        esc.ot = (await pool.query(
            "INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo) VALUES ($1, $2, 'finalizada', 'Reparacion Servinut') RETURNING id",
            [esc.e4.id, esc.servinut])).rows[0].id;
        datos.ordenes.push(esc.ot);
        await pool.query("INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, monto) VALUES ($1, 'H-1', 'facturas/h1.pdf', 5000)", [esc.ot]);
    });

    after(async () => {
        if (!HABILITADO || !esc.e1) return;
        const equipos = [esc.e1.id, esc.e2.id, esc.e3.id, esc.e4.id];
        await pool.query('DELETE FROM facturas WHERE maquinaria_id = ANY($1) OR orden_trabajo_id = $2', [equipos, esc.ot]);
        await pool.query('DELETE FROM guias WHERE maquinaria_id = ANY($1)', [equipos]);
        await purgarOrdenes([esc.ot]);
        await pool.query('UPDATE maquinarias SET cliente_id = NULL WHERE id = ANY($1)', [equipos]);
        await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [[esc.acsa, esc.prize, esc.servinut, esc.sin]]);
    });

    const ids = (r) => r.body.map((e) => e.id).sort((a, b) => a - b);

    test('Prize ve el equipo que tuvo aunque hoy este con ACSA, y no ve nada de ACSA', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedirConToken('/api/maquinarias/mias/historicos', tokenCliente(esc.prize));
        assert.equal(r.status, 200);
        assert.deepEqual(ids(r), [esc.e1.id], 'solo el equipo 1: el 2 es de ACSA y el 3 solo tiene una guia anterior a la 010');
        const e1 = r.body[0];
        assert.equal(e1.actual, false, 'hoy esta con ACSA');
        assert.equal(e1.codigo, esc.e1.codigo);
        assert.ok(e1.primer_documento && e1.ultimo_documento);
        assert.ok(new Date(e1.primer_documento) <= new Date(e1.ultimo_documento));
        assert.equal(new Date(e1.primer_documento).toISOString().slice(0, 10), '2026-02-02');
        assert.equal(new Date(e1.ultimo_documento).toISOString().slice(0, 10), '2026-02-10');
        // nada que identifique a otro cliente ni costos
        assert.deepEqual(Object.keys(e1).sort(), ['actual', 'codigo', 'id', 'primer_documento', 'tipo', 'ultimo_documento']);
    });

    test('ACSA ve su equipo vigente y el otro que tuvo, ambos con sus fechas; el actual va primero', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedirConToken('/api/maquinarias/mias/historicos', tokenCliente(esc.acsa));
        assert.equal(r.status, 200);
        assert.deepEqual(ids(r), [esc.e1.id, esc.e2.id].sort((a, b) => a - b));
        const e1 = r.body.find((e) => e.id === esc.e1.id);
        assert.equal(e1.actual, true);
        assert.equal(new Date(e1.primer_documento).toISOString().slice(0, 10), '2026-01-02');
        assert.equal(new Date(e1.ultimo_documento).toISOString().slice(0, 10), '2026-04-02');
        assert.equal(r.body[0].actual, true, 'los vigentes primero');
    });

    test('un equipo que solo tiene una factura de reparacion del cliente tambien aparece', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedirConToken('/api/maquinarias/mias/historicos', tokenCliente(esc.servinut));
        assert.deepEqual(ids(r), [esc.e1.id, esc.e4.id].sort((a, b) => a - b));
    });

    test('un cliente sin documentos recibe una lista vacia', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedirConToken('/api/maquinarias/mias/historicos', tokenCliente(esc.sin));
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, []);
    });

    test('permisos: mecanico, administrativo y gerente 403; token sin cliente_id 400; ?cliente_id se ignora', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await pedir('GET', '/api/maquinarias/mias/historicos', 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/maquinarias/mias/historicos', 'administrativo')).status, 403);
        assert.equal((await pedir('GET', '/api/maquinarias/mias/historicos', 'gerente')).status, 403);
        assert.equal((await pedirConToken('/api/maquinarias/mias/historicos', tokenCliente(null))).status, 400);
        assert.equal((await pedirConToken('/api/maquinarias/mias/historicos', tokenCliente(0))).status, 400);
        const r = await pedirConToken(`/api/maquinarias/mias/historicos?cliente_id=${esc.acsa}`, tokenCliente(esc.prize));
        assert.deepEqual(ids(r), [esc.e1.id], 'sigue siendo Prize');
    });

    test('/mias (equipos de hoy) no cambia y no confunde la ruta nueva con un id', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedirConToken('/api/maquinarias/mias', tokenCliente(esc.acsa));
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.map((e) => e.id), [esc.e1.id]);
        const p = await pedirConToken('/api/maquinarias/mias', tokenCliente(esc.prize));
        assert.deepEqual(p.body, []);
    });

    test('el boton Documentos del equipo anterior abre exactamente los documentos del cliente', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedirConToken(`/api/maquinarias/${esc.e1.id}/documentos`, tokenCliente(esc.prize));
        assert.equal(r.status, 200);
        assert.equal(r.body.documentos.length, 2);
        assert.ok(r.body.documentos.every((d) => d.cliente_id === esc.prize));
    });
});

describe('portal del cliente: equipos anteriores, casos de la revision', () => {
    const esc = {};
    const tokenCliente = tokenClienteDe(987656);

    async function historicos(clienteId) {
        const r = await fetch(`${entorno.base}/api/maquinarias/mias/historicos`, { headers: { Authorization: `Bearer ${tokenCliente(clienteId)}` } });
        return { status: r.status, body: await r.json() };
    }

    const guia = async (equipoId, tipo, fecha, clienteId, creada = null) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id, created_at)
         VALUES ($1, $2::tipo_guia, 'x', $3, $4, COALESCE($5, now())) RETURNING id`,
        [equipoId, tipo, fecha, clienteId, creada])).rows[0].id;

    before(async () => {
        if (!HABILITADO) return;
        const nuevoCliente = async (nombre) => (await pool.query(
            "INSERT INTO clientes (nombre, email) VALUES ($1, 'hist2@gomaq.test') RETURNING id", [`${nombre} ${crypto.randomUUID().slice(0, 6)}`])).rows[0].id;
        esc.a = await nuevoCliente('Cliente A');
        esc.b = await nuevoCliente('Cliente B');
        // equipo sin cliente hoy, con una guia de A
        esc.libre = await crearEquipo(null);
        await guia(esc.libre.id, 'despacho', '2026-02-02T09:00:00-03:00', esc.a);
        await guia(esc.libre.id, 'recepcion', '2026-02-10T10:00:00-03:00', esc.a);
        // equipo hoy con B, que A tuvo antes
        esc.deB = await crearEquipo(null);
        await guia(esc.deB.id, 'despacho', '2026-02-02T09:00:00-03:00', esc.a);
        await guia(esc.deB.id, 'despacho', '2026-03-02T09:00:00-03:00', esc.b);
        await pool.query('UPDATE maquinarias SET cliente_id = $1 WHERE id = $2', [esc.b, esc.deB.id]);
        // equipo con una factura colgada de una recepcion anterior a la 010 y otra de un despacho anterior a la 010
        esc.viejo = await crearEquipo(null);
        esc.dVieja = await guia(esc.viejo.id, 'despacho', '2025-05-01T09:00:00-03:00', esc.a, '2000-01-01T00:00:00Z');
        esc.rVieja = await guia(esc.viejo.id, 'recepcion', '2025-05-20T09:00:00-03:00', esc.a, '2000-01-01T00:00:00Z');
        await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_recepcion_id, cliente_id, folio, archivo_url) VALUES ($1, $2, $3, 'HV-1', 'x')`,
            [esc.viejo.id, esc.rVieja, esc.a]);
        esc.viejo2 = await crearEquipo(null);
        esc.dVieja2 = await guia(esc.viejo2.id, 'despacho', '2025-06-01T09:00:00-03:00', esc.a, '2000-01-01T00:00:00Z');
        await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, cliente_id, folio, archivo_url)
             VALUES ($1, $2, '2025-06-02', '2025-06-30', $3, 'HV-2', 'x')`,
            [esc.viejo2.id, esc.dVieja2, esc.a]);
        // equipo con una factura de reparacion con fecha_emision (DATE): debe contar el dia de Santiago
        esc.fe = await crearEquipo(null);
        esc.otFe = (await pool.query(
            "INSERT INTO ordenes_trabajo (maquinaria_id, cliente_id, estado, motivo) VALUES ($1, $2, 'finalizada', 'Reparacion') RETURNING id",
            [esc.fe.id, esc.a])).rows[0].id;
        datos.ordenes.push(esc.otFe);
        await pool.query("INSERT INTO facturas (orden_trabajo_id, folio, archivo_url, fecha_emision) VALUES ($1, 'HV-3', 'x', '2026-03-05')", [esc.otFe]);
    });

    after(async () => {
        if (!HABILITADO || !esc.libre) return;
        const equipos = [esc.libre.id, esc.deB.id, esc.viejo.id, esc.viejo2.id, esc.fe.id];
        await pool.query('DELETE FROM facturas WHERE maquinaria_id = ANY($1) OR orden_trabajo_id = $2', [equipos, esc.otFe]);
        await pool.query('DELETE FROM guias WHERE maquinaria_id = ANY($1)', [equipos]);
        await purgarOrdenes([esc.otFe]);
        await pool.query('UPDATE maquinarias SET cliente_id = NULL WHERE id = ANY($1)', [equipos]);
        await pool.query('DELETE FROM clientes WHERE id = ANY($1)', [[esc.a, esc.b]]);
    });

    test('actual es siempre true o false: un equipo sin cliente o con otro cliente da false', async (t) => {
        if (!requiereBase(t)) return;
        const r = await historicos(esc.a);
        assert.equal(r.status, 200);
        for (const id of [esc.libre.id, esc.deB.id]) {
            const e = r.body.find((x) => x.id === id);
            assert.ok(e, `aparece ${id}`);
            assert.strictEqual(e.actual, false);
        }
        assert.ok(r.body.every((e) => typeof e.actual === 'boolean'), 'nunca null');
    });

    test('una factura colgada de una recepcion o de un despacho anterior a la 010 no hace aparecer el equipo', async (t) => {
        if (!requiereBase(t)) return;
        const ids = (await historicos(esc.a)).body.map((e) => e.id);
        assert.ok(!ids.includes(esc.viejo.id), 'factura de recepcion anterior a la 010');
        assert.ok(!ids.includes(esc.viejo2.id), 'factura de despacho anterior a la 010');
    });

    test('sin registro de la migracion 010 no aparecen equipos que solo tienen guias (falla cerrado)', async (t) => {
        if (!requiereBase(t)) return;
        const original = (await pool.query("SELECT nombre FROM schema_migraciones WHERE nombre LIKE '010%'")).rows[0].nombre;
        try {
            await pool.query("UPDATE schema_migraciones SET nombre = 'x-' || nombre WHERE nombre = $1", [original]);
            const r = await historicos(esc.a);
            assert.equal(r.status, 200);
            const ids = r.body.map((e) => e.id);
            assert.ok(!ids.includes(esc.libre.id) && !ids.includes(esc.deB.id), 'solo tenian guias');
            assert.ok(ids.includes(esc.fe.id), 'el equipo con una OT propia sigue');
        } finally {
            await pool.query("UPDATE schema_migraciones SET nombre = $1 WHERE nombre = 'x-' || $1", [original]);
        }
        assert.ok((await pool.query('SELECT 1 FROM schema_migraciones WHERE nombre = $1', [original])).rows.length === 1, 'registro restaurado');
    });

    test('la fecha de una factura con fecha_emision es el dia de Santiago, no el del servidor', async (t) => {
        if (!requiereBase(t)) return;
        const e = (await historicos(esc.a)).body.find((x) => x.id === esc.fe.id);
        assert.ok(e);
        // la OT es de hoy; la factura es del 5 de marzo de 2026 y es la fecha mas antigua del equipo
        assert.equal(new Date(e.primer_documento).toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }), '2026-03-05');
    });
});
