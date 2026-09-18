// Orden de la tabla de Flota, resuelto en el servidor.
//
// Antes el panel ordenaba en pantalla, pero la lista pagina: al ordenar por estado solo se
// ordenaban los equipos ya descargados, no los 87 (o los 500). Aca el orden entra a la consulta.
//
// Lo que llega de la query NUNCA se interpola: solo elige entre las expresiones de abajo, asi
// que un `orden` inventado no puede meter SQL.

const COLUMNAS = {
    codigo: null, // es el orden de desempate, ver codigoNatural
    tipo: 'm.tipo',
    marca: 'm.marca',
    estado: 'm.estado',
    altura: 'm.altura_trabajo',
    capacidad: 'm.capacidad_carga',
    combustible: 'm.tipo_combustible',
    cliente: 'c.nombre',
};

// "PL-602" antes que "PL-1101": el texto puro los ordenaria al reves ("1101" < "602"), y con los
// codigos reales (prefijo por tipo + N. interno) seria la primera cosa rara que se ve en la tabla.
function codigoNatural(sentido) {
    return [
        `split_part(m.codigo, '-', 1) ${sentido}`,
        `NULLIF(regexp_replace(split_part(m.codigo, '-', 2), '[^0-9]', '', 'g'), '')::int ${sentido} NULLS LAST`,
        `m.codigo ${sentido}`,
    ].join(', ');
}

/**
 * Cuerpo del ORDER BY. Siempre termina en el codigo natural, para que el orden sea estable
 * entre paginas: sin desempate, dos equipos iguales podrian aparecer en dos paginas o en ninguna.
 * Los vacios van al final en ambos sentidos: un equipo sin altura cargada no debe encabezar la
 * lista cuando se ordena de mayor a menor.
 */
function ordenSql(orden, dir) {
    const sentido = String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const conocida = Object.prototype.hasOwnProperty.call(COLUMNAS, orden);
    if (!conocida) return codigoNatural('ASC');
    const columna = COLUMNAS[orden];
    if (!columna) return codigoNatural(sentido);
    return `${columna} ${sentido} NULLS LAST, ${codigoNatural('ASC')}`;
}

module.exports = { ordenSql, COLUMNAS };
