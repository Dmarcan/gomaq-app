// Linea de tiempo de un equipo: guias, ordenes de trabajo, facturas y lecturas de horometro en un
// solo orden, con el cliente de cada evento.
//
// Dos reglas de fondo:
//   - El cliente de cada evento es el que el propio registro guardo en su momento (guias.cliente_id,
//     ordenes_trabajo.cliente_id, COALESCE(facturas.cliente_id, ot.cliente_id), lecturas_horometro.cliente_id),
//     nunca maquinarias.cliente_id, que es el de hoy. Igual que utils/documentosEquipo.js.
//   - Muestra montos POR EVENTO y no totales. Los totales de costos salen de un solo lugar
//     (utils/rentabilidad.js); aca se reutilizan sus funciones para el costo de cada orden y el ingreso
//     de cada factura, sin repetir la regla.
//
// Mantenciones: lo unico que deja rastro es una OT con tipo_servicio 'preventivo' y la lectura que el
// panel deja al registrar una mantencion con horometro (POST /api/horometro/maquinaria/:id/reiniciar).
// El reinicio que hace el mecanico desde el telefono (reiniciar_contador) guarda su lectura con la
// observacion que escribio el mecanico, asi que no se puede distinguir de una lectura normal.
//
// `armarLineaTiempo` es pura; `leerLineaTiempo` hace las consultas (una por fuente, en paralelo, cada
// una con tope) y se la entrega.

const { calcularGasto, ingresoFactura } = require('./rentabilidad');

/** Cantidad maxima de eventos que devuelve la linea de tiempo. */
const TOPE_EVENTOS = 500;

/** Observacion que deja el panel al registrar una mantencion con horometro (routes/horometro.js). */
const OBSERVACION_MANTENCION_PANEL = 'Mantencion preventiva registrada desde el panel';

const SIN_CLIENTE = null;

const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const iso = (v) => (v === null || v === undefined ? null : (v instanceof Date ? v : new Date(v)).toISOString());
const idOCero = (v) => (v === null || v === undefined ? null : Number(v));

function base(tipo, fila, fecha) {
    return {
        tipo,
        id: Number(fila.id),
        fecha: iso(fecha),
        cliente_id: idOCero(fila.cliente_id),
        cliente_nombre: fila.cliente_nombre || null,
    };
}

function eventoGuia(g) {
    const e = {
        ...base(g.tipo === 'recepcion' ? 'guia_recepcion' : 'guia_despacho', g, g.fecha),
        fallido: Boolean(g.fallido),
        sin_documento: Boolean(g.sin_documento),
    };
    // el dia que se empieza a cobrar (despacho) o se termina de cobrar (recepcion), ya resuelto por el servidor
    if (g.tipo === 'recepcion') e.fin_cobro = g.fin_cobro || null;
    else e.inicio_cobro = g.inicio_cobro || null;
    return e;
}

function eventoOrden(o, lineasPorOt) {
    const gasto = calcularGasto(lineasPorOt.get(Number(o.id)) || []);
    return {
        ...base('orden_trabajo', o, o.fecha_creacion),
        estado: o.estado,
        motivo: o.motivo || null,
        tipo_servicio: o.tipo_servicio || null,
        costo_repuestos: gasto.total,
        lineas_sin_precio: gasto.lineas_sin_precio,
        es_mantencion: o.tipo_servicio === 'preventivo',
    };
}

function eventoFactura(f) {
    const monto = num(f.monto);
    const traslado = num(f.monto_traslado);
    return {
        ...base('factura', f, f.fecha_evento),
        folio: f.folio,
        monto,
        monto_traslado: traslado,
        monto_neto: num(f.monto_neto),
        anulada_nc: f.anulada_nc || null,
        // misma regla que la rentabilidad: neto menos traslado si hay neto (038), 0 si se anulo con nota de credito
        ingreso: monto === null ? null : ingresoFactura(f),
        periodo_desde: f.periodo_desde || null,
        periodo_hasta: f.periodo_hasta || null,
        orden_trabajo_id: idOCero(f.orden_trabajo_id),
    };
}

/**
 * Lecturas con las horas desde la anterior. `previas` son las lecturas mas antiguas ya ordenadas;
 * si el valor baja (horometro reemplazado o dato mal puesto) no se inventa un negativo: va null.
 */
function eventosLectura(lecturas) {
    const asc = [...lecturas].sort((a, b) => new Date(a.fecha) - new Date(b.fecha) || Number(a.id) - Number(b.id));
    return asc.map((l, i) => {
        const valor = num(l.valor);
        const anterior = i > 0 ? num(asc[i - 1].valor) : null;
        const horas = valor !== null && anterior !== null && valor - anterior >= 0 ? Math.round((valor - anterior) * 10) / 10 : null;
        return {
            ...base('lectura_horometro', l, l.fecha),
            valor,
            origen: l.origen,
            horas_desde_anterior: horas,
            es_mantencion: l.observacion === OBSERVACION_MANTENCION_PANEL,
        };
    });
}

/** Mas reciente primero; a igual fecha, por tipo e id para que el orden sea estable. */
function comparar(a, b) {
    const d = new Date(b.fecha).getTime() - new Date(a.fecha).getTime();
    if (d !== 0) return d;
    if (a.tipo !== b.tipo) return a.tipo < b.tipo ? 1 : -1;
    return b.id - a.id;
}

/**
 * Arma la linea de tiempo.
 *
 * @param {{guias?: Array, ordenes?: Array, facturas?: Array, lecturas?: Array, lineas?: Array}} filas
 *   filas crudas de cada fuente; `lineas` son las salidas de insumo (orden_trabajo_id, cantidad,
 *   precio_unitario) no anuladas de esas ordenes.
 * @param {{tope?: number}} [opciones]
 * @returns {{tramos: Array, total_eventos: number, hay_mas: boolean, tope: number}}
 *   `tramos`: eventos consecutivos del mismo cliente (el mas reciente primero). Los eventos sin
 *   cliente forman su propio tramo con cliente_id null.
 */
function armarLineaTiempo(filas = {}, { tope = TOPE_EVENTOS } = {}) {
    const lineasPorOt = new Map();
    for (const l of filas.lineas || []) {
        const k = Number(l.orden_trabajo_id);
        if (!lineasPorOt.has(k)) lineasPorOt.set(k, []);
        lineasPorOt.get(k).push(l);
    }
    const todos = [
        ...(filas.guias || []).map(eventoGuia),
        ...(filas.ordenes || []).map((o) => eventoOrden(o, lineasPorOt)),
        ...(filas.facturas || []).map(eventoFactura),
        ...eventosLectura(filas.lecturas || []),
    ].filter((e) => e.fecha !== null);
    todos.sort(comparar);

    const hayMas = todos.length > tope;
    const eventos = hayMas ? todos.slice(0, tope) : todos;

    const tramos = [];
    for (const e of eventos) {
        const ultimo = tramos[tramos.length - 1];
        if (ultimo && ultimo.cliente_id === e.cliente_id) {
            ultimo.eventos.push(e);
            ultimo.desde = e.fecha; // vienen de mas nuevo a mas antiguo
        } else {
            tramos.push({
                cliente_id: e.cliente_id === null ? SIN_CLIENTE : e.cliente_id,
                cliente_nombre: e.cliente_nombre,
                hasta: e.fecha,
                desde: e.fecha,
                eventos: [e],
            });
        }
    }
    // el nombre del tramo es el que tenga algun evento (un cliente borrado del catalogo no tiene)
    for (const t of tramos) {
        if (!t.cliente_nombre) t.cliente_nombre = (t.eventos.find((e) => e.cliente_nombre) || {}).cliente_nombre || null;
    }
    return { tramos, total_eventos: eventos.length, hay_mas: hayMas, tope };
}

/**
 * Lee las fuentes de un equipo y arma la linea de tiempo. Cada fuente pide a lo mas `tope + 1` filas,
 * las mas recientes, para poder avisar `hay_mas` sin traer toda la vida del equipo.
 */
async function leerLineaTiempo(pool, equipoId, { tope = TOPE_EVENTOS } = {}) {
    const limite = tope + 1;
    const [guias, ordenes, facturas, lecturas] = await Promise.all([
        pool.query(
            `SELECT g.id, g.tipo::text AS tipo, g.fecha, g.cliente_id, c.nombre AS cliente_nombre,
                    g.fallido, (g.archivo_url IS NULL) AS sin_documento,
                    to_char(g.inicio_cobro, 'YYYY-MM-DD') AS inicio_cobro, to_char(g.fin_cobro, 'YYYY-MM-DD') AS fin_cobro
             FROM guias g
             LEFT JOIN clientes c ON c.id = g.cliente_id
             WHERE g.maquinaria_id = $1
             ORDER BY g.fecha DESC, g.id DESC
             LIMIT $2`,
            [equipoId, limite]
        ),
        pool.query(
            `SELECT ot.id, ot.fecha_creacion, ot.cliente_id, c.nombre AS cliente_nombre,
                    ot.estado::text AS estado, ot.motivo, ot.tipo_servicio::text AS tipo_servicio
             FROM ordenes_trabajo ot
             LEFT JOIN clientes c ON c.id = ot.cliente_id
             WHERE ot.maquinaria_id = $1
             ORDER BY ot.fecha_creacion DESC, ot.id DESC
             LIMIT $2`,
            [equipoId, limite]
        ),
        pool.query(
            `SELECT f.id, f.folio, f.monto, f.monto_traslado, f.monto_neto, f.anulada_nc, f.orden_trabajo_id,
                    COALESCE(f.fecha_emision::timestamp AT TIME ZONE 'America/Santiago', f.created_at) AS fecha_evento,
                    to_char(f.periodo_desde, 'YYYY-MM-DD') AS periodo_desde, to_char(f.periodo_hasta, 'YYYY-MM-DD') AS periodo_hasta,
                    COALESCE(f.cliente_id, ot.cliente_id) AS cliente_id, c.nombre AS cliente_nombre
             FROM facturas f
             LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
             LEFT JOIN clientes c ON c.id = COALESCE(f.cliente_id, ot.cliente_id)
             WHERE COALESCE(f.maquinaria_id, ot.maquinaria_id) = $1
             ORDER BY fecha_evento DESC, f.id DESC
             LIMIT $2`,
            [equipoId, limite]
        ),
        pool.query(
            `SELECT l.id, l.valor, l.origen::text AS origen, l.observacion, l.fecha,
                    l.cliente_id, c.nombre AS cliente_nombre
             FROM lecturas_horometro l
             LEFT JOIN clientes c ON c.id = l.cliente_id
             WHERE l.maquinaria_id = $1
             ORDER BY l.fecha DESC, l.id DESC
             LIMIT $2`,
            [equipoId, limite]
        ),
    ]);

    // costo de repuestos de las ordenes que entraron (misma regla que el gasto del equipo: salidas no anuladas)
    const idsOt = ordenes.rows.map((o) => o.id);
    const lineas = idsOt.length
        ? (await pool.query(
            `SELECT orden_trabajo_id, cantidad, precio_unitario
             FROM movimientos_insumo
             WHERE tipo = 'salida' AND anulada_at IS NULL AND orden_trabajo_id = ANY($1)`,
            [idsOt]
        )).rows
        : [];

    return armarLineaTiempo(
        { guias: guias.rows, ordenes: ordenes.rows, facturas: facturas.rows, lecturas: lecturas.rows, lineas },
        { tope }
    );
}

module.exports = { armarLineaTiempo, leerLineaTiempo, TOPE_EVENTOS, OBSERVACION_MANTENCION_PANEL };
