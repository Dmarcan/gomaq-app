import 'formato.dart';

/// Equipos de GET /api/maquinarias/mias/historicos que ya no están con el cliente: los que tuvo
/// antes. Los vigentes (`actual == true`) ya salen en "Mis equipos".
List<Map<String, dynamic>> soloEquiposAnteriores(dynamic datos) {
  if (datos is! List) return const [];
  return [
    for (final e in datos)
      if (e is Map && e['actual'] != true) Map<String, dynamic>.from(e),
  ];
}

/// "Documentos entre 02/02/2026 y 10/02/2026" (o de un solo día si el primero y el último coinciden).
String rangoDocumentos(dynamic primero, dynamic ultimo) {
  final desde = Formato.fecha(primero, siVacio: '');
  final hasta = Formato.fecha(ultimo, siVacio: '');
  if (desde.isEmpty && hasta.isEmpty) return 'Con documentos tuyos';
  if (desde.isEmpty || desde == hasta) return 'Documentos del ${hasta.isEmpty ? desde : hasta}';
  return 'Documentos entre $desde y $hasta';
}
