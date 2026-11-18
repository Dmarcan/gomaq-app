import 'dart:math';

/// Motivo de un cambio a las lineas de repuesto de una orden. Las reglas son las del servidor
/// (backend/src/utils/auditoriaLinea.js): con la orden cerrada el motivo es obligatorio, con un
/// codigo de la lista y un texto de al menos 10 caracteres sin contar espacios. Aqui se validan
/// antes de enviar para avisar en el campo, pero quien decide es el servidor.

/// Códigos del servidor con su texto en español, en el orden en que se muestran.
const motivosCambio = <({String codigo, String etiqueta})>[
  (codigo: 'cliente_antiguo', etiqueta: 'Cliente antiguo'),
  (codigo: 'garantia', etiqueta: 'Garantía'),
  (codigo: 'error_registro', etiqueta: 'Error de registro'),
  (codigo: 'cortesia_comercial', etiqueta: 'Cortesía comercial'),
  (codigo: 'otro', etiqueta: 'Otro'),
];

/// Caracteres que debe tener el texto del motivo, sin contar espacios.
const minCaracteresMotivo = 10;

/// El texto de un código, o null si no está en la lista.
String? etiquetaMotivo(String? codigo) {
  for (final m in motivosCambio) {
    if (m.codigo == codigo) return m.etiqueta;
  }
  return null;
}

/// Aviso del campo del motivo, o null si está bien.
String? validarCodigoMotivo(String? codigo) =>
    etiquetaMotivo(codigo) == null ? 'Elige el motivo del cambio.' : null;

/// Aviso del campo de la explicación, o null si está bien. Los espacios no cuentan.
String? validarTextoMotivo(String? texto) {
  final caracteres = (texto ?? '').replaceAll(RegExp(r'\s'), '').length;
  if (caracteres == 0) return 'Explica el motivo del cambio.';
  if (caracteres < minCaracteresMotivo) {
    return 'Escribe al menos $minCaracteresMotivo caracteres ($caracteres de $minCaracteresMotivo).';
  }
  return null;
}

/// Aviso de una orden que ya tiene factura: no admite cambios en sus líneas.
String avisoOrdenFacturada(Object folio) =>
    'Esta orden ya tiene la factura folio $folio. Para dejar de cobrarla emite una nota de crédito en el SII.';

/// UUID versión 4 para la cabecera Idempotency-Key: si la respuesta se pierde y se reintenta con
/// la misma llave, el servidor no repite el cambio.
String nuevoUuid([Random? azar]) {
  final r = azar ?? Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  String hex(int desde, int hasta) => b.sublist(desde, hasta).map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${hex(0, 4)}-${hex(4, 6)}-${hex(6, 8)}-${hex(8, 10)}-${hex(10, 16)}';
}
