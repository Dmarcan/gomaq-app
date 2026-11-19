// Edicion de la ficha de un cliente (PATCH /api/clientes/:id). Funcion pura.
// El correo de la ficha es el de los avisos y las facturas; no tiene relacion con el correo con que una
// persona inicia sesion (eso vive en `usuarios` y se vincula por usuarios.cliente_id).

const { rutValido, MENSAJE_RUT_INVALIDO } = require('./rut');
const { normalizarCorreo } = require('./correo');
const { validarCoordenadas } = require('./geo');

const CAMPOS = ['nombre', 'rut', 'email', 'telefono', 'direccion', 'giro'];
const MAXIMOS = { nombre: 150, rut: 20, email: 150, telefono: 30, direccion: 300, giro: 150 };
const FORMATO_CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PLAZO_MAXIMO_DIAS = 365;
const MENSAJE_PLAZO = `El plazo de pago debe ser un número entero de días entre 0 y ${PLAZO_MAXIMO_DIAS} (0 es contado)`;

/**
 * Plazo habitual de pago en dias. Acepta un entero o un texto de digitos; vacio o null es "sin plazo".
 * 0 es contado. Devuelve { valor } (entero o null) o { error }.
 */
function validarPlazoPago(crudo) {
    if (crudo === null || crudo === undefined) return { valor: null };
    let n;
    if (typeof crudo === 'number') {
        n = crudo;
    } else if (typeof crudo === 'string') {
        const t = crudo.trim();
        if (t === '') return { valor: null };
        if (!/^\d{1,4}$/.test(t)) return { error: MENSAJE_PLAZO };
        n = Number(t);
    } else {
        return { error: MENSAJE_PLAZO };
    }
    if (!Number.isInteger(n) || n < 0 || n > PLAZO_MAXIMO_DIAS) return { error: MENSAJE_PLAZO };
    return { valor: n };
}

/**
 * Valida los campos que vienen en el cuerpo y devuelve { cambios } con solo esos campos, o { error }.
 * Un campo ausente no se toca; uno vacio se guarda como null (el nombre no puede quedar vacio).
 * `plazo_pago_dias` es el unico campo no textual y se valida aparte (entero de 0 a 365 o null).
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
    if ('plazo_pago_dias' in b) {
        const plazo = validarPlazoPago(b.plazo_pago_dias);
        if (plazo.error) return { error: plazo.error };
        cambios.plazo_pago_dias = plazo.valor;
    }
    if (Object.keys(cambios).length === 0) return { error: 'No hay nada que cambiar' };
    return { cambios };
}

// ---- Ficha propia: lo que el cliente edita desde el portal (PATCH /api/clientes/mia) ----

const EDITABLES_PROPIOS = ['email', 'telefono', 'direccion', 'horario_trabajo', 'horario_colacion', 'latitud', 'longitud'];
const MAXIMO_HORARIO = 100; // VARCHAR(100), migracion 009
const MENSAJE_SOLO_GOMAQ = 'Ese dato lo actualiza GOMAQ';
// Lo unico que ve el cliente de su ficha: se copia campo por campo, sin ejecutivo_id ni created_at
const CAMPOS_FICHA_PROPIA = [
    'nombre', 'rut', 'giro', 'email', 'telefono', 'direccion',
    'horario_trabajo', 'horario_colacion', 'plazo_pago_dias', 'latitud', 'longitud',
];

/**
 * Valida el cuerpo de PATCH /api/clientes/mia. Lista blanca: solo correo, telefono, direccion,
 * horarios y la pareja latitud/longitud. Cualquier otra clave (nombre, RUT, giro, plazo, ids o lo que
 * sea) se rechaza, no se ignora. El correo no puede quedar vacio (es el de avisos y facturas).
 * Devuelve { cambios } o { error }.
 */
function validarFichaPropia(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'No hay nada que cambiar' };
    const claves = Object.keys(body);
    if (claves.some((k) => !EDITABLES_PROPIOS.includes(k))) return { error: MENSAJE_SOLO_GOMAQ };
    const cambios = {};

    const textuales = {};
    for (const campo of ['email', 'telefono', 'direccion']) if (campo in body) textuales[campo] = body[campo];
    if (Object.keys(textuales).length > 0) {
        if ('email' in textuales && (textuales.email === null || (typeof textuales.email === 'string' && textuales.email.trim() === ''))) {
            return { error: 'El correo de la empresa no puede quedar vacío' };
        }
        const r = validarFichaCliente(textuales);
        if (r.error) return { error: r.error };
        Object.assign(cambios, r.cambios);
    }

    for (const campo of ['horario_trabajo', 'horario_colacion']) {
        if (!(campo in body)) continue;
        const crudo = body[campo];
        if (crudo !== null && typeof crudo !== 'string') return { error: `${campo} debe ser un texto` };
        const valor = crudo === null ? '' : crudo.trim();
        if (valor.length > MAXIMO_HORARIO) return { error: `${campo} admite hasta ${MAXIMO_HORARIO} caracteres` };
        cambios[campo] = valor === '' ? null : valor;
    }

    if ('latitud' in body || 'longitud' in body) {
        const c = validarCoordenadas(body.latitud, body.longitud);
        if (!c.ok) return { error: c.error };
        cambios.latitud = c.latitud;
        cambios.longitud = c.longitud;
    }

    if (Object.keys(cambios).length === 0) return { error: 'No hay nada que cambiar' };
    return { cambios };
}

/** La ficha tal como la ve el cliente, copiada campo por campo desde una fila de la base. */
function fichaDeFila(fila) {
    const f = fila || {};
    const ficha = {};
    for (const campo of CAMPOS_FICHA_PROPIA) {
        let v = f[campo] === undefined ? null : f[campo];
        if ((campo === 'latitud' || campo === 'longitud') && v !== null) v = Number(v); // NUMERIC llega como texto
        ficha[campo] = v;
    }
    return ficha;
}

/** De los cambios pedidos, deja { campo: { antes, despues } } solo para los que de verdad cambian. */
function diferenciasFicha(antes, cambios) {
    const a = fichaDeFila(antes);
    const dif = {};
    for (const campo of Object.keys(cambios)) {
        if (a[campo] !== cambios[campo]) dif[campo] = { antes: a[campo], despues: cambios[campo] };
    }
    return dif;
}

module.exports = {
    validarFichaCliente,
    validarFichaPropia, fichaDeFila, diferenciasFicha, CAMPOS_FICHA_PROPIA,
};
