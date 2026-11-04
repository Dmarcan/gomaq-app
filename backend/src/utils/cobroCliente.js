// Lo que el portal le dice al cliente sobre el cobro de una reparacion (sin montos: el precio de venta
// de los repuestos esta pendiente de GOMAQ).
//
//   null           la orden sigue abierta: todavia no hay nada que decir
//   'por_definir'  quedan lineas de repuesto sin decidir si se cobran (el "?" del talonario)
//   'con_cobro'    al menos una linea se cobra
//   'sin_cobro'    ninguna linea se cobra (sin repuestos no se cobra)

function cobroParaCliente({ estado, facturable, lineasPendientes }) {
    if (estado !== 'finalizada') return null;
    if (Number(lineasPendientes) > 0) return 'por_definir';
    return facturable === true ? 'con_cobro' : 'sin_cobro';
}

module.exports = { cobroParaCliente };
