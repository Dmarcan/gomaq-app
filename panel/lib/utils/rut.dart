// RUT chileno: formato y dígito verificador.
//
// Un RUT mal tipeado (un dígito cambiado) se guardaba tal cual y después no coincidía con la
// factura ni con el SII. El dígito verificador detecta casi todos esos errores al escribirlo.

/// Verdadero si [texto] es un RUT con dígito verificador correcto. Acepta "12.345.678-5",
/// "12345678-5" y "123456785", y la K en mayúscula o minúscula.
bool rutEsValido(String texto) {
  final limpio = texto.replaceAll('.', '').replaceAll('-', '').replaceAll(' ', '').toUpperCase();
  if (!RegExp(r'^\d{7,8}[\dK]$').hasMatch(limpio)) return false;
  final cuerpo = limpio.substring(0, limpio.length - 1);
  return _digitoVerificador(cuerpo) == limpio[limpio.length - 1];
}

String _digitoVerificador(String cuerpo) {
  var suma = 0;
  var multiplicador = 2;
  for (var i = cuerpo.length - 1; i >= 0; i--) {
    suma += int.parse(cuerpo[i]) * multiplicador;
    multiplicador = multiplicador == 7 ? 2 : multiplicador + 1;
  }
  final resto = 11 - (suma % 11);
  if (resto == 11) return '0';
  if (resto == 10) return 'K';
  return '$resto';
}
