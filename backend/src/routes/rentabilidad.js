const express = require('express');
require('../utils/asyncErrores');
const pool = require('../config/db');
const { verifyToken, requireRole } = require('../middleware/auth');
const { leerConfiguracion } = require('../utils/configuracion');
const { diaSantiago } = require('../utils/diasArriendo');
const {
    calcularRentabilidad,
    calcularDiasArrendado,
    calcularHorasEnPeriodo,
    clasificarResultado,
    resumirFlota,
    diasDelPeriodo,
    compararPorRelevancia,
} = require('../utils/rentabilidad');
const { fechaDeQuery, validarIdsEnRuta } = require('../utils/validacion');
const { parsearPaginacion, parsearBusqueda, envolver } = require('../utils/paginacion');

const router = express.Router();
validarIdsEnRuta(router, ['id']);

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Por defecto los ultimos 12 meses, que es el horizonte con que se evalua un arriendo. */
function rangoDeFechas(query) {
    // desde/hasta mal formados (texto que no es fecha, arreglo, objeto) no llegan al calculo:
    // la ruta responde 400. Antes, Intl lanzaba un RangeError que tumbaba el proceso.
    const hastaLeida = fechaDeQuery(query.hasta);
    const desdeLeida = fechaDeQuery(query.desde);
    if (hastaLeida === undefined || desdeLeida === undefined) return { error: 'desde y hasta deben ser fechas válidas (AAAA-MM-DD)' };
    const hasta = hastaLeida || new Date();
    let desde;
    if (desdeLeida) {
        desde = desdeLeida;
    } else {
        desde = new Date(hasta);
        desde.setFullYear(desde.getFullYear() - 1);
    }
    // dias de calendario del periodo para contar dias de arriendo: si llegan como 'YYYY-MM-DD' se usan tal
    // cual (un Date a medianoche UTC caeria el dia anterior en Santiago); si no, el dia de Santiago
    const esDia = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    return {
        desde, hasta,
        desdeDia: esDia(query.desde) ? query.desde : diaSantiago(desde),
        hastaDia: esDia(query.hasta) ? query.hasta : diaSantiago(hasta),
    };
}

// Gasto en repuestos por equipo. Cuenta TODAS las lineas, cobradas o no: es el costo real
// para GOMAQ, no lo facturado al cliente (entrevista el jefe de taller, punto 1). Las anuladas no: el
// repuesto volvio al furgon, no se gasto.
const SQL_LINEAS = `
    SELECT ot.maquinaria_id, mi.cantidad, mi.precio_unitario
    FROM movimientos_insumo mi
    JOIN ordenes_trabajo ot ON ot.id = mi.orden_trabajo_id
    WHERE mi.tipo = 'salida' AND mi.anulada_at IS NULL
      AND mi.created_at BETWEEN $1 AND $2
`;

// Ingreso facturado por equipo, por sus dos caminos: factura de arriendo (facturas.maquinaria_id,
// migracion 008) y factura de reparacion (a traves de la orden de trabajo).
const SQL_FACTURAS = `
    SELECT COALESCE(f.maquinaria_id, ot.maquinaria_id) AS maquinaria_id, f.monto, f.monto_traslado
    FROM facturas f
    LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
    WHERE COALESCE(f.maquinaria_id, ot.maquinaria_id) IS NOT NULL
      AND f.created_at BETWEEN $1 AND $2
`;

function agruparPorMaquinaria(filas) {
    const mapa = new Map();
    for (const fila of filas) {
        const id = fila.maquinaria_id;
        if (!mapa.has(id)) mapa.set(id, []);
        mapa.get(id).push(fila);
    }
    return mapa;
}

// Guias de despacho y recepcion hasta el fin del periodo: hacen falta tambien las anteriores al
// inicio, porque un arriendo que empezo antes sigue contando sus dias dentro del periodo.
const SQL_GUIAS = `
    SELECT maquinaria_id, tipo, fecha, fallido,
           to_char(inicio_cobro, 'YYYY-MM-DD') AS inicio_cobro, to_char(fin_cobro, 'YYYY-MM-DD') AS fin_cobro
    FROM guias
    WHERE fecha <= $1
    ORDER BY maquinaria_id, fecha
`;

// Lecturas de horometro hasta el fin del periodo: la base de las horas de uso puede ser una
// lectura anterior al inicio.
const SQL_LECTURAS = `
    SELECT maquinaria_id, valor, fecha
    FROM lecturas_horometro
    WHERE fecha <= $1
    ORDER BY maquinaria_id, fecha
`;

const RESULTADOS = ['a_perdida', 'con_ganancia', 'equilibrio', 'sin_movimiento'];

// Columnas por las que se puede ordenar la tabla. El valor de la query solo elige entre estas
// claves: nunca se usa como nombre de campo directamente.
const COLUMNAS_ORDEN = {
    gasto: 'gasto',
    ingreso: 'ingreso',
    margen: 'margen',
    ratio: 'gasto_sobre_ingreso',
    hora: 'gasto_por_hora',
    dias: 'dias_arrendado',
};

const collator = new Intl.Collator('es', { numeric: true });

/** Orden pedido por la pantalla. Los vacios van siempre al final, en cualquier sentido. */
function comparadorDeOrden(orden, dir) {
    if (orden === 'codigo') {
        const signo = dir === 'desc' ? -1 : 1;
        return (a, b) => signo * collator.compare(a.codigo, b.codigo);
    }
    if (!Object.prototype.hasOwnProperty.call(COLUMNAS_ORDEN, orden)) return compararPorRelevancia;
    const campo = COLUMNAS_ORDEN[orden];
    const signo = dir === 'desc' ? -1 : 1;
    return (a, b) => {
        const x = a[campo];
        const y = b[campo];
        if (x === null || x === undefined) return y === null || y === undefined ? collator.compare(a.codigo, b.codigo) : 1;
        if (y === null || y === undefined) return -1;
        return signo * (x - y) || collator.compare(a.codigo, b.codigo);
    };
}

// GET /api/rentabilidad - toda la flota, con lo que hay que decidir primero arriba.
// Responde la pregunta de el jefe de taller: "no sabemos si en los tres meses que estuvo la maquina se
// gasto mas plata de la que dejaba el arriendo".
//
// Ademas de gasto y margen, cada equipo trae las medidas con que la industria del arriendo lo
// evalua y que salen de datos que ya existen: que parte del ingreso se va en repuestos, cuanto
// cuesta cada hora de uso (horometro) y cuantos dias estuvo arrendado (guias).
//
// Parametros: desde/hasta, q (busqueda), resultado (a_perdida | con_ganancia | sin_movimiento |
// equilibrio), orden + dir (ver COLUMNAS_ORDEN) y limit/offset.
router.get('/', verifyToken, requireRole('gerente', 'administrativo'), async (req, res) => {
    const rango = rangoDeFechas(req.query);
    if (rango.error) return res.status(400).json({ error: rango.error });
    const { desde, hasta, desdeDia, hastaDia } = rango;
    const { limit, offset } = parsearPaginacion(req.query);
    const q = parsearBusqueda(req.query);
    const filtroResultado = RESULTADOS.includes(req.query.resultado) ? req.query.resultado : null;
    try {
        const [equipos, lineas, facturas, guias, lecturas] = await Promise.all([
            pool.query('SELECT id, codigo, tipo, marca, modelo, estado FROM maquinarias'),
            pool.query(SQL_LINEAS, [desde, hasta]),
            pool.query(SQL_FACTURAS, [desde, hasta]),
            pool.query(SQL_GUIAS, [hasta]),
            pool.query(SQL_LECTURAS, [hasta]),
        ]);

        const lineasPorEquipo = agruparPorMaquinaria(lineas.rows);
        const facturasPorEquipo = agruparPorMaquinaria(facturas.rows);
        const guiasPorEquipo = agruparPorMaquinaria(guias.rows);
        const lecturasPorEquipo = agruparPorMaquinaria(lecturas.rows);
        const diasPeriodo = diasDelPeriodo(desde, hasta);
        const config = await leerConfiguracion(pool);

        // se calcula sobre TODA la flota y despues se filtra: el resumen de arriba no debe cambiar
        // al buscar un equipo, ni el "3 a perdida" al pulsar "cargar mas"
        const todos = equipos.rows.map((equipo) => {
            const base = calcularRentabilidad({
                lineas: lineasPorEquipo.get(equipo.id) || [],
                facturas: facturasPorEquipo.get(equipo.id) || [],
            });
            const horas = calcularHorasEnPeriodo(lecturasPorEquipo.get(equipo.id) || [], desde, hasta);
            const dias = calcularDiasArrendado(guiasPorEquipo.get(equipo.id) || [], desdeDia, hastaDia, { horaCorte: config.hora_corte_despacho });
            return {
                ...equipo,
                ...base,
                resultado: clasificarResultado(base),
                // sin ingreso el porcentaje no significa nada: null y no una division por cero
                gasto_sobre_ingreso: base.ingreso > 0 ? (base.gasto / base.ingreso) * 100 : null,
                horas_uso: horas,
                gasto_por_hora: horas ? base.gasto / horas : null,
                dias_arrendado: dias,
            };
        });
        const resumen = { ...resumirFlota(todos, { diasPeriodo }), dias_periodo: diasPeriodo };

        const buscado = q ? q.toLowerCase() : null;
        const visibles = todos
            .filter((e) => !filtroResultado || e.resultado === filtroResultado)
            .filter((e) => !buscado || [e.codigo, e.tipo, e.marca, e.modelo].some((t) => t && String(t).toLowerCase().includes(buscado)))
            .sort(comparadorDeOrden(req.query.orden, req.query.dir));

        // el resultado se calcula en memoria (cruza lineas, facturas, guias y lecturas), asi que
        // la pagina se recorta despues de ordenar: paginar en SQL daria otro orden
        const pagina = limit === null ? visibles : visibles.slice(offset, offset + limit);

        res.json({
            desde: desde.toISOString(),
            hasta: hasta.toISOString(),
            resumen,
            ...envolver(pagina, visibles.length, { limit, offset }),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al calcular la rentabilidad de la flota' });
    }
});

// GET /api/rentabilidad/maquinaria/:id - detalle de un equipo, con el desglose que lo respalda
router.get('/maquinaria/:id', verifyToken, requireRole('gerente', 'administrativo'), async (req, res) => {
    const rango = rangoDeFechas(req.query);
    if (rango.error) return res.status(400).json({ error: rango.error });
    const { desde, hasta } = rango;
    const { id } = req.params;
    try {
        const equipo = await pool.query('SELECT id, codigo, tipo, estado FROM maquinarias WHERE id = $1', [id]);
        if (equipo.rows.length === 0) {
            return res.status(404).json({ error: 'Maquinaria no encontrada' });
        }

        const [lineas, facturas] = await Promise.all([
            pool.query(
                `SELECT mi.id, mi.cantidad, mi.precio_unitario, mi.descripcion, mi.facturable,
                        mi.created_at, mi.orden_trabajo_id, i.nombre AS insumo_nombre
                 FROM movimientos_insumo mi
                 JOIN ordenes_trabajo ot ON ot.id = mi.orden_trabajo_id
                 LEFT JOIN insumos i ON i.id = mi.insumo_id
                 WHERE mi.tipo = 'salida' AND mi.anulada_at IS NULL AND ot.maquinaria_id = $1
                   AND mi.created_at BETWEEN $2 AND $3
                 ORDER BY mi.created_at DESC`,
                [id, desde, hasta]
            ),
            pool.query(
                `SELECT f.id, f.folio, f.monto, f.monto_traslado, f.created_at, f.orden_trabajo_id
                 FROM facturas f
                 LEFT JOIN ordenes_trabajo ot ON ot.id = f.orden_trabajo_id
                 WHERE COALESCE(f.maquinaria_id, ot.maquinaria_id) = $1
                   AND f.created_at BETWEEN $2 AND $3
                 ORDER BY f.created_at DESC`,
                [id, desde, hasta]
            ),
        ]);

        res.json({
            maquinaria: equipo.rows[0],
            desde: desde.toISOString(),
            hasta: hasta.toISOString(),
            ...calcularRentabilidad({ lineas: lineas.rows, facturas: facturas.rows }),
            lineas: lineas.rows.map((l) => ({
                ...l,
                cantidad: num(l.cantidad),
                precio_unitario: num(l.precio_unitario),
            })),
            facturas: facturas.rows.map((f) => ({ ...f, monto: num(f.monto), monto_traslado: num(f.monto_traslado) })),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al calcular la rentabilidad del equipo' });
    }
});

module.exports = router;
