// Reglas puras para crear y desactivar cuentas internas (mecanico, administrativo y gerente) desde el
// panel. Sin consultas: la ruta solo orquesta. Las cuentas de cliente no pasan por aqui (se crean
// con el registro y se aprueban en Solicitudes).

const ROLES_INTERNOS = ['mecanico', 'administrativo', 'gerente'];

const MIN_PASSWORD = 8;
// bcrypt solo lee los primeros 72 bytes: una clave mas larga se trunca en silencio
const MAX_PASSWORD_BYTES = 72;
const MAX_NOMBRE = 150;
const MAX_EMAIL = 150;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reglas de una contrasena nueva: minimo 8 caracteres y no mas de 72 bytes (bcrypt trunca en silencio). */
function validarPassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
        return { ok: false, error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres` };
    }
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
        return { ok: false, error: `La contraseña no puede pasar de ${MAX_PASSWORD_BYTES} bytes (unos ${MAX_PASSWORD_BYTES} caracteres)` };
    }
    return { ok: true };
}

/** Valida el cuerpo de POST /api/usuarios/:id/password. */
function validarCambioDePassword(body) {
    const b = body && typeof body === 'object' ? body : {};
    const v = validarPassword(b.password);
    return v.ok ? { ok: true, password: b.password } : v;
}

/**
 * Valida el cuerpo de POST /api/usuarios y lo deja normalizado.
 * @returns {{ok: true, datos: {nombre:string, email:string, rol:string, password:string}} | {ok: false, error: string}}
 */
function validarNuevaCuenta(body) {
    const b = body && typeof body === 'object' ? body : {};
    const nombre = typeof b.nombre === 'string' ? b.nombre.trim() : '';
    if (nombre.length < 2 || nombre.length > MAX_NOMBRE) {
        return { ok: false, error: `El nombre es obligatorio (entre 2 y ${MAX_NOMBRE} caracteres)` };
    }
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!email || email.length > MAX_EMAIL || !EMAIL.test(email)) {
        return { ok: false, error: 'El correo no es válido' };
    }
    if (typeof b.rol !== 'string' || !ROLES_INTERNOS.includes(b.rol)) {
        return { ok: false, error: `El rol debe ser uno de: ${ROLES_INTERNOS.join(', ')}` };
    }
    const clave = validarPassword(b.password);
    if (!clave.ok) return clave;
    return { ok: true, datos: { nombre, email, rol: b.rol, password: b.password } };
}

/**
 * Valida el cuerpo de PATCH /api/usuarios/:id/estado y decide si se puede.
 * @param {object} body
 * @param {number} idObjetivo cuenta que se cambia
 * @param {number} idActor quien lo pide
 * @returns {{ok: true, estado: 'activo'|'rechazado'} | {ok: false, codigo: number, error: string}}
 */
function validarCambioDeEstado(body, idObjetivo, idActor) {
    const activo = body && typeof body === 'object' ? body.activo : undefined;
    if (typeof activo !== 'boolean') {
        return { ok: false, codigo: 400, error: 'Indique activo: true o false' };
    }
    if (Number(idObjetivo) === Number(idActor)) {
        return { ok: false, codigo: 409, error: 'No puedes desactivar tu propia cuenta' };
    }
    // 'rechazado' es el estado que el inicio de sesion ya trata como "cuenta desactivada"
    return { ok: true, estado: activo ? 'activo' : 'rechazado' };
}

module.exports = {
    ROLES_INTERNOS, MIN_PASSWORD, MAX_PASSWORD_BYTES,
    validarPassword, validarCambioDePassword, validarNuevaCuenta, validarCambioDeEstado,
};
