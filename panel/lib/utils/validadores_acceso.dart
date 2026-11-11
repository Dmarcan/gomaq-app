import 'dart:convert' show utf8;

import 'rut.dart';

// Validadores de los formularios de acceso. Devuelven el mensaje de error o null si el valor
// está bien, que es lo que espera `TextFormField.validator`. Las reglas de la contraseña son las
// del servidor (backend/src/routes/registro.js): al menos 8 caracteres.

/// Largo mínimo de la contraseña, igual que en `registro.js`.
const largoMinimoPassword = 8;

String? validarObligatorio(String? valor, String mensaje) =>
    (valor == null || valor.trim().isEmpty) ? mensaje : null;

String? validarCorreo(String? valor) {
  final texto = valor?.trim() ?? '';
  if (texto.isEmpty) return 'Escribe tu correo.';
  // forma básica: algo@dominio.tld, sin espacios
  if (!RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$').hasMatch(texto)) {
    return 'Revisa el correo: falta el @ o el dominio.';
  }
  return null;
}

String? validarPassword(String? valor) {
  if (valor == null || valor.isEmpty) return 'Escribe una contraseña.';
  if (valor.length < largoMinimoPassword) return 'Debe tener al menos $largoMinimoPassword caracteres.';
  return null;
}

String? validarConfirmacion(String? valor, String password) {
  if (valor == null || valor.isEmpty) return 'Repite la contraseña.';
  if (valor != password) return 'Las contraseñas no coinciden.';
  return null;
}

/// El RUT es opcional: vacío vale; si se escribe, tiene que ser válido.
String? validarRutOpcional(String? valor) {
  final texto = valor?.trim() ?? '';
  if (texto.isEmpty) return null;
  if (texto.length > largoMaximoRut) return 'El RUT es demasiado largo.';
  return rutEsValido(texto) ? null : 'El RUT no es válido. Revisa el dígito verificador.';
}

/// Largos máximos de lo que se escribe (con espacios y signos).
const largoMaximoTelefono = 30;
const largoMaximoRut = 20;

/// El teléfono es opcional: vacío vale; si se escribe, de 8 a 15 dígitos (con +, espacios o guiones).
String? validarTelefonoOpcional(String? valor) {
  final texto = valor?.trim() ?? '';
  if (texto.isEmpty) return null;
  if (texto.length > largoMaximoTelefono) return 'El teléfono es demasiado largo.';
  if (!RegExp(r'^[+\d][\d\s\-()]*$').hasMatch(texto)) return 'Usa solo números, por ejemplo +56 9 1234 5678.';
  final digitos = texto.replaceAll(RegExp(r'\D'), '');
  if (digitos.length < 8 || digitos.length > 15) return 'El teléfono debe tener entre 8 y 15 dígitos.';
  return null;
}

/// El código que llega por correo o por mensaje: 6 dígitos (se aceptan espacios y guiones).
String? validarCodigo(String? valor) {
  final limpio = (valor ?? '').replaceAll(RegExp(r'[\s-]'), '');
  if (limpio.isEmpty) return 'Escribe el código.';
  if (!RegExp(r'^\d{6}$').hasMatch(limpio)) return 'El código tiene 6 dígitos.';
  return null;
}

/// La contraseña nueva: las reglas de siempre y, además, no más de 72 bytes (el servidor la trunca).
String? validarPasswordNueva(String? valor) {
  final error = validarPassword(valor);
  if (error != null) return error;
  if (utf8.encode(valor!).length > 72) return 'Demasiado larga (máximo 72 bytes).';
  return null;
}
