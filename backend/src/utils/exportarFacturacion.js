// Exportacion de la facturacion a Excel con el formato de la hoja CLIENTES de la planilla de cobranza.
//
// `armarHoja` es pura: de las filas de la consulta a la matriz que escribe utils/xlsx.js. `cargarFilasExportacion`
// hace la consulta (mismas uniones y mismo "dia de referencia" que la lista de emitidas). Todo son VALORES, no
// formulas. Devol / Adicional, Comision y Pagada comision quedan vacias: no estan en el sistema y se llenan a mano.

const { FILTROS_ESTADO, SQL_HOY, estadoCobranza, diasMora } = require('./cobranza');
const { SQL_CLIENTE, SQL_FECHA_REF, DESDE_JOIN } = require('./facturasEmitidas');

const NOMBRE_HOJA = 'CLIENTES';
const TITULO = 'CLIENTES MENSUALES';
const FILA_ENCABEZADOS = 4; // los datos empiezan en la siguiente
const MAX_FILAS = 5000;
const IVA = 1.19;

// Texto exacto de la fila 4 de la hoja CLIENTES de la planilla original (copiado con openpyxl).
const ENCABEZADOS = [
    'Rut', 'Razon Social', 'CONTACTO', 'Dirección', 'Giro', 'e-mail', 'CATEGORIA', 'Equipo', 'Modelo', 'Marca',
    'N° Interno', 'Periodo Arriendo', '$ Neto equipo', 'Traslado Entrega', 'Traslado Retiro', 'Devol / Adicional',
    'Factura N°', 'Total $', 'Comision', 'Pagada comision', 'MES ARRIENDO', 'Emision', 'Vcto', 'Pago', 'DIAS MORA',
];

const CATEGORIAS = {
    grua_horquilla: 'GRUA HORQUILLA',
    alzahombre: 'PLATAFORMA',
    transpaleta: 'TRANSPALETA',
    apilador: 'APILADOR',
};

const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const texto = (v) => (v === null || v === undefined ? null : String(v));
const fecha = (dia) => (dia ? { fecha: dia } : null);
const esDia = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** 'AAAA-MM-DD' -> { d, m, a } */
function partes(dia) {
    return { d: dia.slice(8, 10), m: Number(dia.slice(5, 7)) - 1, a: dia.slice(0, 4) };
}

/**
 * Periodo como lo escribe la planilla: `01 AL 31 DIC 2025`; si cruza de mes, `12 ENE AL 11 FEB 2025`; si cruza
 * de año, `12 DIC 2025 AL 11 ENE 2026`. Sin periodo, vacio.
 */
function textoPeriodo(desde, hasta) {
    if (!esDia(desde) || !esDia(hasta)) return null;
    const a = partes(desde);
    const b = partes(hasta);
    if (a.a !== b.a) return `${a.d} ${MESES[a.m]} ${a.a} AL ${b.d} ${MESES[b.m]} ${b.a}`;
    if (a.m !== b.m) return `${a.d} ${MESES[a.m]} AL ${b.d} ${MESES[b.m]} ${b.a}`;
    return `${a.d} AL ${b.d} ${MESES[b.m]} ${b.a}`;
}

/** Folio como en la planilla: `F/123` si es solo digitos; si no, tal cual. */
function textoFolio(folio) {
    const f = texto(folio);
    if (f === null) return null;
    return /^\d+$/.test(f) ? `F/${f}` : f;
}

/** Numero del codigo interno (los digitos finales: `PL-1232` -> 1232); null si no hay. */
function numeroInterno(codigo) {
    const m = /(\d+)\s*$/.exec(texto(codigo) || '');
    return m ? Number(m[1]) : null;
}

/** Equipo de la fila: `ARRIENDO <TIPO>` o `REPARACION OT <id>`. */
function textoEquipo(f) {
    if (f.orden_trabajo_id !== null && f.orden_trabajo_id !== undefined) return `REPARACION OT ${f.orden_trabajo_id}`;
    const tipo = texto(f.tipo_equipo);
    return tipo ? `ARRIENDO ${tipo.toUpperCase()}` : 'ARRIENDO';
}

/**
 * Neto, neto del equipo y traslados de una fila. Sin monto_neto, el neto es round(monto / 1,19) y `estimado` es
 * true (hay facturas exentas, donde esa cuenta no vale). Los traslados: con division, cada parte a su
 * columna; con total sin division, todo a Traslado Entrega.
 */
function montosFila(f) {
    const monto = num(f.monto);
    const traslado = num(f.monto_traslado) ?? 0;
    const netoGuardado = num(f.monto_neto);
    let neto = netoGuardado;
    let estimado = false;
    if (neto === null && monto !== null) {
        neto = Math.round(monto / IVA);
        estimado = true;
    }
    const entrega = num(f.traslado_entrega);
    const retiro = num(f.traslado_retiro);
    let tEntrega = null;
    let tRetiro = null;
    if (entrega !== null && retiro !== null) {
        tEntrega = entrega || null;
        tRetiro = retiro || null;
    } else if (traslado > 0) {
        tEntrega = traslado;
    }
    return { monto, neto, estimado, netoEquipo: neto === null ? null : neto - traslado, tEntrega, tRetiro };
}

/** Texto de la columna Pago: fecha de pago, "Anulada NC/<folio>", "vencido" o "proximo a vencer" (la regla de cobranza.js). */
function celdaPago(estado, f) {
    if (estado === 'anulada') return `Anulada NC/${String(f.anulada_nc).trim()}`;
    if (estado === 'pagada') return fecha(f.fecha_pago);
    if (estado === 'vencida') return 'vencido';
    if (estado === 'proxima') return 'proximo a vencer';
    return null;
}

/** Una fila de la consulta -> las 25 celdas de la hoja y si el neto fue estimado. */
function armarFila(f, hoy) {
    const m = montosFila(f);
    const cobranza = { fecha_vencimiento: f.fecha_vencimiento, fecha_pago: f.fecha_pago, anulada_nc: f.anulada_nc };
    const estado = estadoCobranza(cobranza, hoy);
    const refMes = [f.periodo_desde, f.fecha_emision, f.fecha_ref].find(esDia);
    const celdas = [
        texto(f.cliente_rut), // Rut
        texto(f.cliente_nombre), // Razon Social
        texto(f.ejecutivo_nombre), // CONTACTO: el vendedor
        texto(f.cliente_direccion), // Direccion
        texto(f.cliente_giro), // Giro
        texto(f.cliente_email), // e-mail
        CATEGORIAS[f.categoria_equipo] || null, // CATEGORIA
        textoEquipo(f), // Equipo
        texto(f.modelo), // Modelo
        texto(f.marca), // Marca
        numeroInterno(f.maquinaria_codigo), // N° Interno
        textoPeriodo(f.periodo_desde, f.periodo_hasta), // Periodo Arriendo
        m.netoEquipo, // $ Neto equipo
        m.tEntrega, // Traslado Entrega
        m.tRetiro, // Traslado Retiro
        null, // Devol / Adicional
        textoFolio(f.folio), // Factura N°
        m.monto, // Total $
        null, // Comision
        null, // Pagada comision
        refMes ? fecha(`${refMes.slice(0, 7)}-01`) : null, // MES ARRIENDO
        esDia(f.fecha_emision) ? fecha(f.fecha_emision) : null, // Emision
        esDia(f.fecha_vencimiento) ? fecha(f.fecha_vencimiento) : null, // Vcto
        celdaPago(estado, f), // Pago
        estado === 'vencida' ? diasMora(cobranza, hoy) : null, // DIAS MORA
    ];
    return { celdas, estimado: m.estimado };
}

/**
 * Matriz de la hoja y resumen.
 * @param {Array} filas filas de cargarFilasExportacion
 * @param {{ hoy: string, generado?: string }} opciones `hoy` = 'AAAA-MM-DD' en Santiago; `generado` = fecha de Y1 e Y3
 * @returns {{ matriz: Array<Array>, filas: number, sin_neto: number }}
 */
function armarHoja(filas, { hoy, generado = hoy } = {}) {
    const matriz = [];
    matriz[0] = [];
    matriz[0][24] = fecha(generado); // Y1
    matriz[1] = [TITULO]; // A2
    matriz[2] = [];
    matriz[2][24] = fecha(generado); // Y3
    matriz[FILA_ENCABEZADOS - 1] = [...ENCABEZADOS];
    let sinNeto = 0;
    for (const f of filas) {
        const { celdas, estimado } = armarFila(f, hoy);
        if (estimado) sinNeto += 1;
        matriz.push(celdas);
    }
    return { matriz, filas: filas.length, sin_neto: sinNeto };
}

/**
 * Lee las facturas a exportar: todas las del sistema (una fila por factura), con filtros opcionales de fecha
 * (sobre la emision, o el dia de carga si no la tiene) y de cliente. Pide una fila de mas que el tope para
 * poder avisar que se pasa.
 * @returns {Promise<{ items: Array, hoy: string }>}
 */
async function cargarFilasExportacion(db, { desde = null, hasta = null, clienteId = null } = {}) {
    const r = await db.query(
        `SELECT f.id, f.folio, f.orden_trabajo_id,
                c.rut AS cliente_rut, c.nombre AS cliente_nombre, c.direccion AS cliente_direccion,
                c.giro AS cliente_giro, c.email AS cliente_email, e.nombre AS ejecutivo_nombre,
                m.categoria_equipo, m.tipo AS tipo_equipo, m.modelo, m.marca, m.codigo AS maquinaria_codigo,
                to_char(f.periodo_desde, 'YYYY-MM-DD') AS periodo_desde, to_char(f.periodo_hasta, 'YYYY-MM-DD') AS periodo_hasta,
                f.monto, f.monto_neto, f.monto_traslado, f.traslado_entrega, f.traslado_retiro,
                to_char(f.fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
                to_char(${SQL_FECHA_REF}, 'YYYY-MM-DD') AS fecha_ref,
                to_char(f.fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento,
                to_char(f.fecha_pago, 'YYYY-MM-DD') AS fecha_pago,
                f.anulada_nc,
                to_char(${SQL_HOY}, 'YYYY-MM-DD') AS hoy
         ${DESDE_JOIN}
         WHERE ${FILTROS_ESTADO.todas}
           AND ($1::int IS NULL OR ${SQL_CLIENTE} = $1::int)
           AND ($2::date IS NULL OR ${SQL_FECHA_REF} >= $2::date)
           AND ($3::date IS NULL OR ${SQL_FECHA_REF} <= $3::date)
         ORDER BY ${SQL_FECHA_REF} ASC, f.id ASC
         LIMIT ${MAX_FILAS + 1}`,
        [clienteId, desde, hasta]
    );
    const hoy = r.rows.length ? r.rows[0].hoy : null;
    return { items: r.rows, hoy };
}

module.exports = {
    NOMBRE_HOJA, TITULO, ENCABEZADOS, FILA_ENCABEZADOS, MAX_FILAS,
    armarHoja, armarFila, cargarFilasExportacion, textoPeriodo, textoFolio, numeroInterno, montosFila,
};
