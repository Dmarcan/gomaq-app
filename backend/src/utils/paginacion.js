// Paginacion y busqueda de los listados que crecen.
//
// Hallazgo de la auditoria de UX: ningun endpoint paginaba. Con ~500 equipos, cada carga de
// Flota traia los 500 y la pantalla de Costo por equipo armaba una tabla de 500 filas de golpe.
//
// Forma de la respuesta: SIEMPRE el sobre { items, total, hay_mas }, incluso cuando no se pide
// limite. Tener una sola forma evita que el mismo endpoint devuelva a veces un arreglo y a
// veces un objeto, que es la trampa clasica de la paginacion "opcional".
//
// `limit` ausente = sin limite, y eso es deliberado: los selectores de equipo del panel y el
// catalogo offline del movil necesitan la lista completa. Solo las pantallas de listado piden
// un limite.

const LIMITE_MAXIMO = 200;

/**
 * Interpreta limit/offset de la query.
 * @returns {{limit: number|null, offset: number}} limit null = traer todo
 */
function parsearPaginacion(query = {}) {
    const offsetCrudo = Number(query.offset);
    const offset = Number.isInteger(offsetCrudo) && offsetCrudo > 0 ? offsetCrudo : 0;

    if (query.limit === undefined || query.limit === null || query.limit === '') {
        return { limit: null, offset };
    }
    const limitCrudo = Number(query.limit);
    if (!Number.isFinite(limitCrudo) || limitCrudo <= 0) return { limit: null, offset };
    // el tope evita que alguien pida limit=999999 y anule la paginacion
    return { limit: Math.min(Math.floor(limitCrudo), LIMITE_MAXIMO), offset };
}

/** Texto de busqueda normalizado, o null si no viene. */
function parsearBusqueda(query = {}) {
    const q = (query.q === undefined || query.q === null) ? '' : String(query.q).trim();
    return q.length === 0 ? null : q;
}

/**
 * Arma la respuesta. `total` son las filas que cumplen el filtro, no las devueltas: es lo que
 * permite mostrar "45 de 500" y decidir si queda algo por cargar.
 */
function envolver(items, total, { limit, offset } = { limit: null, offset: 0 }) {
    const lista = Array.isArray(items) ? items : [];
    const totalReal = Number.isFinite(Number(total)) ? Number(total) : lista.length;
    return {
        items: lista,
        total: totalReal,
        hay_mas: limit === null ? false : (offset || 0) + lista.length < totalReal,
    };
}

module.exports = { LIMITE_MAXIMO, parsearPaginacion, parsearBusqueda, envolver };
