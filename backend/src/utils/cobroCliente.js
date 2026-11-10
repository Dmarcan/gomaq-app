// Lo que el portal le dice al cliente sobre el cobro de una reparacion (sin montos: el precio de venta
// de los repuestos esta pendiente de GOMAQ).
//
//   null           la orden sigue abierta: todavia no hay nada que decir
//   'por_definir'  quedan lineas de repuesto sin decidir si se cobran (el "?" del talonario) y la
//                  valorizacion todavia no esta aprobada
//   'con_cobro'    al menos una linea se cobra, o la valorizacion ya esta aprobada (el cobro esta decidido
//                  aunque quede alguna linea pendiente)
//   'sin_cobro'    ninguna linea se cobra (sin repuestos no se cobra)

// valorizacion solo se usa para saber si esta aprobada (no nula); el monto nunca sale de aqui.
function cobroParaCliente({ estado, facturable, lineasPendientes, valorizacion }) {
    if (estado !== 'finalizada') return null;
    const valorizada = valorizacion !== null && valorizacion !== undefined;
    // con la valorizacion aprobada el cobro ya esta decidido: las lineas pendientes no lo dejan por definir
    if (Number(lineasPendientes) > 0 && !valorizada) return 'por_definir';
    if (Number(lineasPendientes) > 0) return 'con_cobro';
    return facturable === true ? 'con_cobro' : 'sin_cobro';
}

module.exports = { cobroParaCliente };
