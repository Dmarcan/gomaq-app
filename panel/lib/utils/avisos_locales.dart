// Lógica pura de los avisos locales del panel (capa 1): qué cambio entre dos lecturas merece un aviso.
// Sin widgets ni navegador, para probarla sola (panel/test/avisos_locales_test.dart).

/// Un aviso listo para mostrar. [tag] es fijo por evento: el navegador reemplaza el aviso anterior con el
/// mismo tag en vez de apilar otro.
class AvisoLocal {
  final String titulo;
  final String cuerpo;
  final String tag;
  final String ruta;
  const AvisoLocal({required this.titulo, required this.cuerpo, required this.tag, required this.ruta});
}

/// Contadores de `GET /api/dashboard/pendientes` que merecen aviso cuando suben: (clave, singular, plural).
const _contadoresAdmin = <(String, String, String)>[
  ('ot_sin_asignar', 'orden sin asignar', 'órdenes sin asignar'),
  ('asistencias_por_atender', 'asistencia por atender', 'asistencias por atender'),
  ('ot_por_valorizar', 'orden por valorizar', 'órdenes por valorizar'),
  ('cuentas_por_aprobar', 'cuenta por aprobar', 'cuentas por aprobar'),
  ('mantencion_proxima', 'mantención próxima', 'mantenciones próximas'),
  ('avisos_con_problemas', 'aviso con problemas', 'avisos con problemas'),
];

int _n(Object? v) => v is num ? v.toInt() : 0;

/// Aviso para administrativo y gerente: uno solo que junta todo lo que subió desde la lectura anterior.
/// Con [antes] nulo (primera lectura) solo se fija la base y no se avisa. Lo que baja o se mantiene no avisa.
List<AvisoLocal> avisosDePendientes(Map<String, dynamic>? antes, Map<String, dynamic>? ahora) {
  if (antes == null || ahora == null) return const [];
  final partes = <String>[];
  for (final (clave, singular, plural) in _contadoresAdmin) {
    final subio = _n(ahora[clave]) - _n(antes[clave]);
    if (subio > 0) partes.add('$subio ${subio == 1 ? singular : plural}');
  }
  if (partes.isEmpty) return const [];
  return [
    AvisoLocal(titulo: 'GOMAQ: hay novedades', cuerpo: partes.join(', '), tag: 'gomaq-pendientes', ruta: '/'),
  ];
}

/// Estados de la orden que se avisan al cliente, con su título. Sin nombres de personas ni del vehículo,
/// igual que el aviso push.
const _titulosCliente = <String, String>{
  'asignada': 'Asignamos un técnico a tu orden',
  'aceptada': 'El técnico aceptó tu orden',
  'en_camino': 'Tu técnico va en camino',
  'en_terreno': 'Tu equipo está en trabajo',
  'finalizada': 'Tu orden fue finalizada',
};

/// Avisos para el cliente: una orden que ya estaba en la lectura anterior y cambió a un estado de
/// [_titulosCliente]. Una orden nueva no avisa (la acaba de crear la propia persona). Con [antes] nulo
/// solo se fija la base.
List<AvisoLocal> avisosDeOrdenesCliente(List<dynamic>? antes, List<dynamic>? ahora) {
  if (antes == null || ahora == null) return const [];
  final previos = <int, String?>{};
  for (final o in antes) {
    if (o is Map && o['id'] is num) previos[(o['id'] as num).toInt()] = o['estado']?.toString();
  }
  final avisos = <AvisoLocal>[];
  for (final o in ahora) {
    if (o is! Map || o['id'] is! num) continue;
    final id = (o['id'] as num).toInt();
    if (!previos.containsKey(id)) continue;
    final estado = o['estado']?.toString();
    if (estado == previos[id]) continue;
    final titulo = _titulosCliente[estado];
    // en_reparacion es el mismo paso que en_terreno para el cliente: no vuelve a avisar
    if (titulo == null || (estado == 'en_terreno' && previos[id] == 'en_reparacion')) continue;
    avisos.add(AvisoLocal(titulo: titulo, cuerpo: 'Orden N.º $id', tag: 'ot-$id-$estado', ruta: '/portal'));
  }
  return avisos;
}
