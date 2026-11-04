// Configuracion del cobro de arriendos (tabla `configuracion`, migracion 022). Las reglas de
// validacion espejan el CHECK de la tabla.

const DEFAULTS = Object.freeze({
    dia_facturacion: 5,
    hora_corte_despacho: 13,
    incluir_dia_recepcion: true,
});

const enteroEnRango = (v, min, max) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

// sin prototipo: una clave como `__proto__` o `constructor` no debe resolverse a nada heredado
const VALIDADORES = Object.assign(Object.create(null), {
    dia_facturacion: (v) => enteroEnRango(v, 1, 28),
    hora_corte_despacho: (v) => enteroEnRango(v, 0, 23),
    incluir_dia_recepcion: (v) => typeof v === 'boolean',
});

const MENSAJES = Object.assign(Object.create(null), {
    dia_facturacion: 'El día de facturación debe ser un entero entre 1 y 28',
    hora_corte_despacho: 'La hora de corte debe ser un entero entre 0 y 23',
    incluir_dia_recepcion: 'Incluir el día de recepción debe ser verdadero o falso',
});

/** Valida el cuerpo de un cambio: solo claves conocidas, al menos una, valores estrictos. */
function validarCambioConfiguracion(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Cuerpo inválido' };
    const claves = Object.keys(body);
    if (claves.length === 0) return { error: 'No hay nada que cambiar' };
    const valores = {};
    for (const clave of claves) {
        if (!Object.hasOwn(VALIDADORES, clave)) return { error: `Configuración desconocida: ${clave}` };
        if (!VALIDADORES[clave](body[clave])) return { error: MENSAJES[clave] };
        valores[clave] = body[clave];
    }
    return { valores };
}

/** Lee la configuracion vigente: lo guardado mezclado sobre los valores por defecto. */
async function leerConfiguracion(db) {
    const r = await db.query('SELECT clave, valor FROM configuracion');
    const config = { ...DEFAULTS };
    for (const fila of r.rows) {
        if (Object.hasOwn(VALIDADORES, fila.clave) && VALIDADORES[fila.clave](fila.valor)) config[fila.clave] = fila.valor;
    }
    return config;
}

module.exports = { DEFAULTS, validarCambioConfiguracion, leerConfiguracion };
