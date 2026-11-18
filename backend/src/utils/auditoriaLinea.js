const { MAX_MONTO_PESOS } = require('./validacion');
// Reglas de los cambios a las lineas de repuesto de una OT.
//
// Una linea es lo que se cobra: agregarla, anularla o corregir su facturable, cantidad o precio
// cambia lo que el cliente paga. Por eso los tres caminos de routes/insumos.js pasan por las mismas
// reglas, que viven aca como funciones puras (se prueban sin base, test/auditoriaLinea.test.js):
//
//   - con la OT cerrada (finalizada) el cambio exige un motivo: un codigo de la lista mas un texto;
//     con la OT abierta el motivo es opcional, pero el cambio se registra igual en el historial
//   - con la OT ya facturada el cambio se bloquea: lo ya facturado solo se deja de cobrar con una
//     nota de credito en el SII
//   - si la OT ya estaba valorizada y el cambio altera lo que se cobra, la valorizacion se anula
//     para que el gerente la vuelva a aprobar sobre las lineas nuevas

const { calcularTotalFacturable } = require('./facturableOt');

// Lista cerrada de motivos. El panel muestra la etiqueta; el servidor guarda el codigo.
const MOTIVOS_CAMBIO = ['cliente_antiguo', 'garantia', 'error_registro', 'cortesia_comercial', 'otro'];
const ETIQUETAS_MOTIVO = {
    cliente_antiguo: 'Cliente antiguo',
    garantia: 'Garantía',
    error_registro: 'Error de registro',
    cortesia_comercial: 'Cortesía comercial',
    otro: 'Otro',
};

// caracteres que debe tener el texto del motivo, sin contar espacios
const MIN_CARACTERES_MOTIVO = 10;
const MAX_CARACTERES_MOTIVO = 500;

const ESTADO_CERRADA = 'finalizada';

const sinEspacios = (texto) => texto.replace(/\s/g, '');

const esVacio = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Mensaje del bloqueo por factura; lo usan las rutas de linea y el panel lo muestra tal cual. */
function mensajeOrdenFacturada(folio) {
    return `Esta orden ya tiene la factura folio ${folio}. Para dejar de cobrar algo ya facturado, emite una nota de crédito en el SII.`;
}

/**
 * Valida el motivo de un cambio. `ordenCerrada` decide si es obligatorio.
 *
 * Cerrada: codigo de la lista y texto de al menos 10 caracteres sin contar espacios (incluso con
 * "otro": el codigo solo clasifica, la explicacion siempre va en el texto).
 * Abierta: ambos son opcionales; si vienen, el codigo tiene que ser de la lista y el texto no puede
 * pasar del maximo, pero el texto no tiene largo minimo (un mecanico no lo manda).
 *
 * Devuelve { valido: true, motivoCodigo, motivo } con los valores limpios (null si no vinieron), o
 * { valido: false, error } con el mensaje para el usuario.
 */
function validarMotivo({ ordenCerrada, motivoCodigo, motivo }) {
    const codigoVacio = esVacio(motivoCodigo);
    const textoVacio = esVacio(motivo);

    if (!codigoVacio && (typeof motivoCodigo !== 'string' || !MOTIVOS_CAMBIO.includes(motivoCodigo.trim()))) {
        return { valido: false, error: `motivo_codigo debe ser uno de: ${MOTIVOS_CAMBIO.join(', ')}` };
    }
    if (!textoVacio && typeof motivo !== 'string') {
        return { valido: false, error: 'El motivo debe ser un texto' };
    }
    const texto = textoVacio ? null : motivo.trim();
    const codigo = codigoVacio ? null : motivoCodigo.trim();

    if (texto !== null && texto.length > MAX_CARACTERES_MOTIVO) {
        return { valido: false, error: `El motivo no puede pasar de ${MAX_CARACTERES_MOTIVO} caracteres` };
    }
    if (ordenCerrada) {
        if (codigo === null) {
            return { valido: false, error: 'La orden está cerrada: indica el motivo del cambio (motivo_codigo)' };
        }
        if (texto === null || sinEspacios(texto).length < MIN_CARACTERES_MOTIVO) {
            return {
                valido: false,
                error: `La orden está cerrada: explica el motivo con al menos ${MIN_CARACTERES_MOTIVO} caracteres`,
            };
        }
    }
    return { valido: true, motivoCodigo: codigo, motivo: texto };
}

/**
 * Compuertas de un cambio de linea, en orden: primero la factura (409) y despues el motivo (400),
 * porque con una OT facturada pedir el motivo no tiene sentido: el cambio no se puede hacer.
 *
 *   estado        estado de la OT, leido con la fila bloqueada
 *   facturaFolio  folio de la factura de la OT, o null si no tiene
 *
 * Devuelve { ok: true, ordenCerrada, motivoCodigo, motivo } o { ok: false, status, error }.
 */
function evaluarCompuertas({ estado, facturaFolio = null, motivoCodigo, motivo }) {
    if (facturaFolio !== null && facturaFolio !== undefined) {
        return { ok: false, status: 409, error: mensajeOrdenFacturada(facturaFolio) };
    }
    const ordenCerrada = estado === ESTADO_CERRADA;
    const validacion = validarMotivo({ ordenCerrada, motivoCodigo, motivo });
    if (!validacion.valido) return { ok: false, status: 400, error: validacion.error };
    return { ok: true, ordenCerrada, motivoCodigo: validacion.motivoCodigo, motivo: validacion.motivo };
}

/**
 * El precio de una linea va en pesos chilenos enteros, mayor o igual a 0. Vacio o ausente es valido
 * (la linea queda sin precio hasta que el gerente la valoriza). Devuelve el mensaje de error o null.
 */
function validarPrecioUnitario(valor) {
    if (valor === undefined || valor === null || valor === '') return null;
    const n = typeof valor === 'string' ? (valor.trim() === '' ? NaN : Number(valor)) : valor;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > MAX_MONTO_PESOS) {
        return 'precio_unitario debe ser un monto entero en pesos, mayor o igual a 0 y de hasta 10 dígitos';
    }
    return null;
}

/**
 * Monto en pesos chilenos: entero, sin signo, sin notacion exponencial. Devuelve el entero, o null si
 * no es valido. Acepta un entero JSON o un texto de solo digitos.
 */
function montoEnteroONulo(valor) {
    const texto = typeof valor === 'number' ? (Number.isSafeInteger(valor) ? String(valor) : '') : String(valor ?? '').trim();
    if (!/^\d{1,10}$/.test(texto)) return null;
    return Number(texto);
}

/**
 * Cantidad de una linea de repuesto o de un ingreso: mayor que 0, hasta 2 decimales (litros, metros;
 * las columnas son NUMERIC(12,2)), sin notacion exponencial. Devuelve el numero o null.
 */
function cantidadValidaONulo(valor) {
    const texto = typeof valor === 'number' ? (Number.isFinite(valor) ? String(valor) : '') : String(valor ?? '').trim();
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(texto)) return null;
    const n = Number(texto);
    return n > 0 ? n : null;
}

/**
 * Detalle del evento 'factura_anulada': el rastro completo de lo que se borro de `facturas`.
 */
function detalleFacturaAnulada(factura, { motivoCodigo, motivo }) {
    return {
        factura_id: factura.id,
        folio: factura.folio,
        monto: factura.monto === null || factura.monto === undefined ? null : Number(factura.monto),
        // la fecha llega como texto (fecha_emision_texto, leida con ::text en SQL): un DATE convertido a
        // Date de JavaScript depende de la zona horaria del servidor y puede correrse un dia
        fecha_emision: factura.fecha_emision_texto || null,
        archivo_url: factura.archivo_url,
        motivo_codigo: motivoCodigo,
        motivo,
    };
}

/** Id de una fila (INTEGER de Postgres): entero positivo escrito solo con digitos. */
function esIdPositivo(valor) {
    return typeof valor === 'string' && /^[1-9]\d*$/.test(valor) && Number(valor) <= 2147483647;
}

/** Numero o null: la cantidad y el precio llegan como texto desde Postgres (NUMERIC) o JSON. */
function aNumero(valor) {
    if (valor === undefined || valor === null || valor === '') return null;
    const n = Number(valor);
    return Number.isNaN(n) ? NaN : n;
}

function igualesNumero(a, b) {
    const x = aNumero(a);
    const y = aNumero(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    return x === y;
}

const CAMPOS_NUMERICOS = ['cantidad', 'precio_unitario'];
const CAMPOS_TEXTO = ['facturable', 'descripcion'];

/**
 * Los campos que de verdad cambian entre la linea anterior y lo pedido. `pedido` trae solo lo que
 * el usuario mando: un campo ausente (undefined) o un precio vacio/nulo significa "no tocar" (asi
 * lo hace el UPDATE con COALESCE). Devuelve { campo: { antes, despues } }; objeto vacio si nada
 * cambia, y entonces no se escribe nada (ni la linea ni el evento).
 *
 * Cantidad y precio se comparan como numeros ("2.00" de Postgres es igual a 2). Un valor que no es
 * numero cuenta como cambio, para que lo rechace la base y no se cuele como "sin cambios".
 */
function difLinea(anterior, pedido) {
    const cambios = {};
    const previa = anterior || {};
    const nueva = pedido || {};
    for (const campo of CAMPOS_NUMERICOS) {
        if (esVacio(nueva[campo])) continue;
        if (!igualesNumero(previa[campo], nueva[campo])) {
            const antes = aNumero(previa[campo]);
            const despues = aNumero(nueva[campo]);
            cambios[campo] = { antes, despues: Number.isNaN(despues) ? nueva[campo] : despues };
            if (Number.isNaN(antes)) cambios[campo].antes = previa[campo];
        }
    }
    for (const campo of CAMPOS_TEXTO) {
        if (nueva[campo] === undefined || nueva[campo] === null) continue;
        const antes = previa[campo] === undefined ? null : previa[campo];
        if (antes !== nueva[campo]) cambios[campo] = { antes, despues: nueva[campo] };
    }
    return cambios;
}

/** Lineas que cuentan para cobrar: marcadas 'si' y no anuladas. */
function lineasFacturables(lineas) {
    if (!Array.isArray(lineas)) return [];
    return lineas.filter((l) => l && l.facturable === 'si' && !l.anulada_at);
}

/**
 * Si el cambio altera lo que se cobra: cambia el conjunto de lineas facturables (se suma, se saca o
 * se anula una), o la cantidad o el precio de una que ya lo era, o el total. Mover una linea entre
 * 'no' y 'pendiente', agregar una no facturable o cambiar su cantidad o precio no cuenta.
 *
 * `antes` y `despues` son las lineas de la OT (id, facturable, cantidad, precio_unitario) antes y
 * despues del cambio; las anuladas no cuentan.
 */
function cambiaLoFacturable(antes, despues) {
    const a = lineasFacturables(antes);
    const d = lineasFacturables(despues);
    if (a.length !== d.length) return true;
    if (calcularTotalFacturable(a) !== calcularTotalFacturable(d)) return true;
    const porId = new Map(a.map((l) => [String(l.id), l]));
    for (const linea of d) {
        const previa = porId.get(String(linea.id));
        if (!previa) return true;
        if (!igualesNumero(previa.cantidad, linea.cantidad)) return true;
        if (!igualesNumero(previa.precio_unitario, linea.precio_unitario)) return true;
    }
    return false;
}

/**
 * La valorizacion se anula solo si la OT esta valorizada y el cambio altera lo facturable. Con
 * factura no se llega aca: el cambio ya se bloqueo antes.
 */
function debeAnularValorizacion({ valorizacion, antes, despues }) {
    if (valorizacion === null || valorizacion === undefined) return false;
    return cambiaLoFacturable(antes, despues);
}

module.exports = {
    MOTIVOS_CAMBIO, ETIQUETAS_MOTIVO, MIN_CARACTERES_MOTIVO, MAX_CARACTERES_MOTIVO,
    mensajeOrdenFacturada, validarPrecioUnitario, esIdPositivo, montoEnteroONulo, cantidadValidaONulo, detalleFacturaAnulada, validarMotivo, evaluarCompuertas, difLinea, cambiaLoFacturable,
    debeAnularValorizacion,
};
