// Heuristicas para prellenar los formularios de Guias y Facturacion a partir del texto
// que se logra extraer de un PDF (ver leerTextoPdf). Son funciones puras sobre texto:
// no tocan la BD ni HTTP, para poder probarlas contra documentos reales (ver test/).
//
// Mejor esfuerzo por diseno: cuando algo no se reconoce se devuelve null y el
// administrativo llena ese campo a mano. Nunca se inventa un valor.

const { dividirTraslado } = require('./trasladoFactura');

const MESES = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
    noviembre: 11, diciembre: 12,
};

function sinAcentos(texto) {
    return texto.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// valida que los componentes formen una fecha real (rechaza 31/02, mes 13, etc.)
function aFechaIso(anio, mes, dia) {
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
    const fecha = new Date(Date.UTC(anio, mes - 1, dia));
    if (fecha.getUTCFullYear() !== anio || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) {
        return null;
    }
    return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * Fecha de emision del documento, como 'YYYY-MM-DD'.
 *
 * Se ancla a la etiqueta "Fecha Emision" en vez de tomar la primera fecha del documento:
 * todo DTE lleva impresa la resolucion del SII ("Res. 99 de 2014"), y una busqueda libre
 * se queda con esa. Las guias de GOMAQ escriben el mes en palabras ("15 de Mayo del 2026"),
 * asi que ese es el formato principal y el numerico queda de respaldo.
 */
function parsearFechaEmision(texto) {
    if (!texto) return null;
    const etiqueta = sinAcentos(texto).match(/fecha\s*(?:de\s*)?emision\s*:?\s*([^\n]{0,80})/i);
    if (!etiqueta) return null;
    const segmento = etiqueta[1];

    const textual = segmento.match(/(\d{1,2})\s+de\s+([a-zA-Z]+)\s+del?\s+(\d{4})/);
    if (textual) {
        const mes = MESES[textual[2].toLowerCase()];
        if (mes) {
            const iso = aFechaIso(Number(textual[3]), mes, Number(textual[1]));
            if (iso) return iso;
        }
    }

    const numerico = segmento.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (numerico) {
        const anioCrudo = numerico[3];
        const anio = anioCrudo.length === 2 ? Number(`20${anioCrudo}`) : Number(anioCrudo);
        return aFechaIso(anio, Number(numerico[2]), Number(numerico[1]));
    }

    return null;
}

/**
 * Hora del documento como 'HH:MM', o null si no hay ninguna valida.
 *
 * Se devuelve aparte de la fecha a proposito: antes ambas se concatenaban en un unico
 * `new Date()`, y una hora invalida (un numero cualquiera con formato HH:MM en otra parte
 * del PDF) anulaba tambien una fecha perfectamente buena.
 */
function parsearHora(texto) {
    if (!texto) return null;
    const match = texto.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (!match) return null;
    return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/**
 * 'despacho' | 'recepcion' | null.
 *
 * En Chile no existe un DTE separado para la recepcion: la salida y la devolucion se emiten
 * las dos como "GUIA DE DESPACHO ELECTRONICA", asi que el titulo no distingue nada y la rama
 * de despacho siempre ganaria. Las senales reales, en orden de confianza:
 *   1. el valor del campo "Tipo Traslado" (la etiqueta puede venir cortada en dos lineas)
 *   2. la glosa "RETIRO DE EQUIPO" en el detalle, que es lo que usan las guias de GOMAQ
 *   3. la linea "Desde:", que solo aparece cuando el equipo vuelve
 * Buscar "devolucion" en todo el documento no sirve: aparece tambien en las condiciones
 * comerciales de una guia de entrega.
 */
function detectarTipoGuia(texto) {
    if (!texto) return null;
    const plano = sinAcentos(texto);

    const tipoTraslado = plano.match(/tipo\s*(?:de\s*)?traslado\s*:?\s*([^\n]{0,60})/i);
    if (tipoTraslado && /devolucion|recepcion|retiro/i.test(tipoTraslado[1])) return 'recepcion';

    if (/retiro\s+de\s+equipo/i.test(plano)) return 'recepcion';
    if (/^\s*desde\s*:/im.test(plano)) return 'recepcion';
    if (/despacho/i.test(plano)) return 'despacho';
    return null;
}

/**
 * Folio del documento. Anclado al titulo ("... ELECTRONICA \n Nº1512") porque el mismo PDF
 * trae otros numeros con el mismo prefijo: "Orden Compra N 10104", "N INTERNO: 0506".
 */
function parsearFolio(texto) {
    if (!texto) return null;
    const match = sinAcentos(texto).match(/electronica\s*N[°º]\s*(\d+)/i);
    return match ? match[1] : null;
}

/** '12.345.678- 5' -> '12345678-5'. El PDF trae el digito verificador separado por un espacio. */
function normalizarRut(rut) {
    if (!rut) return null;
    const limpio = String(rut).replace(/[^0-9kK]/g, '').toUpperCase();
    if (limpio.length < 2) return null;
    return `${limpio.slice(0, -1)}-${limpio.slice(-1)}`;
}

/**
 * RUT del receptor del documento, normalizado.
 *
 * Se busca a partir de "SEÑOR(ES):" y no en todo el texto: el RUT de GOMAQ (el emisor)
 * aparece en el mismo documento y una busqueda libre podria quedarse con ese.
 */
function parsearRutReceptor(texto) {
    if (!texto) return null;
    const plano = sinAcentos(texto);
    const inicio = plano.search(/senor\(es\)/i);
    if (inicio === -1) return null;
    const match = plano.slice(inicio).match(/R\.?\s*U\.?\s*T\.?\s*:?\s*([\d.]{7,12}\s*-\s*[\dkK])/i);
    return match ? normalizarRut(match[1]) : null;
}

/** Monto total de una factura. Se conserva la heuristica original, que funciona en los DTE de GOMAQ. */
function parsearMonto(texto) {
    if (!texto) return null;
    const match = texto.match(/total[^\d]{0,15}([\d.,]{4,})/i) || texto.match(/\$\s?([\d.,]{4,})/);
    if (!match) return null;
    const numero = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
    return isNaN(numero) ? null : numero;
}

/**
 * Lectura del horometro impresa en la guia ("HOROMETRO: 1156"), o null.
 *
 * Solo viene en la guia de entrega: la de retiro y la factura no la traen, asi que esta es
 * una lectura por despacho y no reemplaza al registro que hace el mecanico en terreno.
 */
function parsearHorometro(texto) {
    if (!texto) return null;
    const match = sinAcentos(texto).match(/hor[oO]metro\s*:?\s*([\d.,]+)/i);
    if (!match) return null;
    // el separador de miles chileno es el punto: "1.156" son 1156 horas, no 1,156
    const numero = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
    return isNaN(numero) ? null : numero;
}

/**
 * Numero interno del equipo impreso en la guia ("N° INTERNO: 0807"), sin ceros a la izquierda
 * ('807'), o null. Es el numero con que GOMAQ identifica el equipo; en el sistema va al final
 * del codigo (PL-807), y ese cruce lo hace utils/detectarEquipo.
 */
function parsearNumeroInterno(texto) {
    if (!texto) return null;
    const match = sinAcentos(texto).match(/\bN\s*(?:[°ºo]\.?|\.)?\s*interno\s*:?\s*(\d{1,8})\b/i);
    if (!match) return null;
    const numero = match[1].replace(/^0+/, '');
    return numero || null;
}

function parsearGuia(texto) {
    return {
        numero_interno_detectado: parsearNumeroInterno(texto),
        fecha_detectada: parsearFechaEmision(texto),
        hora_detectada: parsearHora(texto),
        tipo_detectado: detectarTipoGuia(texto),
        rut_detectado: parsearRutReceptor(texto),
        folio_detectado: parsearFolio(texto),
        horometro_detectado: parsearHorometro(texto),
    };
}

// '210.000' -> 210000 (pesos enteros; el punto es separador de miles). Decimales distintos de cero o
// numeros fuera de rango -> null: un monto dudoso no se precarga.
function aPesos(crudo) {
    if (!crudo) return null;
    const [entero, decimales] = String(crudo).trim().split(',');
    if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(entero)) return null;
    if (decimales !== undefined && !/^0*$/.test(decimales)) return null;
    const n = Number(entero.replace(/\./g, ''));
    return Number.isSafeInteger(n) && n <= 9999999999 ? n : null;
}

/** "MONTO NETO $ 210.000" -> 210000, o null. */
function parsearMontoNeto(texto) {
    if (!texto) return null;
    const match = sinAcentos(texto).match(/monto\s+neto\s*:?\s*\$?\s*([\d.]+(?:,\d+)?)/i);
    return match ? aPesos(match[1]) : null;
}

/**
 * Vencimiento de la factura: las fechas del tramo entre "Pagos:" y "Forma de Pago" (AAAA-MM-DD o
 * DD-MM-AAAA). Si hay varias (cuotas) se devuelve la ultima y `varias_cuotas` en true para avisar.
 * La busqueda se ancla a "Pagos:" porque antes viene "Referencias: ... del 2026-07-13", que es la fecha de
 * la orden de compra y no el vencimiento.
 * @returns {{fecha: string|null, varias_cuotas: boolean}}
 */
function parsearVencimiento(texto) {
    const vacio = { fecha: null, varias_cuotas: false };
    if (!texto) return vacio;
    const plano = sinAcentos(texto);
    const ancla = plano.match(/\bpagos\s*:/i);
    if (!ancla) return vacio;
    let tramo = plano.slice(ancla.index + ancla[0].length);
    const fin = tramo.search(/forma\s+de\s+pago|timbre\s+electronico|monto\s+neto/i);
    tramo = fin >= 0 ? tramo.slice(0, fin) : tramo.slice(0, 300);
    const fechas = [];
    const patron = /\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/g;
    let m;
    while ((m = patron.exec(tramo)) !== null) {
        const iso = m[1]
            ? aFechaIso(Number(m[1]), Number(m[2]), Number(m[3]))
            : aFechaIso(Number(m[6]), Number(m[5]), Number(m[4]));
        if (iso) fechas.push(iso);
    }
    if (fechas.length === 0) return vacio;
    return { fecha: fechas[fechas.length - 1], varias_cuotas: fechas.length > 1 };
}

// linea "cantidad unidad precio ... valor" del detalle de un DTE: "1 UN 140.000 140.000"
const LINEA_VALOR = /^\s*\d+(?:[.,]\d+)?\s+[A-Za-z]{1,10}\.?\s+(?:[\d.,%-]+\s+)*([\d.]+(?:,\d+)?)\s*$/;

/**
 * Traslado de una factura: suma de las lineas del detalle cuya descripcion empieza por "TRASLADO". El valor
 * de cada linea es el ultimo numero de su renglon "cantidad unidad precio valor" (neto). El concepto sale
 * de las palabras ENTREGA y RETIRO de la descripcion (regla de David):
 *   entrega_y_retiro  dice las dos: se divide en mitades (entrega lleva el peso que sobra)
 *   entrega | retiro  dice solo una: todo a ese concepto
 *   sin_detalle       no dice ninguna: un solo monto, sin dividir
 *   varias_lineas     varias lineas de traslado con conceptos distintos, cada una a su concepto
 * Si alguna linea no tiene concepto, el total queda sin dividir. Si una linea de traslado no tiene valor
 * legible, se devuelve null (no se inventa un monto). Sin lineas de traslado: null.
 * @returns {{total: number, entrega: number|null, retiro: number|null, concepto: string, lineas: number} | null}
 */
function parsearTraslado(texto) {
    if (!texto) return null;
    const lineas = sinAcentos(texto).split(/\r?\n/);
    let inicio = lineas.findIndex((l) => /codigo\s+descripcion/i.test(l));
    inicio = inicio === -1 ? 0 : inicio + 1;
    const bloques = [];
    for (let i = inicio; i < lineas.length; i++) {
        const linea = lineas[i];
        if (/^\s*(referencias\s*:|pagos\s*:|forma\s+de\s+pago|timbre\s+electronico|monto\s+neto)/i.test(linea)) break;
        if (/^\s*-\s*\S/.test(linea)) bloques.push([linea.replace(/^\s*-\s*/, '')]);
        else if (bloques.length > 0) bloques[bloques.length - 1].push(linea);
    }
    const traslados = bloques.filter((b) => /^traslado\b/i.test(b[0].trim()));
    if (traslados.length === 0) return null;

    const partes = [];
    for (const bloque of traslados) {
        let valor = null;
        let indiceValor = -1;
        bloque.forEach((l, i) => {
            const m = l.match(LINEA_VALOR);
            if (m && i > 0) { valor = aPesos(m[1]); indiceValor = i; }
        });
        if (valor === null) return null;
        const descripcion = bloque.filter((_, i) => i !== indiceValor).join(' ').toUpperCase();
        const entrega = /\bENTREGA\b/.test(descripcion);
        const retiro = /\bRETIRO\b/.test(descripcion);
        const concepto = entrega && retiro ? 'entrega_y_retiro' : entrega ? 'entrega' : retiro ? 'retiro' : 'sin_detalle';
        partes.push({ valor, concepto });
    }
    const total = partes.reduce((s, p) => s + p.valor, 0);
    if (partes.some((p) => p.concepto === 'sin_detalle')) {
        return { total, entrega: null, retiro: null, concepto: 'sin_detalle', lineas: partes.length };
    }
    let entrega = 0;
    let retiro = 0;
    for (const p of partes) {
        const d = dividirTraslado(p.valor, p.concepto);
        entrega += d.entrega;
        retiro += d.retiro;
    }
    const conceptos = new Set(partes.map((p) => p.concepto));
    return {
        total, entrega, retiro,
        concepto: conceptos.size === 1 ? partes[0].concepto : 'varias_lineas',
        lineas: partes.length,
    };
}

/**
 * Lectura de una factura para precargar el formulario. Lo nuevo (neto, emision, vencimiento, traslado) se
 * PRECARGA y el administrativo lo confirma: nunca se guarda sin pasar por el.
 */
function parsearFactura(texto) {
    const vencimiento = parsearVencimiento(texto);
    return {
        monto_detectado: parsearMonto(texto),
        folio_detectado: parsearFolio(texto),
        rut_detectado: parsearRutReceptor(texto),
        monto_neto_detectado: parsearMontoNeto(texto),
        fecha_emision_detectada: parsearFechaEmision(texto),
        vencimiento_detectado: vencimiento.fecha,
        varias_cuotas: vencimiento.varias_cuotas,
        traslado_detectado: parsearTraslado(texto),
    };
}

module.exports = {
    parsearFechaEmision,
    parsearHora,
    detectarTipoGuia,
    parsearFolio,
    parsearRutReceptor,
    parsearMonto,
    parsearHorometro,
    parsearNumeroInterno,
    normalizarRut,
    parsearMontoNeto,
    parsearVencimiento,
    parsearTraslado,
    parsearGuia,
    parsearFactura,
};
