// Heuristicas para prellenar los formularios de Guias y Facturacion a partir del texto
// que se logra extraer de un PDF (ver leerTextoPdf). Son funciones puras sobre texto:
// no tocan la BD ni HTTP, para poder probarlas contra documentos reales (ver test/).
//
// Mejor esfuerzo por diseno: cuando algo no se reconoce se devuelve null y el
// administrativo llena ese campo a mano. Nunca se inventa un valor.

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

function parsearGuia(texto) {
    return {
        fecha_detectada: parsearFechaEmision(texto),
        hora_detectada: parsearHora(texto),
        tipo_detectado: detectarTipoGuia(texto),
        rut_detectado: parsearRutReceptor(texto),
        folio_detectado: parsearFolio(texto),
    };
}

function parsearFactura(texto) {
    return {
        monto_detectado: parsearMonto(texto),
        folio_detectado: parsearFolio(texto),
        rut_detectado: parsearRutReceptor(texto),
    };
}

module.exports = {
    parsearFechaEmision,
    parsearHora,
    detectarTipoGuia,
    parsearFolio,
    parsearRutReceptor,
    parsearMonto,
    normalizarRut,
    parsearGuia,
    parsearFactura,
};
