// Validacion del RUT chileno (modulo 11). Solo se usa al crear: los datos existentes no se tocan.

/** Digito verificador (modulo 11) del cuerpo de un RUT, sin puntos ni guion: '0'-'9' o 'K'. */
function digitoVerificador(cuerpo) {
    const texto = String(cuerpo);
    let suma = 0;
    let factor = 2;
    for (let i = texto.length - 1; i >= 0; i--) {
        suma += Number(texto[i]) * factor;
        factor = factor === 7 ? 2 : factor + 1;
    }
    const resto = 11 - (suma % 11);
    return resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
}

/** Verdadero si el RUT tiene un digito verificador correcto. Acepta puntos, guion y espacios opcionales, y K o k. */
function rutValido(rut) {
    if (typeof rut !== 'string') return false;
    const limpio = rut.replace(/[\s.\-]/g, '').toUpperCase();
    if (!/^\d{7,8}[\dK]$/.test(limpio)) return false;
    return limpio.slice(-1) === digitoVerificador(limpio.slice(0, -1));
}

const MENSAJE_RUT_INVALIDO = 'El RUT no es válido: revisa el dígito verificador';

module.exports = { rutValido, digitoVerificador, MENSAJE_RUT_INVALIDO };
