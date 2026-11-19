// Configuracion de cobro, facturas con despacho y periodo, y facturas de arriendo por periodo.
// Corren contra una base local; ver utils/entornoEscritura.js (GOMAQ_TEST_ESCRITURA=1 npm test).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { requiereBase, leerRespuesta } = require('./utils/http');
const {
    pool,
    datos,
    tokens,
    entorno,
    pedir,
    crearOt,
    crearEquipo,
    algunCliente,
    cerrarOt,
    facturarDirecto,
    agregarLinea,
    subirFactura,
    pendientesDeValorizar,
} = require('./utils/entornoEscritura');

describe('configuracion de cobro, inicio de cobro y arriendos en curso', () => {
    const { inicioCobroDia } = require('../src/utils/diasArriendo');
    const DEFAULTS_CONFIG = { dia_facturacion: 5, hora_corte_despacho: 13, corte_cierra_periodo: true };

    /** Deja la configuracion como esta en la migracion, sin rastro de quien la toco. */
    async function restaurarConfiguracion() {
        for (const [clave, valor] of Object.entries(DEFAULTS_CONFIG)) {
            await pool.query(
                `INSERT INTO configuracion (clave, valor) VALUES ($1, $2::jsonb)
                 ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_por = NULL`, [clave, JSON.stringify(valor)]);
        }
    }

    /** Despacho por la ruta real, sin documento, con la hora dada (ISO con offset). */
    async function despachar(equipoId, clienteId, fechaHora) {
        const formulario = new FormData();
        formulario.append('tipo', 'despacho');
        formulario.append('sin_documento', 'true');
        formulario.append('cliente_id', String(clienteId));
        if (fechaHora) formulario.append('fecha_hora', fechaHora);
        const r = await fetch(`${entorno.base}/api/maquinarias/${equipoId}/guias`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario,
        });
        return { status: r.status, body: await r.json() };
    }

    const inicioDe = async (guiaId) =>
        (await pool.query('SELECT inicio_cobro::text AS d FROM guias WHERE id = $1', [guiaId])).rows[0].d;

    test('la migracion deja la configuracion por defecto', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', '/api/facturacion/configuracion', 'administrativo');
        assert.equal(r.status, 200);
        assert.equal(r.body.dia_facturacion, 5);
        assert.equal(r.body.hora_corte_despacho, 13);
        assert.equal('incluir_dia_recepcion' in r.body, false, 'la opcion obsoleta ya no se devuelve');
    });

    test('permisos: administrativo ve y no edita, gerente edita, mecanico y cliente no entran', async (t) => {
        if (!requiereBase(t)) return;
        assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'gerente')).status, 200);
        assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'administrativo', { dia_facturacion: 6 })).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'mecanico')).status, 403);
        assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'mecanico', { dia_facturacion: 6 })).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos-en-curso', 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos-en-curso', 'cliente')).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos-en-curso', 'administrativo')).status, 200);
        assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'administrativo')).body.dia_facturacion, 5);
    });

    test('un PUT invalido da 400 y no cambia nada', async (t) => {
        if (!requiereBase(t)) return;
        for (const cuerpo of [{ dia_facturacion: 29 }, { dia_facturacion: '5' }, { inventada: 1 }, {}, { hora_corte_despacho: 24 },
            { constructor: 1 }, { toString: true },
            { dia_facturacion: 7, hora_corte_despacho: 99 }]) {
            const r = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', cuerpo);
            assert.equal(r.status, 400, JSON.stringify(cuerpo));
        }
        // un cuerpo con `__proto__` propio (JSON.parse lo crea como clave normal) tambien se rechaza sin tumbar el servidor
        const proto = await fetch(`${entorno.base}/api/facturacion/configuracion`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.gerente}` },
            body: '{"__proto__":1}',
        });
        assert.equal(proto.status, 400);
        const r = await pedir('GET', '/api/facturacion/configuracion', 'gerente');
        assert.equal(r.body.dia_facturacion, 5, 'el PUT a medias no dejo nada guardado');
        assert.equal(r.body.hora_corte_despacho, 13);
    });

    test('el CHECK de la tabla rechaza valores fuera de rango aunque se salte la API', async (t) => {
        if (!requiereBase(t)) return;
        await assert.rejects(() => pool.query("UPDATE configuracion SET valor = '29' WHERE clave = 'dia_facturacion'"), /configuracion_valor_valido/);
        await assert.rejects(() => pool.query("UPDATE configuracion SET valor = '\"13\"' WHERE clave = 'hora_corte_despacho'"), /configuracion_valor_valido/);
        await assert.rejects(() => pool.query("UPDATE configuracion SET valor = '1' WHERE clave = 'incluir_dia_recepcion'"), /configuracion_valor_valido/);
    });

    test('el despacho guarda su inicio de cobro: 12:59 cuenta el dia, 13:00 el siguiente', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const antes = await despachar(equipo.id, cliente, '2026-03-10T12:59:00-03:00');
        assert.equal(antes.status, 201);
        assert.equal(await inicioDe(antes.body.id), '2026-03-10');
        const otro = await crearEquipo(null);
        const despues = await despachar(otro.id, cliente, '2026-03-10T13:00:00-03:00');
        assert.equal(await inicioDe(despues.body.id), '2026-03-11');
    });

    test('gomaq_inicio_cobro (SQL) coincide con inicioCobroDia (JS)', async (t) => {
        if (!requiereBase(t)) return;
        const instantes = [
            '2026-03-05T02:00:00Z', '2026-03-10T12:59:00-03:00', '2026-03-10T13:00:00-03:00', '2026-12-31T14:00:00-03:00',
            '2028-02-28T14:00:00-03:00', '2026-04-04T23:30:00-03:00', '2026-09-06T00:30:00-04:00', '2026-09-06T12:59:00-03:00',
            '2026-06-15T09:00:00-04:00', '2026-01-01T00:00:00Z',
        ];
        for (const hora of [0, 9, 13, 23]) {
            for (const instante of instantes) {
                const r = await pool.query('SELECT gomaq_inicio_cobro($1::timestamptz, $2)::text AS d', [instante, hora]);
                assert.equal(r.rows[0].d, inicioCobroDia(instante, hora), `${instante} con corte ${hora}`);
            }
        }
    });

    test('un INSERT directo (version anterior del servidor) tambien queda con inicio de cobro', async (t) => {
        if (!requiereBase(t)) return;
        const equipo = await crearEquipo(null);
        const g = await pool.query(
            `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha) VALUES ($1, 'despacho', 'x', '2026-03-10T14:00:00-03:00') RETURNING id`,
            [equipo.id]);
        assert.equal(await inicioDe(g.rows[0].id), '2026-03-11');
        const r = await pool.query(
            `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha) VALUES ($1, 'recepcion', 'x', now()) RETURNING inicio_cobro`, [equipo.id]);
        assert.equal(r.rows[0].inicio_cobro, null, 'una recepcion no tiene inicio de cobro');
    });

    test('cambiar la hora de corte afecta a los despachos nuevos y no reescribe los viejos', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const viejo = await despachar((await crearEquipo(null)).id, cliente, '2026-03-10T10:00:00-03:00');
        assert.equal(await inicioDe(viejo.body.id), '2026-03-10');
        try {
            const put = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { hora_corte_despacho: 9 });
            assert.equal(put.status, 200);
            assert.equal(put.body.hora_corte_despacho, 9);
            const nuevo = await despachar((await crearEquipo(null)).id, cliente, '2026-03-10T10:00:00-03:00');
            assert.equal(await inicioDe(nuevo.body.id), '2026-03-11', 'el despacho nuevo usa el corte nuevo');
            assert.equal(await inicioDe(viejo.body.id), '2026-03-10', 'el viejo conserva el suyo');
            const leida = await pedir('GET', '/api/facturacion/configuracion', 'administrativo');
            assert.equal(leida.body.hora_corte_despacho, 9);
            assert.ok(leida.body.actualizado_por, 'dice quien la cambio');
            assert.ok(leida.body.actualizado_at);
        } finally {
            await restaurarConfiguracion();
        }
        assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'gerente')).body.hora_corte_despacho, 13);
    });

    test('arriendos en curso: aparece con el cliente de la guia, cuenta desde su inicio y desaparece al recepcionar', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await despachar(equipo.id, cliente, '2026-01-02T09:00:00-03:00');
        const buscar = async () => (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'administrativo')).body
            .arriendos.find((a) => a.maquinaria_id === equipo.id);
        const fila = await buscar();
        assert.ok(fila, 'el equipo despachado aparece');
        assert.equal(fila.cliente_id, cliente);
        assert.equal(fila.guia_despacho_id, d.body.id);
        assert.equal(fila.inicio_cobro, '2026-01-02');
        assert.equal(fila.desde, '2026-01-02');
        assert.ok(fila.dias > 30);
        assert.ok(fila.periodos_sin_facturar >= 1 && fila.aviso === true);
        assert.match(fila.proximo_corte, /^\d{4}-\d{2}-05$/);
        // la recepcion cierra el arriendo
        const formulario = new FormData();
        formulario.append('tipo', 'recepcion');
        formulario.append('sin_documento', 'true');
        const rec = await fetch(`${entorno.base}/api/maquinarias/${equipo.id}/guias`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens.administrativo}` }, body: formulario });
        assert.equal(rec.status, 201);
        assert.equal(await buscar(), undefined, 'ya no esta en curso');
    });

    test('arriendos en curso: sin guia, con despacho fallido y con dos despachos seguidos', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const buscar = async (id) => (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'gerente')).body
            .arriendos.filter((a) => a.maquinaria_id === id);
        // cliente cargado directo en el equipo, sin ninguna guia: no aparece
        const directo = await crearEquipo(cliente);
        assert.equal((await buscar(directo.id)).length, 0);
        // despacho fallido: no cuenta
        const fallido = await crearEquipo(null);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, fallido, cliente_id) VALUES ($1, 'despacho', 'x', now(), true, $2)`, [fallido.id, cliente]);
        assert.equal((await buscar(fallido.id)).length, 0);
        // dos despachos sin recepcion entre ellos (no deberia pasar): el primero se cierra solo y el
        // segundo, a otro cliente, es el unico arriendo en curso del equipo
        const doble = await crearEquipo(null);
        const otroCliente = (await pool.query('SELECT id FROM clientes WHERE id <> $1 ORDER BY id LIMIT 1', [cliente])).rows[0];
        const g1 = await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-02-01T09:00:00-03:00', $2) RETURNING id`, [doble.id, cliente]);
        const g2 = await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-02-10T09:00:00-03:00', $2) RETURNING id`, [doble.id, otroCliente ? otroCliente.id : cliente]);
        const filas = await buscar(doble.id);
        assert.equal(filas.length, 1);
        assert.equal(filas[0].guia_despacho_id, g2.rows[0].id);
        assert.equal(filas[0].inicio_cobro, '2026-02-10');
        const pendiente = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos
            .find((a) => a.guia_despacho_id === g1.rows[0].id);
        assert.ok(pendiente, 'el primero queda pendiente de facturar');
        assert.equal(pendiente.falta_recepcion, true);
        assert.equal(pendiente.guia_recepcion_id, null);
    });

    test('arriendos en curso: recepcion y despacho a la misma hora se ordenan por id', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const hora = '2026-02-01T09:00:00-03:00';
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', $2, $3)`, [equipo.id, hora, cliente]);
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'recepcion', 'x', $2, $3)`, [equipo.id, hora, cliente]);
        const cerrado = (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'gerente')).body.arriendos;
        assert.equal(cerrado.filter((a) => a.maquinaria_id === equipo.id).length, 0, 'recepcion posterior por id: cerrado');
        await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', $2, $3)`, [equipo.id, hora, cliente]);
        const abierto = (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'gerente')).body.arriendos;
        assert.equal(abierto.filter((a) => a.maquinaria_id === equipo.id).length, 1, 'despacho posterior por id: abierto de nuevo');
    });

    test('la hora de corte vigente al registrar la recepcion decide si se cobra ese dia; cambiarla despues no altera lo registrado', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const dias = async (equipoId) => (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body
            .arriendos.find((a) => a.maquinaria_id === equipoId).dias;
        const registrar = async () => {
            const equipo = await crearEquipo(null);
            await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-03-01T08:00:00-03:00', $2)`, [equipo.id, cliente]);
            await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'recepcion', 'x', '2026-03-05T10:00:00-03:00', $2)`, [equipo.id, cliente]);
            return equipo.id;
        };
        // corte 13: la recepcion de las 10 no cobra el dia 5
        const antes = await registrar();
        assert.equal(await dias(antes), 4);
        try {
            assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { hora_corte_despacho: 9 })).status, 200);
            assert.equal(await dias(antes), 4, 'lo ya registrado no cambia con la configuracion');
            const despues = await registrar();
            assert.equal(await dias(despues), 5, 'registrada con corte 9, la recepcion de las 10 si cobra ese dia');
        } finally {
            await restaurarConfiguracion();
        }
        assert.equal(await dias(antes), 4);
    });

    test('el PUT sigue aceptando incluir_dia_recepcion (obsoleta) pero no cambia nada', async (t) => {
        if (!requiereBase(t)) return;
        try {
            const r = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { incluir_dia_recepcion: false });
            assert.equal(r.status, 200);
            assert.equal('incluir_dia_recepcion' in r.body, false);
            const cliente = await algunCliente();
            const equipo = await crearEquipo(null);
            await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'despacho', 'x', '2026-03-01T08:00:00-03:00', $2)`, [equipo.id, cliente]);
            await pool.query(`INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, 'recepcion', 'x', '2026-03-05T14:00:00-03:00', $2)`, [equipo.id, cliente]);
            const fila = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body
                .arriendos.find((a) => a.maquinaria_id === equipo.id);
            assert.equal(fila.dias, 5, 'recepcion desde el corte: el dia se cobra, sin importar la opcion obsoleta');
        } finally {
            await pool.query("UPDATE configuracion SET valor = 'true', actualizado_por = NULL WHERE clave = 'incluir_dia_recepcion'");
            await restaurarConfiguracion();
        }
    });

    test('el endpoint viejo de dias de arriendo se retiro', async (t) => {
        if (!requiereBase(t)) return;
        const r = await pedir('GET', `/api/maquinarias/${datos.maquinariaId}/dias-arriendo`, 'administrativo');
        assert.equal(r.status, 404);
    });
});

describe('la factura guarda despacho, periodo y cliente', () => {
    const SQL_023 = () => require('fs').readFileSync(
        require('path').join(__dirname, '../../db/migrations/023_facturas_periodo.sql'), 'utf8')
        + '\n' + require('fs').readFileSync(require('path').join(__dirname, '../../db/migrations/028_fin_arriendo_hora_corte.sql'), 'utf8');

    const guia = async (equipoId, tipo, fecha, clienteId) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, $2::tipo_guia, 'x', $3, $4) RETURNING id`,
        [equipoId, tipo, fecha, clienteId])).rows[0].id;

    /** Inserta una factura de arriendo como lo hacia el servidor anterior: solo con la recepcion. */
    const facturaAntigua = async (equipoId, recepcionId, folio) => (await pool.query(
        `INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url, monto) VALUES ($1, $2, $3, 'x', 1000) RETURNING *`,
        [equipoId, recepcionId, folio])).rows[0];

    const fila = async (id) => (await pool.query(
        `SELECT guia_despacho_id, to_char(periodo_desde, 'YYYY-MM-DD') AS desde, to_char(periodo_hasta, 'YYYY-MM-DD') AS hasta, cliente_id
         FROM facturas WHERE id = $1`, [id])).rows[0];

    test('una factura de arriendo insertada como el servidor anterior recibe despacho, periodo y cliente', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
        const f = await facturaAntigua(equipo.id, r, 'T-2301');
        const datosFila = await fila(f.id);
        assert.equal(datosFila.guia_despacho_id, d);
        assert.equal(datosFila.desde, '2026-03-01');
        assert.equal(datosFila.hasta, '2026-03-05');
        assert.equal(datosFila.cliente_id, cliente);
    });

    test('arriendo de 0 dias: recibe el despacho pero no periodo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T15:00:00-03:00', cliente); // cobra desde el 2
        const r = await guia(equipo.id, 'recepcion', '2026-03-01T17:00:00-03:00', cliente);
        const datosFila = await fila((await facturaAntigua(equipo.id, r, 'T-2302')).id);
        assert.equal(datosFila.guia_despacho_id, d);
        assert.equal(datosFila.desde, null);
        assert.equal(datosFila.hasta, null);
    });

    test('el periodo de una factura antigua termina segun la hora de la recepcion (corte 13)', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        for (const [hora, hasta] of [['00:00', '2026-03-04'], ['09:59', '2026-03-04'], ['12:59', '2026-03-04'],
            ['13:00', '2026-03-05'], ['23:59', '2026-03-05']]) {
            const equipo = await crearEquipo(null);
            await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
            const r = await guia(equipo.id, 'recepcion', `2026-03-05T${hora}:00-03:00`, cliente);
            assert.equal((await fila((await facturaAntigua(equipo.id, r, `T-23${hora.replace(':', '')}`)).id)).hasta, hasta, hora);
        }
    });

    test('la recepcion registrada con otro corte lo guarda y el trigger de facturas lo respeta', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        let r;
        try {
            await pool.query("UPDATE configuracion SET valor = '9' WHERE clave = 'hora_corte_despacho'");
            r = await guia(equipo.id, 'recepcion', '2026-03-05T10:00:00-03:00', cliente);
        } finally {
            await pool.query("UPDATE configuracion SET valor = '13', actualizado_por = NULL WHERE clave = 'hora_corte_despacho'");
        }
        const guardado = (await pool.query("SELECT to_char(fin_cobro, 'YYYY-MM-DD') AS d FROM guias WHERE id = $1", [r])).rows[0].d;
        assert.equal(guardado, '2026-03-05', 'fin_cobro se fijo con el corte vigente al registrar (9)');
        assert.equal((await fila((await facturaAntigua(equipo.id, r, 'T-2303')).id)).hasta, '2026-03-05');
    });

    test('recepcion el mismo dia del despacho antes del corte: el arriendo tiene 0 dias y no recibe periodo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        await guia(equipo.id, 'despacho', '2026-03-01T08:00:00-03:00', cliente);
        const r = await guia(equipo.id, 'recepcion', '2026-03-01T11:00:00-03:00', cliente);
        const datosFila = await fila((await facturaAntigua(equipo.id, r, 'T-2305')).id);
        assert.equal(datosFila.desde, null);
        assert.equal(datosFila.hasta, null);
    });

    test('dos recepciones del mismo despacho: la segunda factura se inserta sin despacho y sin error', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r1 = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
        const r2 = await guia(equipo.id, 'recepcion', '2026-03-06T14:00:00-03:00', cliente);
        const f1 = await fila((await facturaAntigua(equipo.id, r1, 'T-2304')).id);
        const f2 = await fila((await facturaAntigua(equipo.id, r2, 'T-2305')).id);
        assert.equal(f1.guia_despacho_id, d);
        assert.equal(f2.guia_despacho_id, null, 'el despacho ya tiene factura');
        assert.equal(f2.cliente_id, cliente, 'el cliente si se completa');
    });

    test('recepcion sin despacho anterior: factura sin despacho y con el cliente de la recepcion', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const r = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
        const datosFila = await fila((await facturaAntigua(equipo.id, r, 'T-2306')).id);
        assert.equal(datosFila.guia_despacho_id, null);
        assert.equal(datosFila.cliente_id, cliente);
    });

    test('una factura de reparacion toma el cliente de la OT', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await facturarDirecto(ot, 'T-2307');
        const r = await pool.query(
            `SELECT f.cliente_id, ot.cliente_id AS cliente_ot FROM facturas f JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
             WHERE f.orden_trabajo_id = $1`, [ot]);
        assert.equal(r.rows[0].cliente_id, r.rows[0].cliente_ot);
    });

    test('el indice unico impide dos facturas del mismo periodo de un despacho', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const insertar = (folio) => pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, folio, archivo_url)
             VALUES ($1, $2, '2026-03-01', '2026-03-05', $3, 'x')`, [equipo.id, d, folio]);
        await insertar('T-2308');
        await assert.rejects(() => insertar('T-2309'), /facturas_despacho_periodo_unico/);
        // otro periodo del mismo despacho si
        await pool.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, periodo_desde, periodo_hasta, folio, archivo_url)
             VALUES ($1, $2, '2026-03-06', '2026-04-05', 'T-2310', 'x')`, [equipo.id, d]);
    });

    test('correr la migracion 023 otra vez rellena lo que falte y no rompe nada', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
        const f = await facturaAntigua(equipo.id, r, 'T-2311');
        // se simula una factura anterior a la migracion
        await pool.query('UPDATE facturas SET guia_despacho_id = NULL, periodo_desde = NULL, periodo_hasta = NULL, cliente_id = NULL WHERE id = $1', [f.id]);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SQL_023());
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
        const datosFila = await fila(f.id);
        assert.equal(datosFila.guia_despacho_id, d);
        assert.equal(datosFila.desde, '2026-03-01');
        assert.equal(datosFila.hasta, '2026-03-05');
        assert.equal(datosFila.cliente_id, cliente);
        const trig = await pool.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'facturas_completar'");
        assert.equal(trig.rows[0].n, 1);
    });

    test('valorizar una OT ya facturada da 409 y no cambia el monto', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, 1000);
        await facturarDirecto(ot, 'T-2312');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 5000 });
        assert.equal(r.status, 409);
        assert.match(r.body.error, /facturada/);
        const v = await pool.query('SELECT valorizacion FROM ordenes_trabajo WHERE id = $1', [ot]);
        assert.equal(Number(v.rows[0].valorizacion), 1000);
    });

    test('autorizar el envio usa el cliente de la propia factura', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await pool.query("SELECT id, email FROM clientes WHERE email IS NOT NULL ORDER BY id LIMIT 1");
        if (cliente.rows.length === 0) return t.skip('no hay un cliente con correo en la semilla');
        const equipo = await crearEquipo(null);
        const f = (await pool.query(
            `INSERT INTO facturas (maquinaria_id, folio, archivo_url, cliente_id) VALUES ($1, 'T-2313', 'x', $2) RETURNING id`,
            [equipo.id, cliente.rows[0].id])).rows[0];
        const marca = new Date();
        const r = await pedir('POST', `/api/facturacion/${f.id}/autorizar-envio`, 'administrativo', {});
        assert.equal(r.status, 200);
        const n = await pool.query(
            `SELECT id, destinatario FROM notificaciones_pendientes WHERE created_at >= $1 AND payload->>'folio' = 'T-2313'`, [marca]);
        try {
            assert.equal(n.rows.length, 1);
            assert.equal(n.rows[0].destinatario, cliente.rows[0].email);
        } finally {
            await pool.query('DELETE FROM notificaciones_pendientes WHERE id = ANY($1)', [n.rows.map((x) => x.id)]);
        }
    });
});

describe('la factura con despacho y periodo: casos de borde', () => {
    const SQL_023 = () => require('fs').readFileSync(
        require('path').join(__dirname, '../../db/migrations/023_facturas_periodo.sql'), 'utf8')
        + '\n' + require('fs').readFileSync(require('path').join(__dirname, '../../db/migrations/028_fin_arriendo_hora_corte.sql'), 'utf8');
    const guia = async (equipoId, tipo, fecha, clienteId) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, $2::tipo_guia, 'x', $3, $4) RETURNING id`,
        [equipoId, tipo, fecha, clienteId])).rows[0].id;

    test('una OT facturada sin valorizar no queda en los pendientes de valorizar', async (t) => {
        if (!requiereBase(t)) return;
        const ot = await crearOt();
        await agregarLinea(ot, { facturable: 'si', precio_unitario: 1000 });
        await cerrarOt(ot, null);
        assert.ok((await pendientesDeValorizar()).includes(ot), 'antes de facturar, pendiente');
        assert.equal((await subirFactura(ot, 'administrativo', { folio: 'T-2401' })).status, 201);
        assert.ok(!(await pendientesDeValorizar()).includes(ot), 'facturada: ya no esta pendiente');
        const r = await pedir('PATCH', `/api/ordenes-trabajo/${ot}/valorizacion`, 'gerente', { valorizacion: 1000 });
        assert.equal(r.status, 409);
    });

    test('el relleno da el despacho a la recepcion mas antigua, aunque otra se haya facturado antes', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r1 = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
        const r2 = await guia(equipo.id, 'recepcion', '2026-03-08T14:00:00-03:00', cliente);
        // la posterior se factura primero (id menor)
        const f2 = (await pool.query(`INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, 'T-2402', 'x') RETURNING id`, [equipo.id, r2])).rows[0].id;
        const f1 = (await pool.query(`INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, 'T-2403', 'x') RETURNING id`, [equipo.id, r1])).rows[0].id;
        await pool.query('UPDATE facturas SET guia_despacho_id = NULL, periodo_desde = NULL, periodo_hasta = NULL WHERE id = ANY($1)', [[f1, f2]]);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(SQL_023());
            await client.query('COMMIT');
        } finally {
            client.release();
        }
        const r = await pool.query(
            `SELECT id, guia_despacho_id, to_char(periodo_hasta, 'YYYY-MM-DD') AS hasta FROM facturas WHERE id = ANY($1)`, [[f1, f2]]);
        const por = Object.fromEntries(r.rows.map((x) => [x.id, x]));
        assert.equal(por[f1].guia_despacho_id, d, 'la recepcion mas antigua se queda con el despacho');
        assert.equal(por[f1].hasta, '2026-03-05');
        assert.equal(por[f2].guia_despacho_id, null);
    });

    test('el relleno usa la regla historica aunque la configuracion cambie despues', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const r = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
        const f = (await pool.query(`INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, 'T-2404', 'x') RETURNING id`, [equipo.id, r])).rows[0].id;
        await pool.query('UPDATE facturas SET guia_despacho_id = NULL, periodo_desde = NULL, periodo_hasta = NULL WHERE id = $1', [f]);
        try {
            await pool.query("UPDATE configuracion SET valor = '23' WHERE clave = 'hora_corte_despacho'");
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(SQL_023());
                await client.query('COMMIT');
            } finally {
                client.release();
            }
        } finally {
            await pool.query("UPDATE configuracion SET valor = '13', actualizado_por = NULL WHERE clave = 'hora_corte_despacho'");
        }
        const fila = (await pool.query(`SELECT to_char(periodo_hasta, 'YYYY-MM-DD') AS hasta FROM facturas WHERE id = $1`, [f])).rows[0];
        assert.equal(fila.hasta, '2026-03-05');
    });

    test('la factura de una guia que no es recepcion no recibe despacho ni periodo', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
        const f = (await pool.query(`INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, 'T-2405', 'x') RETURNING guia_despacho_id, periodo_desde`, [equipo.id, d])).rows[0];
        assert.equal(f.guia_despacho_id, null);
        assert.equal(f.periodo_desde, null);
    });

    test('dos facturas simultaneas del mismo despacho no dan un error de unicidad', async (t) => {
        if (!requiereBase(t)) return;
        const cliente = await algunCliente();
        for (let vuelta = 0; vuelta < 5; vuelta++) {
            const equipo = await crearEquipo(null);
            await guia(equipo.id, 'despacho', '2026-03-01T09:00:00-03:00', cliente);
            const r1 = await guia(equipo.id, 'recepcion', '2026-03-05T14:00:00-03:00', cliente);
            const r2 = await guia(equipo.id, 'recepcion', '2026-03-06T14:00:00-03:00', cliente);
            const insertar = (r, folio) => pool.query(
                `INSERT INTO facturas (maquinaria_id, guia_recepcion_id, folio, archivo_url) VALUES ($1, $2, $3, 'x') RETURNING id`, [equipo.id, r, folio]);
            const resultados = await Promise.allSettled([insertar(r1, `T-25${vuelta}1`), insertar(r2, `T-25${vuelta}2`)]);
            assert.deepEqual(resultados.map((x) => x.status), ['fulfilled', 'fulfilled'], JSON.stringify(resultados.map((x) => x.reason && x.reason.message)));
        }
    });
});

describe('facturas de arriendo por periodo', () => {
    const DEFECTO = { dia_facturacion: 5, hora_corte_despacho: 13, corte_cierra_periodo: true };

    async function restaurar() {
        for (const [clave, valor] of Object.entries(DEFECTO)) {
            await pool.query(
                `INSERT INTO configuracion (clave, valor) VALUES ($1, $2::jsonb)
                 ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_por = NULL`, [clave, JSON.stringify(valor)]);
        }
    }

    const guiaSql = async (equipoId, tipo, fecha, clienteId) => (await pool.query(
        `INSERT INTO guias (maquinaria_id, tipo, archivo_url, fecha, cliente_id) VALUES ($1, $2::tipo_guia, 'x', $3, $4) RETURNING id`,
        [equipoId, tipo, fecha, clienteId])).rows[0].id;

    /** Un arriendo ya terminado: despacho y recepcion con las fechas dadas. */
    async function arriendo(despacho, recepcion, clienteId) {
        const cliente = clienteId || await algunCliente();
        const equipo = await crearEquipo(null);
        const d = await guiaSql(equipo.id, 'despacho', despacho, cliente);
        const r = recepcion ? await guiaSql(equipo.id, 'recepcion', recepcion, cliente) : null;
        return { equipo, d, r, cliente };
    }

    const propuesta = async (d, rol = 'administrativo') => pedir('GET', `/api/facturacion/arriendos/${d}/propuesta`, rol);

    async function facturar(campos, rol = 'administrativo') {
        const formulario = new FormData();
        for (const [k, v] of Object.entries(campos)) if (v !== undefined && v !== null) formulario.append(k, String(v));
        formulario.append('archivo', new Blob(['%PDF-1.4 prueba'], { type: 'application/pdf' }), 'f.pdf');
        const r = await fetch(`${entorno.base}/api/facturacion/arriendo`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens[rol]}` }, body: formulario });
        return leerRespuesta(r);
    }

    test('propuesta: del inicio de cobro al primer corte, con las opciones hasta el fin', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T14:00:00-03:00');
        const r = await propuesta(d);
        assert.equal(r.status, 200);
        assert.equal(r.body.desde, '2026-08-01');
        assert.equal(r.body.hasta_sugerido, '2026-08-05');
        assert.deepEqual(r.body.opciones_hasta, ['2026-08-05', '2026-09-05', '2026-10-05', '2026-10-20']);
        assert.equal(r.body.dias, 5);
        assert.equal(r.body.es_final, false);
        assert.equal(r.body.en_curso, false);
        assert.equal((await propuesta(d, 'gerente')).status, 200);
        assert.equal((await propuesta(d, 'mecanico')).status, 403);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos/99999999/propuesta', 'administrativo')).status, 404);
        assert.equal((await pedir('GET', '/api/facturacion/arriendos/abc/propuesta', 'administrativo')).status, 400);
    });

    test('facturar por periodos encadenados hasta el final, sin huecos', async (t) => {
        if (!requiereBase(t)) return;
        const { d, r: recep, cliente } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T14:00:00-03:00');
        const ids = [];
        for (const [desde, hasta] of [['2026-08-01', '2026-08-05'], ['2026-08-06', '2026-09-05'], ['2026-09-06', '2026-10-05'], ['2026-10-06', '2026-10-20']]) {
            const p = await propuesta(d);
            assert.equal(p.body.desde, desde);
            const f = await facturar({ guia_despacho_id: d, periodo_desde: desde, periodo_hasta: hasta, folio: `P-${desde}`, monto: 1000 });
            assert.equal(f.status, 201, JSON.stringify(f.body));
            assert.equal(f.body.cliente_id, cliente);
            ids.push(f.body.id);
            if (hasta === '2026-10-20') {
                assert.equal(f.body.guia_recepcion_id, recep, 'la factura final se ata a la recepcion');
            } else {
                assert.equal(f.body.guia_recepcion_id, null);
            }
        }
        const fin = await propuesta(d);
        assert.equal(fin.body.nada_que_facturar, true);
        assert.equal(fin.body.facturado_completo, true);
        const otra = await facturar({ guia_despacho_id: d, periodo_desde: '2026-10-21', periodo_hasta: '2026-10-21', folio: 'P-extra' });
        assert.equal(otra.status, 409);
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos;
        assert.equal(pend.find((a) => a.guia_despacho_id === d), undefined, 'facturado completo no esta pendiente');
    });

    test('un periodo parcial deja el resto pendiente en /pendientes', async (t) => {
        if (!requiereBase(t)) return;
        const { d, r: recep } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T14:00:00-03:00');
        const f = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-05', folio: 'PP-1' });
        assert.equal(f.status, 201);
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos.find((a) => a.guia_despacho_id === d);
        assert.ok(pend);
        assert.equal(pend.desde, '2026-08-06');
        assert.equal(pend.hasta_sugerido, '2026-09-05');
        assert.equal(pend.guia_recepcion_id, recep);
        assert.equal(pend.dias, 76);
    });

    test('periodo con hueco, solape o fin invalido se rechaza y no sube el PDF', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T14:00:00-03:00');
        const subidos = datos.storage.subidos.length;
        const hueco = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-03', periodo_hasta: '2026-08-05', folio: 'H-1' });
        assert.equal(hueco.status, 409);
        assert.equal(hueco.body.codigo, 'periodo_desactualizado');
        assert.equal(hueco.body.propuesta.desde, '2026-08-01', 'devuelve la propuesta actual');
        const invalido = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-07', folio: 'H-2' });
        assert.equal(invalido.status, 400);
        const pasado = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-10-21', folio: 'H-3' });
        assert.equal(pasado.status, 400);
        const mal = await facturar({ guia_despacho_id: d, periodo_desde: 'ayer', periodo_hasta: '2026-08-05', folio: 'H-4' });
        assert.equal(mal.status, 400);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE guia_despacho_id = $1', [d])).rows.length, 0);
        assert.ok(datos.storage.borrados.length >= datos.storage.subidos.length - subidos, 'los PDF subidos se borran');
        // solape: tras facturar el primero, repetir el mismo periodo es desactualizado
        assert.equal((await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-05', folio: 'H-5' })).status, 201);
        const repetido = await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-05', folio: 'H-6' });
        assert.equal(repetido.status, 409);
    });

    test('dos facturas simultaneas del mismo periodo: una entra y la otra se rechaza', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T14:00:00-03:00');
        const campos = { guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-08-05' };
        const [a, b] = await Promise.all([facturar({ ...campos, folio: 'C-1' }), facturar({ ...campos, folio: 'C-2' })]);
        assert.deepEqual([a.status, b.status].sort(), [201, 409]);
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE guia_despacho_id = $1', [d])).rows.length, 1);
    });

    test('compatibilidad: solo con guia_recepcion_id factura todo hasta el fin (panel antiguo)', async (t) => {
        if (!requiereBase(t)) return;
        const { d, r } = await arriendo('2026-03-01T09:00:00-03:00', '2026-03-04T14:00:00-03:00');
        const f = await facturar({ guia_recepcion_id: r, folio: 'L-1', monto: 500 });
        assert.equal(f.status, 201, JSON.stringify(f.body));
        assert.equal(f.body.guia_despacho_id, d);
        assert.equal(f.body.guia_recepcion_id, r);
        assert.equal(String(f.body.periodo_desde).slice(0, 10) >= '2026-02-28', true);
        const otra = await facturar({ guia_recepcion_id: r, folio: 'L-2' });
        assert.equal(otra.status, 409);
        assert.match(otra.body.error, /ya tiene su factura/);
        assert.equal((await facturar({ guia_recepcion_id: 99999999, folio: 'L-3' })).status, 404);
        assert.equal((await facturar({ folio: 'L-4' })).status, 400);
    });

    test('un arriendo en curso solo se factura hasta un corte ya vencido', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-01-02T09:00:00-03:00', null);
        const p = await propuesta(d);
        assert.equal(p.body.en_curso, true);
        assert.equal(p.body.desde, '2026-01-02');
        assert.equal(p.body.hasta_sugerido, '2026-01-05');
        assert.equal(p.body.es_final, false);
        assert.equal((await facturar({ guia_despacho_id: d, periodo_desde: '2026-01-02', periodo_hasta: '2026-01-05', folio: 'E-1' })).status, 201);
        const siguiente = await propuesta(d);
        assert.equal(siguiente.body.desde, '2026-01-06');
        // en curso no se puede cerrar con el panel antiguo (no hay recepcion)
        const enCurso = (await pedir('GET', '/api/facturacion/arriendos-en-curso', 'administrativo')).body.arriendos.find((a) => a.guia_despacho_id === d);
        assert.equal(enCurso.facturado_hasta, '2026-01-05');
        assert.equal(enCurso.desde, '2026-01-06');
    });

    test('despacho de otro cliente sin recepcion en medio: el primero se cierra y cada uno factura al suyo', async (t) => {
        if (!requiereBase(t)) return;
        const c1 = await algunCliente();
        const otro = (await pool.query('SELECT id FROM clientes WHERE id <> $1 ORDER BY id LIMIT 1', [c1])).rows[0];
        const equipo = await crearEquipo(null);
        const d1 = await guiaSql(equipo.id, 'despacho', '2026-02-01T09:00:00-03:00', c1);
        const d2 = await guiaSql(equipo.id, 'despacho', '2026-02-10T11:00:00-03:00', otro ? otro.id : c1);
        const p1 = await propuesta(d1);
        assert.equal(p1.body.falta_recepcion, true);
        assert.equal(p1.body.en_curso, false);
        assert.equal(p1.body.fin, '2026-02-09', 'el segundo despacho de las 11 (antes del corte) cobra ese dia al cliente nuevo');
        assert.equal(p1.body.cliente_id, c1);
        const p2 = await propuesta(d2);
        assert.equal(p2.body.en_curso, true);
        assert.equal(p2.body.desde, '2026-02-10');
        assert.equal(p2.body.cliente_id, otro ? otro.id : c1);
    });

    test('despacho a las 12:59 y 13:00 en el mismo dia que vuelve otro equipo: cada uno cuenta su dia', async (t) => {
        if (!requiereBase(t)) return;
        const a = await arriendo('2026-03-10T12:59:00-03:00', '2026-03-12T10:00:00-03:00');
        const b = await arriendo('2026-03-10T13:00:00-03:00', '2026-03-12T10:00:00-03:00');
        assert.equal((await propuesta(a.d)).body.desde, '2026-03-10');
        assert.equal((await propuesta(b.d)).body.desde, '2026-03-11');
    });

    test('devolucion el mismo dia, ya pasado el corte: 0 dias, no queda pendiente', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-03-10T15:00:00-03:00', '2026-03-10T17:00:00-03:00');
        const p = await propuesta(d);
        assert.equal(p.body.nada_que_facturar, true);
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos;
        assert.equal(pend.find((x) => x.guia_despacho_id === d), undefined);
    });

    test('monto de la factura de arriendo: solo enteros de pesos, 400 antes de subir el PDF', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-03-01T09:00:00-03:00', '2026-03-05T14:00:00-03:00');
        const subidosAntes = datos.storage.subidos.length;
        for (const monto of ['249.900', '249,9', '-1000', '1e3', '12.5', 'abc', '1 000']) {
            const r = await facturar({ guia_despacho_id: d, periodo_desde: '2026-03-01', periodo_hasta: '2026-03-05', folio: 'M-1', monto });
            assert.equal(r.status, 400, `monto ${monto}`);
        }
        assert.equal(datos.storage.subidos.length, subidosAntes, 'no se subio ningun PDF');
        assert.equal((await pool.query('SELECT 1 FROM facturas WHERE guia_despacho_id = $1', [d])).rows.length, 0);
        const ok = await facturar({ guia_despacho_id: d, periodo_desde: '2026-03-01', periodo_hasta: '2026-03-05', folio: 'M-2', monto: '249900' });
        assert.equal(ok.status, 201);
        assert.equal(Number(ok.body.monto), 249900);
    });

    test('la recepcion antes del corte no cobra ese dia; con otra hora de corte vigente al registrarla si', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-10-10T09:00:00-03:00', '2026-10-20T10:00:00-03:00');
        const p0 = await propuesta(d);
        assert.equal(p0.body.fin, '2026-10-19');
        assert.deepEqual(p0.body.opciones_hasta, ['2026-10-19']);
        try {
            assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { hora_corte_despacho: 9 })).status, 200);
            assert.equal((await propuesta(d)).body.fin, '2026-10-19', 'lo ya registrado no cambia');
            const { d: d2 } = await arriendo('2026-10-10T09:00:00-03:00', '2026-10-20T10:00:00-03:00');
            assert.equal((await propuesta(d2)).body.fin, '2026-10-20', 'registrada con corte 9 cobra ese dia');
        } finally {
            await restaurar();
        }
        assert.equal((await propuesta(d)).body.fin, '2026-10-19');
    });

    test('si el corte no cierra el periodo, el periodo termina el dia anterior al corte', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-08-01T09:00:00-03:00', '2026-10-20T14:00:00-03:00');
        try {
            const put = await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { corte_cierra_periodo: false });
            assert.equal(put.status, 200);
            assert.equal(put.body.corte_cierra_periodo, false);
            const p = await propuesta(d);
            assert.deepEqual(p.body.opciones_hasta, ['2026-08-04', '2026-09-04', '2026-10-04', '2026-10-20']);
            assert.equal((await pedir('GET', '/api/facturacion/configuracion', 'administrativo')).body.corte_cierra_periodo, false);
            assert.equal((await pedir('PUT', '/api/facturacion/configuracion', 'gerente', { corte_cierra_periodo: 'no' })).status, 400);
        } finally {
            await restaurar();
        }
        assert.equal((await propuesta(d)).body.opciones_hasta[0], '2026-08-05');
    });

    test('recepcion retroactiva anterior a lo ya facturado: se avisa y no admite otra factura', async (t) => {
        if (!requiereBase(t)) return;
        const { equipo, d, cliente } = await arriendo('2026-08-01T09:00:00-03:00', null);
        // en curso se puede facturar de una vez hasta cualquier corte vencido
        assert.equal((await facturar({ guia_despacho_id: d, periodo_desde: '2026-08-01', periodo_hasta: '2026-09-05', folio: 'R-1' })).status, 201);
        // la recepcion se registra despues, con fecha anterior a lo facturado
        await guiaSql(equipo.id, 'recepcion', '2026-08-20T14:00:00-03:00', cliente);
        const p = await propuesta(d);
        assert.equal(p.body.facturado_de_mas, true);
        assert.equal(p.body.nada_que_facturar, true);
        // sigue visible en pendientes, con la marca, para que se emita la nota de credito
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos;
        const item = pend.find((x) => x.guia_despacho_id === d);
        assert.ok(item, 'el arriendo facturado de mas sigue visible');
        assert.equal(item.facturado_de_mas, true);
        assert.equal(item.facturado_hasta, '2026-09-05');
        assert.equal(item.dias, 0);
        // y no admite otra factura
        assert.equal((await facturar({ guia_despacho_id: d, periodo_desde: '2026-09-06', periodo_hasta: '2026-09-10', folio: 'R-2' })).status, 409);
    });

    test('/pendientes con recepciones repetidas ya no duplica el arriendo', async (t) => {
        if (!requiereBase(t)) return;
        const { equipo, d, cliente } = await arriendo('2026-03-01T09:00:00-03:00', '2026-03-05T14:00:00-03:00');
        await guiaSql(equipo.id, 'recepcion', '2026-03-06T14:00:00-03:00', cliente); // recepcion repetida (huerfana)
        const pend = (await pedir('GET', '/api/facturacion/pendientes', 'administrativo')).body.arriendos.filter((a) => a.guia_despacho_id === d);
        assert.equal(pend.length, 1);
    });

    test('valorizar y facturar una OT no se mezclan con los arriendos (campos nuevos en /pendientes)', async (t) => {
        if (!requiereBase(t)) return;
        const { d } = await arriendo('2026-03-01T09:00:00-03:00', '2026-03-05T14:00:00-03:00');
        const fila = (await pedir('GET', '/api/facturacion/pendientes', 'gerente')).body.arriendos.find((a) => a.guia_despacho_id === d);
        for (const campo of ['guia_recepcion_id', 'maquinaria_codigo', 'cliente_nombre', 'fecha_despacho', 'fecha_recepcion', 'dias', 'desde', 'hasta_sugerido', 'es_final']) {
            assert.ok(campo in fila, `falta ${campo}`);
        }
        assert.equal(fila.dias, 5);
    });
});
