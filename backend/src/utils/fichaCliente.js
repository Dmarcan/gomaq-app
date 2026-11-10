// Edicion de la ficha de un cliente (PATCH /api/clientes/:id). Funcion pura.
// El correo de la ficha es el de los avisos y las facturas; no tiene relacion con el correo con que una
// persona inicia sesion (eso vive en `usuarios` y se vincula por usuarios.cliente_id).

const { rutValido, MENSAJE_RUT_INVALIDO } = require('./rut');
const { normalizarCorreo } = require('./correo');

const CAMPOS = ['nombre', 'rut', 'email', 'telefono', 'direccion'];
const MAXIMOS = { nombre: 150, rut: 20, email: 150, telefono: 30, direccion: 300 };
const FORMATO_CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Valida los campos que vienen en el cuerpo y devuelve { cambios } con solo esos campos, o { error }.
 * Un campo ausente no se toca; uno vacio se guarda como null (el nombre no puede quedar vacio).
 */
function validarFichaCliente(body) {
    const b = body && typeof body === 'object' ? body : {};
    const cambios = {};
    for (const campo of CAMPOS) {
        if (!(campo in b)) continue;
        const crudo = b[campo];
        if (crudo !== null && typeof crudo !== 'string') return { error: `${campo} debe ser un texto` };
        let valor = crudo === null ? '' : crudo.trim();
        if (valor.length > MAXIMOS[campo]) return { error: `${campo} admite hasta ${MAXIMOS[campo]} caracteres` };
        if (campo === 'nombre') {
            if (!valor) return { error: 'El nombre no puede quedar vacío' };
        } else if (valor === '') {
            valor = null;
        } else if (campo === 'rut' && !rutValido(valor)) {
            return { error: MENSAJE_RUT_INVALIDO };
        } else if (campo === 'email') {
            valor = normalizarCorreo(valor);
            if (!FORMATO_CORREO.test(valor)) return { error: 'Escribe un correo válido, por ejemplo nombre@empresa.cl' };
        }
        cambios[campo] = valor;
    }
    if (Object.keys(cambios).length === 0) return { error: 'No hay nada que cambiar' };
    return { cambios };
}

module.exports = { validarFichaCliente, CAMPOS };
