// Validaciones de entrada compartidas por las rutas. Todas son puras (sin base ni red): las
// rutas solo deciden que hacer con el resultado. Existen porque un campo mal tipado
// (un numero donde se espera texto, un arreglo, un objeto) hacia caer la API con un 500 o,
// peor, con una excepcion que terminaba el proceso.

/** Tope de un monto en pesos: las columnas son NUMERIC(12,2), es decir, 10 digitos enteros. */
const MAX_MONTO_PESOS = 9999999999;

/** Largos maximos de los textos libres (las columnas VARCHAR(n) rechazan lo que se pase). */
const MAX_TEXTO_CORTO = 150;
const MAX_TEXTO_LARGO = 2000;

/**
 * Texto opcional: ausente, null o vacio es valido. Si viene, debe ser un string de hasta `max`
 * caracteres. Devuelve true cuando el valor NO sirve.
 */
function textoInvalido(valor, max = MAX_TEXTO_LARGO) {
    if (valor === undefined || valor === null) return false;
    return typeof valor !== 'string' || valor.length > max;
}

/** Texto obligatorio: string no vacio (tras recortar) de hasta `max` caracteres. */
function textoRequeridoValido(valor, max = MAX_TEXTO_CORTO) {
    return typeof valor === 'string' && valor.trim().length > 0 && valor.length <= max;
}

/** Fecha de calendario 'YYYY-MM-DD' que existe de verdad (rechaza 2026-02-31). */
function esDiaValido(valor) {
    if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return false;
    const [a, m, d] = valor.split('-').map(Number);
    const f = new Date(Date.UTC(a, m - 1, d));
    return f.getUTCFullYear() === a && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
}

/**
 * Parametro de fecha de un query: ausente es valido; si viene debe ser un texto que Date
 * entienda. Devuelve el Date, `null` si no vino, o `undefined` si no es valido.
 */
function fechaDeQuery(valor) {
    if (valor === undefined || valor === '') return null;
    if (typeof valor !== 'string' || valor.length > 40) return undefined;
    const f = new Date(valor);
    return Number.isNaN(f.getTime()) ? undefined : f;
}

/** Numero finito (rechaza NaN, Infinity y lo que desborda como 1e400). */
function esNumeroFinito(valor) {
    return typeof valor === 'number' && Number.isFinite(valor);
}

/** Id de base de datos en una URL: entero positivo que cabe en un INTEGER de Postgres. */
function esIdDeRuta(valor) {
    return typeof valor === 'string' && /^[1-9][0-9]{0,9}$/.test(valor) && Number(valor) <= 2147483647;
}

/**
 * Registra en el router una comprobacion de los parametros de ruta que son ids: un id que no es
 * un entero positivo responde 400 en vez de llegar a la consulta y fallar el cast con un 500.
 */
function validarIdsEnRuta(router, nombres) {
    for (const nombre of nombres) {
        router.param(nombre, (req, res, next, valor) => {
            if (!esIdDeRuta(valor)) return res.status(400).json({ error: 'Identificador inválido' });
            return next();
        });
    }
}

/**
 * Valida de una vez los campos de un cuerpo JSON (o multipart). Devuelve el mensaje del primer
 * problema o null.
 *   textos:  { campo: largoMaximo }        string de hasta N caracteres (ausente o null vale)
 *   ids:     [campo]                       entero positivo de INTEGER (vacio, null y 0 valen)
 *   numeros: { campo: [min, max] }         numero finito en el rango (vacio vale)
 */
function validarCuerpo(body, reglas) {
    const b = body && typeof body === 'object' ? body : {};
    for (const [campo, max] of Object.entries(reglas.textos || {})) {
        if (textoInvalido(b[campo], max)) return `${campo} debe ser un texto de hasta ${max} caracteres`;
    }
    const vacio = (v) => v === undefined || v === null || v === '' || v === 0 || v === '0';
    for (const campo of reglas.ids || []) {
        const v = b[campo];
        if (vacio(v)) continue;
        if (!(typeof v === 'number' || typeof v === 'string') || !esIdDeRuta(String(v))) {
            return `${campo} no es un identificador válido`;
        }
    }
    for (const [campo, [min, max]] of Object.entries(reglas.numeros || {})) {
        const v = b[campo];
        if (v === undefined || v === null || v === '') continue;
        const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
        if (!Number.isFinite(n) || n < min || n > max) return `${campo} debe ser un número entre ${min} y ${max}`;
    }
    return null;
}

/** Fecha y hora que `new Date` no entiende (o que no es un texto): true cuando NO sirve. */
function fechaHoraInvalida(valor) {
    if (typeof valor !== 'string' || valor.length > 40) return true;
    return Number.isNaN(new Date(valor).getTime());
}

module.exports = {
    fechaHoraInvalida,
    validarCuerpo,
    esIdDeRuta, validarIdsEnRuta,
    MAX_MONTO_PESOS, MAX_TEXTO_CORTO, MAX_TEXTO_LARGO,
    textoInvalido, textoRequeridoValido, esDiaValido, fechaDeQuery, esNumeroFinito,
};
