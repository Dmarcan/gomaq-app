// Reglas puras de la carga masiva de clientes (scripts/cargar_clientes.js): normalizar el RUT, validar
// cada registro del archivo db/datos/clientes_gomaq.json y elegir el ejecutivo. Sin base de datos.
//
// El archivo no lleva correo, telefono ni contacto: un cliente cargado asi no recibe ningun aviso hasta
// que alguien escriba su correo desde el panel.

const { rutValido } = require('./rut');

// ejecutivos que la carga crea si no existen (decision de David); los demas vendedores de la planilla
// original quedan sin ejecutivo
const EJECUTIVOS_A_CREAR = ['Freddy', 'Alejandra', 'Wenceslao', 'Oscar'];

// campos que un registro nunca puede traer
const CAMPOS_PROHIBIDOS = ['email', 'correo', 'telefono', 'contacto', 'fono', 'celular'];

const CAMPOS_PERMITIDOS = ['rut', 'nombre', 'direccion', 'giro', 'ejecutivo', 'plazo_pago_dias'];

/** '76.123.456-0' -> '76123456-0'. Devuelve null si no tiene la forma de un RUT valido. */
function normalizarRut(rut) {
    if (typeof rut !== 'string') return null;
    const limpio = rut.replace(/[\s.\-]/g, '').toUpperCase();
    if (!rutValido(limpio)) return null;
    return `${limpio.slice(0, -1)}-${limpio.slice(-1)}`;
}

/** Texto en minusculas, sin acentos y sin espacios sobrantes (para comparar nombres). */
function sinAcentos(texto) {
    return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function textoOpcional(valor, maximo, campo, errores) {
    if (valor === null || valor === undefined) return;
    if (typeof valor !== 'string' || valor.length > maximo || valor !== valor.trim() || valor === '') {
        errores.push(`${campo}: debe ser un texto sin espacios sobrantes de hasta ${maximo} caracteres, o nulo`);
    }
}

/** Lista de problemas de un registro (vacia si esta bien). */
function validarCliente(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return ['el registro no es un objeto'];
    const errores = [];
    for (const campo of CAMPOS_PROHIBIDOS) {
        if (Object.prototype.hasOwnProperty.call(c, campo)) errores.push(`trae el campo "${campo}", que la carga no admite`);
    }
    for (const campo of Object.keys(c)) {
        if (!CAMPOS_PROHIBIDOS.includes(campo) && !CAMPOS_PERMITIDOS.includes(campo)) errores.push(`campo desconocido "${campo}"`);
    }
    if (normalizarRut(c.rut) === null) errores.push('rut: dígito verificador o formato inválido');
    else if (c.rut !== normalizarRut(c.rut)) errores.push('rut: debe venir normalizado (12345678-9)');
    if (typeof c.nombre !== 'string' || c.nombre.length < 1 || c.nombre.length > 150 || c.nombre !== c.nombre.trim()) {
        errores.push('nombre: de 1 a 150 caracteres, sin espacios sobrantes');
    }
    textoOpcional(c.direccion, 300, 'direccion', errores);
    textoOpcional(c.giro, 150, 'giro', errores);
    if (c.ejecutivo !== null && c.ejecutivo !== undefined && !EJECUTIVOS_A_CREAR.includes(c.ejecutivo)) {
        errores.push(`ejecutivo: debe ser nulo o uno de ${EJECUTIVOS_A_CREAR.join(', ')}`);
    }
    if (c.plazo_pago_dias !== null && c.plazo_pago_dias !== undefined
        && !(Number.isInteger(c.plazo_pago_dias) && c.plazo_pago_dias >= 0 && c.plazo_pago_dias <= 365)) {
        errores.push('plazo_pago_dias: entero entre 0 y 365, o nulo');
    }
    return errores;
}

/**
 * Valida todo el archivo. Devuelve { errores: ['registro 3: ...'], repetidos: [rut normalizado] }.
 * Un RUT repetido es un error: el archivo debe traer un cliente por RUT.
 */
function validarArchivo(clientes) {
    if (!Array.isArray(clientes)) return { errores: ['"clientes" debe ser una lista'], repetidos: [] };
    const errores = [];
    const vistos = new Set();
    const repetidos = new Set();
    clientes.forEach((c, i) => {
        for (const e of validarCliente(c)) errores.push(`registro ${i + 1}: ${e}`);
        const rut = normalizarRut(c && c.rut);
        if (rut) {
            if (vistos.has(rut)) repetidos.add(rut);
            vistos.add(rut);
        }
    });
    for (const r of repetidos) errores.push(`RUT repetido en el archivo: ${r}`);
    return { errores, repetidos: [...repetidos] };
}

/**
 * Busca en la lista de ejecutivos de la base ({id, nombre}) el del nombre dado: igual, o que empiece con
 * el nombre seguido de un espacio ("Freddy" coincide con "Freddy Soto"), sin acentos ni mayusculas.
 * { estado: 'ninguno' | 'uno' | 'ambiguo', id }
 */
function resolverEjecutivo(nombre, ejecutivos) {
    const buscado = sinAcentos(nombre);
    if (!buscado) return { estado: 'ninguno', id: null };
    const coinciden = (ejecutivos || []).filter((e) => {
        const n = sinAcentos(e.nombre);
        return n === buscado || n.startsWith(`${buscado} `);
    });
    if (coinciden.length === 0) return { estado: 'ninguno', id: null };
    if (coinciden.length > 1) return { estado: 'ambiguo', id: null };
    return { estado: 'uno', id: coinciden[0].id };
}

/**
 * Plazo de pago de un cliente a partir de los plazos (vencimiento menos emision, en dias) de sus facturas:
 * el valor solo si todas tuvieron el mismo plazo valido; si hubo mas de uno, o ninguno, nulo.
 */
function plazoConstante(plazos) {
    const lista = plazos || [];
    const validos = lista.filter((p) => Number.isInteger(p) && p >= 0 && p <= 365);
    if (validos.length === 0 || validos.length !== lista.length) return null;
    return new Set(validos).size === 1 ? validos[0] : null;
}

module.exports = { EJECUTIVOS_A_CREAR, normalizarRut, sinAcentos, validarCliente, validarArchivo, resolverEjecutivo, plazoConstante };
