// Conversiones de valores sueltos que usan varias rutas y utilidades. Son puras (sin base ni red).
// Existen en tres variantes porque Postgres entrega los NUMERIC como texto y cada lugar decide
// distinto que hacer con el vacio y con lo que no es un numero: el nombre dice cual es.

/** Ausente, null o texto vacio. */
const vacio = (v) => v === undefined || v === null || v === '';

/** Numero o null: null y undefined dan null; el resto pasa por Number (un texto no numerico da NaN). */
const num = (v) => (v === null || v === undefined ? null : Number(v));

/** Como `num`, pero el texto vacio tambien da null. */
const numSinVacio = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Numero o null: lo ausente, vacio o no numerico da null (nunca devuelve NaN). */
const numValido = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

module.exports = { vacio, num, numSinVacio, numValido };
