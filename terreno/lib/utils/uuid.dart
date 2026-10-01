import 'dart:math';

final _aleatorio = Random.secure();

/// UUID v4 (RFC 4122) para marcar cada tarea de la cola offline.
///
/// El servidor lo guarda en la fila que crea: si la tarea se reintenta porque se perdio la
/// respuesta, reconoce el UUID y no la duplica. Se genera aca para no sumar una dependencia
/// por diez lineas.
String generarUuid() {
  final bytes = List<int>.generate(16, (_) => _aleatorio.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-'
      '${hex.substring(16, 20)}-${hex.substring(20)}';
}
