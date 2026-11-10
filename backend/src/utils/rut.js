// Validacion del RUT chileno (modulo 11). Solo se usa al crear: los datos existentes no se tocan.

/** Verdadero si el RUT tiene un digito verificador correcto. Acepta puntos, guion y espacios opcionales, y K o k. */
function rutValido(rut) {
    if (typeof rut !== 'string') return false;
    const limpio = rut.replace(/[\s.\-]/g, '').toUpperCase();
    if (!/^\d{7,8}[\dK]$/.test(limpio)) return false;
    const cuerpo = limpio.slice(0, -1);
    const dv = limpio.slice(-1);
    let suma = 0;
    let factor = 2;
    for (let i = cuerpo.length - 1; i >= 0; i--) {
        suma += Number(cuerpo[i]) * factor;
        factor = factor === 7 ? 2 : factor + 1;
    }
    const resto = 11 - (suma % 11);
    const esperado = resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
    return dv === esperado;
}

const MENSAJE_RUT_INVALIDO = 'El RUT no es válido: revisa el dígito verificador';

module.exports = { rutValido, MENSAJE_RUT_INVALIDO };
