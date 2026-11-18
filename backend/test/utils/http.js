// Ayudas compartidas por las pruebas que levantan rutas en memoria y las llaman por HTTP.
// Antes cada archivo tenia su copia; aqui queda una sola, con el mismo comportamiento.
//
// Nota: `node --test` toma como prueba todo .js bajo test/, asi que este archivo aparece como una
// entrada mas en el recuento (igual que _entornoPruebas.js y _sesionDePrueba.js).

const jwt = require('jsonwebtoken');

/** Las pruebas con base solo corren con GOMAQ_TEST_ESCRITURA=1 y un DATABASE_URL; si no, se omiten. */
function requiereBase(t) {
    const habilitado = process.env.GOMAQ_TEST_ESCRITURA === '1' && Boolean(process.env.DATABASE_URL);
    if (!habilitado) {
        t.skip('pruebas de escritura deshabilitadas: usar GOMAQ_TEST_ESCRITURA=1 con una base local');
        return false;
    }
    return true;
}

/** Levanta la app en un puerto libre de 127.0.0.1. Devuelve el servidor y la URL base. */
async function servirApp(app) {
    let servidor;
    await new Promise((resolve) => { servidor = app.listen(0, resolve); });
    return { servidor, base: `http://127.0.0.1:${servidor.address().port}` };
}

/** Respuesta de fetch como { status, body }; body es null si la respuesta no trae JSON. */
async function leerRespuesta(r) {
    let json = null;
    try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
    return { status: r.status, body: json };
}

/** GET autenticado con un token ya firmado. */
async function pedirConToken(base, ruta, token) {
    return leerRespuesta(await fetch(`${base}${ruta}`, { headers: { Authorization: `Bearer ${token}` } }));
}

/** Fabrica de tokens de un cliente con un id de usuario de relleno (distinto por bloque de pruebas). */
function tokenClienteDe(idUsuario) {
    return (clienteId) => jwt.sign({ id: idUsuario, rol: 'cliente', cliente_id: clienteId }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

module.exports = { requiereBase, servirApp, leerRespuesta, pedirConToken, tokenClienteDe };
