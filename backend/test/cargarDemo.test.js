// Pruebas del script de datos de demostracion (scripts/cargar_demo.js).
//
// Sin base: el plan (RUT validos, marca [DEMO], fechas relativas a hoy, estados de cobranza, periodos y montos)
// y que --simular nunca confirma la transaccion.
//
// Con base (GOMAQ_TEST_ESCRITURA=1 y DATABASE_URL): crea una base TEMPORAL propia (CREATE DATABASE), le aplica
// el esquema y las migraciones con scripts/migrar.js, le pone unos datos "reales" y prueba carga -> segunda carga
// sin nuevos -> lo que leen las pantallas -> borrado que deja la base identica. Usa una base aparte para no
// cruzarse con las demas pruebas de escritura, que corren en paralelo y cuentan filas de toda la base.

require('dotenv').config();
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client, Pool } = require('pg');
const {
    planDemo, conteoPlan, rutConDigito, digitoVerificador, conIva, consultar, cargarDemo, borrarDemo, MARCA, PREFIJO_FOLIO,
} = require('../scripts/cargar_demo');
const { rutValido } = require('../src/utils/rut');
const { estadoCobranza, diasMora } = require('../src/utils/cobranza');
const { sumarDias } = require('../src/utils/diasArriendo');

const HOY = '2026-11-17';
const desplazamiento = (hoy, dia) => (dia === null ? null : Math.round((Date.parse(`${dia}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86400000));

describe('plan de la demo (sin base)', () => {
    const plan = planDemo(HOY);

    test('RUT ficticios con digito verificador correcto, en el formato del sistema', () => {
        assert.equal(rutConDigito(11111111), '11111111-1');
        assert.equal(digitoVerificador(99990002), 'K');
        for (const c of plan.clientes) {
            assert.match(c.rut, /^\d{8}-[\dK]$/, c.rut);
            assert.ok(rutValido(c.rut), c.rut);
        }
        assert.equal(new Set(plan.clientes.map((c) => c.rut)).size, plan.clientes.length);
    });

    test('clientes: 6, marcados, sin correo ni telefono, plazos variados, uno sin ubicacion y en Nuble/Biobio/Maule', () => {
        assert.equal(plan.clientes.length, 6);
        for (const c of plan.clientes) {
            assert.ok(c.nombre.startsWith(`${MARCA} `), c.nombre);
            assert.equal(c.email, undefined);
            assert.equal(c.telefono, undefined);
            if (c.latitud !== null) {
                assert.ok(c.latitud > -38.5 && c.latitud < -35, c.nombre);
                assert.ok(c.longitud > -73.5 && c.longitud < -71, c.nombre);
            }
        }
        assert.deepEqual([...new Set(plan.clientes.map((c) => c.plazo_pago_dias))].sort((a, b) => a - b), [0, 30, 45, 60]);
        assert.equal(plan.clientes.filter((c) => c.latitud === null && c.longitud === null).length, 1);
    });

    test('todo texto libre lleva la marca y los folios el prefijo', () => {
        for (const e of plan.equipos) {
            assert.ok(e.codigo.startsWith('DEMO-'), e.codigo);
            assert.ok(e.codigo.length <= 20);
            assert.ok(e.descripcion.startsWith(MARCA));
        }
        for (const i of plan.insumos) assert.ok(i.nombre.startsWith(MARCA));
        for (const o of plan.ordenes) {
            for (const campo of ['motivo', 'diagnostico', 'observacion_final']) {
                if (o[campo] !== null) assert.ok(o[campo].startsWith(MARCA), `${o.clave}.${campo}`);
            }
            for (const l of o.lineas) assert.ok(l.descripcion.startsWith(MARCA));
        }
        for (const l of plan.lecturas) assert.ok(l.observacion.startsWith(MARCA));
        for (const f of plan.facturas) {
            assert.ok(f.folio.startsWith(PREFIJO_FOLIO), f.folio);
            if (f.anulada_nc) assert.ok(f.anulada_nc.startsWith(PREFIJO_FOLIO));
        }
    });

    test('12 facturas que cubren todos los estados de cobranza', () => {
        const estados = {};
        for (const f of plan.facturas) estados[estadoCobranza(f, HOY)] = (estados[estadoCobranza(f, HOY)] || 0) + 1;
        assert.deepEqual(estados, { pagada: 3, vencida: 2, proxima: 3, anulada: 1, sin_vencimiento: 1, al_dia: 2 });
        const vencidas = plan.facturas.filter((f) => estadoCobranza(f, HOY) === 'vencida').map((f) => diasMora(f, HOY)).sort((a, b) => a - b);
        assert.deepEqual(vencidas, [10, 40]);
        for (const f of plan.facturas.filter((x) => estadoCobranza(x, HOY) === 'al_dia')) {
            assert.ok(desplazamiento(HOY, f.fecha_vencimiento) > 7, f.folio);
        }
        for (const f of plan.facturas.filter((x) => estadoCobranza(x, HOY) === 'pagada')) assert.ok(f.fecha_pago <= HOY);
    });

    test('montos en pesos enteros, con IVA, traslado coherente y arriendos entre 250.000 y 3.500.000 neto', () => {
        for (const f of plan.facturas) {
            for (const campo of ['monto', 'monto_neto', 'monto_traslado']) assert.ok(Number.isInteger(f[campo]), `${f.folio}.${campo}`);
            assert.equal(f.monto, conIva(f.monto_neto));
            assert.ok(f.monto_traslado <= f.monto_neto);
            if (f.traslado_entrega !== null || f.traslado_retiro !== null) {
                assert.equal((f.traslado_entrega || 0) + (f.traslado_retiro || 0), f.monto_traslado, f.folio);
            }
            if (f.tipo === 'arriendo') assert.ok(f.monto_neto >= 250000 && f.monto_neto <= 3500000, f.folio);
        }
        assert.ok(plan.facturas.some((f) => f.traslado_entrega && f.traslado_retiro), 'al menos una con el traslado dividido');
    });

    test('fechas validas: emision no futura, vencimiento no anterior a la emision, periodos contiguos dentro del arriendo', () => {
        for (const f of plan.facturas) {
            assert.ok(f.fecha_emision <= HOY, f.folio);
            if (f.fecha_vencimiento) assert.ok(f.fecha_vencimiento >= f.fecha_emision, f.folio);
            if (f.fecha_pago) assert.ok(f.fecha_pago >= f.fecha_emision, f.folio);
        }
        for (const a of plan.arriendos) {
            const propias = plan.facturas.filter((f) => f.arriendo === a.clave).sort((x, y) => (x.periodo_desde < y.periodo_desde ? -1 : 1));
            let esperado = a.inicio;
            for (const f of propias) {
                assert.equal(f.periodo_desde, esperado, `${f.folio} empieza donde termino la anterior`);
                assert.ok(f.periodo_hasta >= f.periodo_desde && f.periodo_hasta < HOY);
                if (a.fin) assert.ok(f.periodo_hasta <= a.fin, f.folio);
                if (f.recepcion) assert.equal(f.periodo_hasta, a.fin, `${f.folio} cierra el arriendo`);
                assert.ok(f.fecha_emision > f.periodo_hasta, `${f.folio} se emite despues del periodo`);
                esperado = sumarDias(f.periodo_hasta, 1);
            }
        }
        assert.equal(plan.arriendos.filter((a) => a.fin).length, 2, 'dos arriendos devueltos');
    });

    test('las fechas son relativas a hoy: otro dia corre todo lo mismo', () => {
        const otro = planDemo('2027-03-01');
        const fechas = (p) => [
            ...p.guias.map((g) => g.dia),
            ...p.facturas.flatMap((f) => [f.periodo_desde, f.periodo_hasta, f.fecha_emision, f.fecha_vencimiento, f.fecha_pago]),
            ...p.lecturas.map((l) => l.dia),
            ...p.ordenes.flatMap((o) => [o.creada.dia, o.cierre ? o.cierre.dia : null]),
        ];
        assert.deepEqual(fechas(plan).map((d) => desplazamiento(HOY, d)), fechas(otro).map((d) => desplazamiento('2027-03-01', d)));
        const estados = (p) => p.facturas.map((f) => estadoCobranza(f, p.hoy));
        assert.deepEqual(estados(plan), estados(otro));
        assert.throws(() => planDemo('17-11-2026'));
    });

    test('OT: facturable y valorizacion salen de las lineas (sin repuestos cobrables no se cobra)', () => {
        const ot = Object.fromEntries(plan.ordenes.map((o) => [o.clave, o]));
        assert.equal(ot.OT1.facturable, true);
        assert.equal(ot.OT1.valorizacion, 2 * 18500 + 64900 + 148000);
        assert.equal(ot.OT2.facturable, false, 'lineas pendientes: aun no se cobra');
        assert.equal(ot.OT3.facturable, true);
        assert.equal(ot.OT3.valorizacion, null, 'pendiente de valorizar');
        assert.equal(ot.OT4.valorizacion, 72000, 'lista para facturar');
        for (const o of plan.ordenes) assert.equal(o.mecanico, undefined, 'ninguna OT con mecanico');
        const reparacion = plan.facturas.find((f) => f.tipo === 'reparacion');
        assert.equal(reparacion.orden, 'OT1');
        assert.equal(reparacion.monto_neto, ot.OT1.valorizacion);
    });

    test('conteo del plan', () => {
        assert.deepEqual(conteoPlan(plan), {
            clientes: 6, maquinarias: 4, insumos: 2, guias: 8, ordenes_trabajo: 4,
            movimientos_insumo: 8, lecturas_horometro: 11, facturas: 12,
        });
    });
});

describe('transaccion del script (sin base, con un cliente falso)', () => {
    function clienteFalso() {
        const sentencias = [];
        let n = 0;
        return {
            sentencias,
            query: async (sql) => {
                const s = sql.trim();
                sentencias.push(s.split(/\s+/).slice(0, 3).join(' '));
                if (/AS hoy/.test(s)) return { rows: [{ hoy: HOY }], rowCount: 1 };
                if (/FROM ejecutivos/.test(s)) return { rows: [{ id: 7, nombre: 'Freddy' }], rowCount: 1 };
                if (/FROM ubicaciones_stock/.test(s)) return { rows: [{ id: 1 }], rowCount: 1 };
                if (/RETURNING id/.test(s)) return { rows: [{ id: ++n }], rowCount: 1 };
                if (/AS n\b/.test(s)) return { rows: [{ n: 0 }], rowCount: 1 };
                return { rows: [], rowCount: 0 };
            },
        };
    }

    test('--simular termina en ROLLBACK y nunca confirma', async () => {
        const db = clienteFalso();
        const r = await cargarDemo(db, { simular: true });
        assert.equal(db.sentencias[0], 'BEGIN');
        assert.equal(db.sentencias.at(-1), 'ROLLBACK');
        assert.ok(!db.sentencias.includes('COMMIT'));
        assert.equal(r.nuevos.facturas, 12);
        assert.equal(r.nuevos.clientes, 6);
        assert.ok(db.sentencias.some((s) => s.startsWith('SELECT pg_advisory_xact_lock')));

        const b = clienteFalso();
        await borrarDemo(b, { simular: true });
        assert.equal(b.sentencias.at(-1), 'ROLLBACK');
        assert.ok(!b.sentencias.includes('COMMIT'));
    });

    test('sin --simular confirma una sola vez al final', async () => {
        const db = clienteFalso();
        await cargarDemo(db, { simular: false });
        assert.equal(db.sentencias.filter((s) => s === 'COMMIT').length, 1);
        assert.equal(db.sentencias.at(-1), 'COMMIT');
    });

    test('consultar pasa solo los parametros que usa la consulta, renumerados', async () => {
        const vistos = [];
        const db = { query: async (sql, params) => { vistos.push([sql, params]); return { rows: [] }; } };
        await consultar(db, 'SELECT $2, $4, $2, $10', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
        assert.deepEqual(vistos[0], ['SELECT $1, $2, $1, $3', ['b', 'd', 'j']]);
    });
});

const HABILITADO = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);

describe('carga y borrado contra una base temporal', { skip: HABILITADO ? false : 'pruebas de escritura deshabilitadas: usar GOMAQ_TEST_ESCRITURA=1 con una base local' }, () => {
    const nombreBase = `gomaq_prueba_demo_${crypto.randomUUID().slice(0, 8).replace(/-/g, '')}`;
    let admin;
    let db;
    let urlTemporal;
    let sinBase = null;
    const real = {};
    let fotoInicial;
    let fotoCargada;

    // huella de todas las tablas: conteo y md5 del contenido ordenado
    async function foto() {
        const tablas = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.tablename);
        const out = {};
        for (const t of tablas) {
            const r = (await db.query(`SELECT COUNT(*)::int AS n, md5(COALESCE(string_agg(x::text, E'\\n' ORDER BY x::text), '')) AS h FROM "${t}" x`)).rows[0];
            out[t] = `${r.n}:${r.h}`;
        }
        return out;
    }
    const contar = async (sql, params = []) => (await db.query(sql, params)).rows[0].n;
    const saltarSinBase = (t) => {
        if (sinBase) { t.skip(sinBase); return true; }
        return false;
    };

    before(async () => {
        admin = new Client({ connectionString: process.env.DATABASE_URL });
        await admin.connect();
        try {
            await admin.query(`CREATE DATABASE ${nombreBase}`);
        } catch (err) {
            sinBase = `no se pudo crear la base temporal (${err.message})`;
            return;
        }
        const u = new URL(process.env.DATABASE_URL);
        u.pathname = `/${nombreBase}`;
        urlTemporal = u.toString();
        execFileSync(process.execPath, [path.join(__dirname, '../scripts/migrar.js')], {
            env: { ...process.env, DATABASE_URL: urlTemporal }, stdio: 'pipe', timeout: 120000,
        });
        db = new Client({ connectionString: urlTemporal });
        await db.connect();

        // datos "reales" que la demo no debe tocar: un ejecutivo, un cliente, un equipo arrendado con su guia y
        // su factura, un insumo con stock y un aviso pendiente
        real.ejecutivo = (await db.query("INSERT INTO ejecutivos (nombre) VALUES ('Freddy') RETURNING id")).rows[0].id;
        real.cliente = (await db.query(
            "INSERT INTO clientes (nombre, rut, plazo_pago_dias, ejecutivo_id) VALUES ('Cliente Real Prueba', '11111111-1', 30, $1) RETURNING id",
            [real.ejecutivo]
        )).rows[0].id;
        real.equipo = (await db.query(
            "INSERT INTO maquinarias (codigo, tipo, cliente_id) VALUES ('GH-REAL1', 'Grúa horquilla', $1) RETURNING id", [real.cliente]
        )).rows[0].id;
        real.guia = (await db.query(
            "INSERT INTO guias (maquinaria_id, tipo, fecha, cliente_id) VALUES ($1, 'despacho', now() - interval '20 days', $2) RETURNING id",
            [real.equipo, real.cliente]
        )).rows[0].id;
        await db.query(
            `INSERT INTO facturas (maquinaria_id, guia_despacho_id, cliente_id, folio, archivo_url, monto, fecha_emision, fecha_vencimiento)
             VALUES ($1, $2, $3, '9001', 'facturas/real.pdf', 500000, CURRENT_DATE - 5, CURRENT_DATE - 1)`,
            [real.equipo, real.guia, real.cliente]
        );
        real.insumo = (await db.query("INSERT INTO insumos (nombre, unidad_medida, stock_actual) VALUES ('Filtro real', 'unidad', 3) RETURNING id")).rows[0].id;
        await db.query("INSERT INTO stock_ubicacion (ubicacion_id, insumo_id, cantidad) SELECT id, $1, 3 FROM ubicaciones_stock WHERE tipo = 'bodega' LIMIT 1", [real.insumo]);
        await db.query("INSERT INTO notificaciones_pendientes (canal, destinatario, payload) VALUES ('email', 'nadie@ejemplo.invalid', '{}')");
        fotoInicial = await foto();
    });

    after(async () => {
        if (db) await db.end().catch(() => {});
        if (admin) {
            if (!sinBase) await admin.query(`DROP DATABASE IF EXISTS ${nombreBase} WITH (FORCE)`).catch(() => {});
            await admin.end();
        }
    });

    test('--simular no cambia nada', async (t) => {
        if (saltarSinBase(t)) return;
        const r = await cargarDemo(db, { simular: true });
        assert.equal(r.yaCargada, false);
        assert.deepEqual(r.nuevos, { ...conteoPlan(r.plan), stock_ubicacion: 2 });
        assert.deepEqual(await foto(), fotoInicial);
        // la orden de linea de comandos tambien
        const salida = execFileSync(process.execPath, [path.join(__dirname, '../scripts/cargar_demo.js'), '--simular'], {
            env: { ...process.env, DATABASE_URL: urlTemporal }, encoding: 'utf8', timeout: 60000,
        });
        assert.match(salida, /Simulacion: no se guardo nada/);
        assert.match(salida, /DEMO-0012/);
        assert.deepEqual(await foto(), fotoInicial);
    });

    test('la carga inserta lo esperado, usa el ejecutivo existente, no encola avisos ni toca lo real', async (t) => {
        if (saltarSinBase(t)) return;
        const avisos0 = await contar('SELECT COUNT(*)::int AS n FROM notificaciones_pendientes');
        const ejecutivos0 = await contar('SELECT COUNT(*)::int AS n FROM ejecutivos');
        const r = await cargarDemo(db);
        assert.deepEqual(r.nuevos, {
            clientes: 6, maquinarias: 4, insumos: 2, stock_ubicacion: 2, guias: 8, ordenes_trabajo: 4,
            movimientos_insumo: 8, lecturas_horometro: 11, facturas: 12,
        });
        assert.equal(await contar('SELECT COUNT(*)::int AS n FROM notificaciones_pendientes'), avisos0);
        assert.equal(await contar('SELECT COUNT(*)::int AS n FROM ejecutivos'), ejecutivos0, 'no crea ejecutivos');
        assert.equal(await contar("SELECT COUNT(*)::int AS n FROM clientes WHERE starts_with(nombre, '[DEMO]') AND ejecutivo_id = $1", [real.ejecutivo]), 2);
        assert.equal(await contar("SELECT COUNT(*)::int AS n FROM clientes WHERE starts_with(nombre, '[DEMO]') AND (email IS NOT NULL OR telefono IS NOT NULL)"), 0);
        assert.equal(await contar('SELECT COUNT(*)::int AS n FROM ordenes_eventos'), 0);
        assert.equal(await contar("SELECT COUNT(*)::int AS n FROM ordenes_trabajo WHERE mecanico_id IS NOT NULL AND starts_with(motivo, '[DEMO]')"), 0);
        // las filas reales siguen identicas
        const despues = await foto();
        for (const tabla of ['usuarios', 'ejecutivos', 'notificaciones_pendientes', 'configuracion', 'ubicaciones_stock', 'schema_migraciones']) {
            assert.equal(despues[tabla], fotoInicial[tabla], tabla);
        }
        const realCliente = await db.query('SELECT nombre, rut FROM clientes WHERE id = $1', [real.cliente]);
        assert.equal(realCliente.rows[0].nombre, 'Cliente Real Prueba');
        const realEquipo = await db.query('SELECT cliente_id, estado FROM maquinarias WHERE id = $1', [real.equipo]);
        assert.equal(realEquipo.rows[0].cliente_id, real.cliente);
        // el trigger facturas_traslado_coherente no borro ninguna division
        assert.equal(await contar("SELECT COUNT(*)::int AS n FROM facturas WHERE starts_with(folio, 'DEMO-') AND traslado_entrega IS NOT NULL AND traslado_retiro IS NOT NULL"), 1);
        assert.equal(await contar("SELECT COUNT(*)::int AS n FROM facturas WHERE starts_with(folio, 'DEMO-') AND monto_neto IS NULL"), 0);
        fotoCargada = await foto();
    });

    test('una segunda carga no inserta nada', async (t) => {
        if (saltarSinBase(t)) return;
        const r = await cargarDemo(db);
        assert.equal(r.yaCargada, true);
        assert.ok(Object.values(r.nuevos).every((n) => n === 0));
        assert.deepEqual(await foto(), fotoCargada);
    });

    test('las pantallas ven los datos: cobranza, historial, linea de tiempo, facturar y rentabilidad', async (t) => {
        if (saltarSinBase(t)) return;
        const { cargarEmitidas } = require('../src/utils/facturasEmitidas');
        const { cargarHistorialCliente } = require('../src/utils/historialCliente');
        const { leerLineaTiempo } = require('../src/utils/lineaTiempoEquipo');
        const { leerConfiguracion } = require('../src/utils/configuracion');
        const { cargarArriendos, filtrarPorFacturar } = require('../src/utils/arriendos');
        const { SQL_OT_POR_VALORIZAR, SQL_OT_LISTA_FACTURAR } = require('../src/utils/ordenes');
        const { SQL_FACTURAS_VENCIDAS, SQL_FACTURAS_PROXIMAS } = require('../src/utils/cobranza');

        // las utilidades consultan en paralelo, como con el pool del servidor
        const lector = new Pool({ connectionString: urlTemporal, max: 4 });
        t.after(() => lector.end());
        const totales = {};
        for (const estado of ['vencidas', 'proximas', 'pagadas', 'anuladas', 'por_cobrar']) {
            totales[estado] = (await cargarEmitidas(lector, { estado, q: 'DEMO-' })).total;
        }
        assert.deepEqual(totales, { vencidas: 2, proximas: 3, pagadas: 3, anuladas: 1, por_cobrar: 8 });
        const vencidas = (await cargarEmitidas(lector, { estado: 'vencidas', q: 'DEMO-' })).items;
        assert.deepEqual(vencidas.map((f) => f.dias_mora), [40, 10]);
        assert.ok(vencidas.every((f) => f.ejecutivo_nombre === 'Freddy'));
        // las tarjetas del inicio cuentan con los mismos predicados (la factura real vencida tambien cuenta)
        assert.equal(await contar(`SELECT COUNT(*)::int AS n FROM facturas f WHERE ${SQL_FACTURAS_VENCIDAS}`), 3);
        assert.equal(await contar(`SELECT COUNT(*)::int AS n FROM facturas f WHERE ${SQL_FACTURAS_PROXIMAS}`), 3);

        const clientes = (await db.query("SELECT id FROM clientes WHERE starts_with(nombre, '[DEMO]') ORDER BY id")).rows.map((r) => r.id);
        const config = await leerConfiguracion(lector);
        const completo = await cargarHistorialCliente(lector, config, clientes[0]);
        assert.equal(completo.resumen.arriendos, 2);
        assert.equal(completo.resumen.equipos_arrendados_hoy, 1);
        assert.equal(completo.resumen.facturas, 6);
        assert.equal(completo.ordenes.length, 2);
        const vacio = await cargarHistorialCliente(lector, config, clientes[5]);
        assert.deepEqual(vacio.resumen, { equipos_arrendados_hoy: 0, arriendos: 0, facturas: 0, total_facturado: 0 });

        const e1 = (await db.query("SELECT id FROM maquinarias WHERE codigo = 'DEMO-GH-01'")).rows[0].id;
        const linea = await leerLineaTiempo(lector, e1);
        const eventos = linea.tramos.flatMap((tr) => tr.eventos);
        const porTipo = {};
        for (const e of eventos) porTipo[e.tipo] = (porTipo[e.tipo] || 0) + 1;
        assert.deepEqual(porTipo, { guia_despacho: 2, guia_recepcion: 1, orden_trabajo: 2, factura: 6, lectura_horometro: 6 });
        const ot1 = eventos.find((e) => e.tipo === 'orden_trabajo' && e.estado === 'finalizada');
        assert.equal(ot1.costo_repuestos, 249900);

        const porFacturar = filtrarPorFacturar(await cargarArriendos(db, config)).map((a) => a.maquinaria_codigo);
        assert.deepEqual(porFacturar, ['DEMO-PL-01']);
        const enCurso = (await cargarArriendos(db, config)).filter((a) => a.maquinaria_codigo.startsWith('DEMO-'));
        assert.ok(enCurso.every((a) => !a.facturado_de_mas));
        const motivos = async (predicado) => (await db.query(`SELECT ot.motivo FROM ordenes_trabajo ot WHERE ${predicado}`)).rows.map((r) => r.motivo);
        assert.deepEqual(await motivos(SQL_OT_POR_VALORIZAR), [`${MARCA} Manguera hidraulica rota`]);
        assert.deepEqual(await motivos(SQL_OT_LISTA_FACTURAR), [`${MARCA} El cargador de bateria no carga`]);

        // la rentabilidad de los ultimos 12 meses ve repuestos y facturas del equipo (filtra por created_at)
        const lineas = await contar(
            `SELECT COUNT(*)::int AS n FROM movimientos_insumo mi JOIN ordenes_trabajo ot ON ot.id = mi.orden_trabajo_id
             WHERE ot.maquinaria_id = $1 AND mi.created_at BETWEEN now() - interval '1 year' AND now()`, [e1]);
        assert.equal(lineas, 5);
        const facturas = await contar(
            `SELECT COUNT(*)::int AS n FROM facturas f LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
             WHERE COALESCE(f.maquinaria_id, ot.maquinaria_id) = $1 AND f.created_at BETWEEN now() - interval '1 year' AND now()`, [e1]);
        assert.equal(facturas, 6);
    });

    test('el borrado se niega si un cliente DEMO quedo ligado a un equipo real', async (t) => {
        if (saltarSinBase(t)) return;
        const demo = (await db.query("SELECT id FROM clientes WHERE starts_with(nombre, '[DEMO]') ORDER BY id LIMIT 1")).rows[0].id;
        const g = (await db.query(
            "INSERT INTO guias (maquinaria_id, tipo, fecha, cliente_id) VALUES ($1, 'recepcion', now(), $2) RETURNING id", [real.equipo, demo]
        )).rows[0].id;
        await assert.rejects(borrarDemo(db), (err) => err.codigo === 'conflicto' && /guias de equipos reales/.test(err.message));
        assert.equal(await contar("SELECT COUNT(*)::int AS n FROM clientes WHERE starts_with(nombre, '[DEMO]')"), 6, 'no borro nada');
        await db.query('DELETE FROM guias WHERE id = $1', [g]);
    });

    test('--borrar --simular no borra; --borrar deja la base identica, incluso con eventos de una OT DEMO', async (t) => {
        if (saltarSinBase(t)) return;
        const s = await borrarDemo(db, { simular: true });
        assert.equal(s.borrados.facturas, 12);
        assert.deepEqual(await foto(), fotoCargada);

        // como si en la demo alguien hubiera movido una OT desde el panel (ordenes_eventos es de solo insercion)
        await db.query(
            `INSERT INTO ordenes_eventos (orden_trabajo_id, tipo, ocurrio_en, origen)
             SELECT id, 'creacion', now(), 'panel' FROM ordenes_trabajo WHERE starts_with(motivo, '[DEMO]') LIMIT 1`
        );
        const r = await borrarDemo(db);
        assert.deepEqual(
            Object.fromEntries(Object.entries(r.borrados).filter(([, n]) => n > 0)),
            {
                facturas: 12, lecturas_horometro: 11, movimientos_insumo: 8, stock_ubicacion: 2, ordenes_eventos: 1,
                ordenes_trabajo: 4, guias: 8, maquinarias: 4, insumos: 2, clientes: 6,
            }
        );
        assert.deepEqual(await foto(), fotoInicial);
        // otra vez: no hay nada que borrar
        const otra = await borrarDemo(db);
        assert.ok(Object.values(otra.borrados).every((n) => n === 0));
    });
});
