// Ayuda para las pruebas que montan rutas sin base de datos, o con tokens de usuarios que no
// existen (ids de relleno): verifyToken revisa la cuenta en la base en cada peticion, y aqui se
// reemplaza esa busqueda por una que cree lo que dice el token. Solo para pruebas.
//
// Las pruebas que si usan la base (usuarios reales) no la usan: ahi se prueba el comportamiento real.

const { usarBuscadorDeUsuarios } = require('../src/middleware/auth');

/** Toda cuenta existe, esta activa y tiene el rol y el cliente que firma su token. */
function creerEnElToken() {
    return usarBuscadorDeUsuarios(async (id, claims) => ({
        rol: claims.rol,
        cliente_id: claims.cliente_id ?? null,
        estado_cuenta: 'activo',
    }));
}

module.exports = { creerEnElToken };
