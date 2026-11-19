// Lógica pura del seguimiento del portal del cliente: pasos, horas, textos. Sin widgets para
// poder probarla sola (panel/test/seguimiento_test.dart).

/// Pasos del seguimiento tal como los ve el cliente, en orden.
const pasosParaCliente = [
  'Solicitud recibida',
  'Técnico asignado',
  'Técnico aceptó',
  'Técnico en camino',
  'Trabajando en tu equipo',
  'Finalizada',
];

/// Estados contados desde el lado del cliente.
String etiquetaParaCliente(String? estado) => switch (estado) {
      null => 'Recibida',
      'pendiente' => 'Recibida',
      'asignada' => 'Técnico asignado',
      'aceptada' => 'Técnico aceptó',
      'en_camino' => 'Técnico en camino',
      'en_terreno' || 'en_reparacion' => 'Trabajando en tu equipo',
      'finalizada' => 'Finalizada',
      _ => 'En proceso',
    };

/// Índice en [pasosParaCliente] de un estado de la orden. En terreno y en reparación son un
/// solo paso para el cliente; una asistencia sin orden (estado nulo) es la solicitud recibida.
/// Un estado que no está en la lista devuelve null: no se inventa un paso.
int? pasoParaCliente(String? estado) => switch (estado) {
      null || 'pendiente' => 0,
      'asignada' => 1,
      'aceptada' => 2,
      'en_camino' => 3,
      'en_terreno' || 'en_reparacion' => 4,
      'finalizada' => 5,
      _ => null,
    };

/// Hora en que la orden llegó al paso [i] (índice de [pasosParaCliente]), en hora local, o null
/// si el servidor no la tiene. El paso 4 usa la llegada a terreno.
DateTime? horaDePaso(Map<String, dynamic> orden, int i) {
  final clave = switch (i) {
    0 => 'fecha_creacion',
    1 => 'asignada_at',
    2 => 'aceptada_at',
    3 => 'en_camino_at',
    4 => 'llegada_at',
    5 => 'fecha_cierre',
    _ => null,
  };
  if (clave == null) return null;
  final valor = orden[clave];
  if (valor is! String) return null;
  return DateTime.tryParse(valor)?.toLocal();
}

/// "10:42". Nulo si no hay hora.
String? horaCorta(DateTime? hora) {
  if (hora == null) return null;
  final h = hora.hour.toString().padLeft(2, '0');
  final m = hora.minute.toString().padLeft(2, '0');
  return '$h:$m';
}

/// "10:42" si la hora es de hoy y "03/11 10:42" si es de otro día, para que un paso de ayer no
/// parezca de hoy. [ahora] se puede inyectar para probar sin depender del reloj.
String? horaConDia(DateTime? hora, {DateTime? ahora}) {
  if (hora == null) return null;
  final ref = ahora ?? DateTime.now();
  final corta = horaCorta(hora)!;
  if (hora.year == ref.year && hora.month == ref.month && hora.day == ref.day) return corta;
  final dia = hora.day.toString().padLeft(2, '0');
  final mes = hora.month.toString().padLeft(2, '0');
  return '$dia/$mes $corta';
}

/// Qué viene después del estado actual, o null si ya terminó o el estado no se conoce.
String? proximoPaso(String? estado) {
  final paso = pasoParaCliente(estado);
  if (paso == null) return null;
  final siguiente = paso + 1;
  return siguiente < pasosParaCliente.length ? pasosParaCliente[siguiente] : null;
}

/// "Paso 3 de 6: Técnico en camino, desde las 10:42" (o "desde el 03/11 10:42" si es de otro día;
/// sin la hora si el servidor no la tiene). Un estado desconocido dice solo "En proceso".
String resumenPaso(Map<String, dynamic> orden, {DateTime? ahora}) {
  final paso = pasoParaCliente(orden['estado'] as String?);
  if (paso == null) return 'En proceso';
  final conDia = horaConDia(horaDePaso(orden, paso), ahora: ahora);
  final desde = conDia == null ? '' : (conDia.contains('/') ? ', desde el $conDia' : ', desde las $conDia');
  return 'Paso ${paso + 1} de ${pasosParaCliente.length}: ${pasosParaCliente[paso]}$desde';
}

/// "11 min", "1 h 20 min" o "2 h". Redondea hacia arriba: nunca promete menos tiempo del real.
String duracionCorta(Duration d) {
  final minutos = (d.inSeconds / 60).ceil();
  if (minutos < 60) return '$minutos min';
  final h = minutos ~/ 60;
  final m = minutos % 60;
  return m == 0 ? '$h h' : '$h h $m min';
}

/// Hora de llegada estimada del técnico, o null si no corresponde mostrarla: la orden no va en
/// camino o el servidor no mandó la hora. Ejemplos:
///   "Llega en ~11 min (hora estimada 10:23, aproximada)"
///   "Debería llegar en cualquier momento"   (la hora estimada ya pasó)
/// El servidor entrega la hora de llegada absoluta; así el texto sigue siendo correcto aunque
/// la pantalla lleve rato abierta. [ahora] se puede inyectar para probar.
String? textoLlegada(Map<String, dynamic> orden, {DateTime? ahora}) {
  if (orden['estado'] != 'en_camino') return null;
  final valor = orden['eta_llegada_at'];
  if (valor is! String) return null;
  final llegada = DateTime.tryParse(valor)?.toLocal();
  if (llegada == null) return null;
  final restante = llegada.difference(ahora ?? DateTime.now());
  if (restante.inSeconds <= 0) return 'Debería llegar en cualquier momento';
  final hora = horaCorta(llegada);
  final aproximada = orden['eta_aproximada'] == true ? ', aproximada' : '';
  return 'Llega en ~${duracionCorta(restante)} (hora estimada $hora$aproximada)';
}

/// "Actualizada hace 3 min" según cuándo se calculó la hora de llegada, para que el cliente
/// pueda juzgar qué tan fresca es. Null si no hay dato.
String? textoActualizacionLlegada(Map<String, dynamic> orden, {DateTime? ahora}) {
  if (orden['estado'] != 'en_camino') return null;
  final valor = orden['eta_calculada_at'];
  if (valor is! String) return null;
  final calculada = DateTime.tryParse(valor)?.toLocal();
  if (calculada == null) return null;
  final minutos = (ahora ?? DateTime.now()).difference(calculada).inMinutes;
  if (minutos < 1) return 'Actualizada recién';
  return 'Actualizada hace ${duracionCorta(Duration(minutes: minutos))}';
}

/// "Ford Transit · ABCD12", o solo lo que haya. Nulo si no hay datos del vehículo.
String? descripcionVehiculo(Map<String, dynamic> orden) {
  final marcaModelo = [orden['vehiculo_marca'], orden['vehiculo_modelo']]
      .whereType<String>()
      .where((s) => s.trim().isNotEmpty)
      .join(' ');
  final patente = orden['vehiculo_patente'];
  final partes = [
    if (marcaModelo.isNotEmpty) marcaModelo,
    if (patente is String && patente.trim().isNotEmpty) patente.trim(),
  ];
  return partes.isEmpty ? null : partes.join(' · ');
}

/// Título de una orden sin jerga: "Reparación de EQ-12 (N.º 12)".
String tituloOrden(Map<String, dynamic> orden) =>
    'Reparación de ${orden['maquinaria_codigo']} (N.º ${orden['id']})';

/// Título de una asistencia pedida desde el portal que aún no tiene orden.
String tituloAsistencia(Map<String, dynamic> asistencia) =>
    'Solicitud de asistencia · ${asistencia['maquinaria_codigo']}';

/// Lo que se le dice al cliente sobre el cobro de una orden terminada.
String? etiquetaCobro(String? cobro) => switch (cobro) {
      'con_cobro' => 'Con cobro',
      'sin_cobro' => 'Sin cobro',
      'por_definir' => 'Cobro por confirmar',
      _ => null,
    };

/// Explicación breve para el cliente cuando el cobro aún no está definido: GOMAQ no ha decidido
/// qué repuestos de la reparación se cobran (el servidor lo marca 'por_definir').
String? explicacionCobro(String? cobro) =>
    cobro == 'por_definir' ? 'GOMAQ aún está definiendo qué repuestos se cobran.' : null;

/// Pestaña del portal que pide la URL (`?pestana=`): 0 equipos, 1 seguimiento, 2 historial, 3 empresa.
int pestanaDePortal(String? valor) => switch (valor) {
      'seguimiento' => 1,
      'historial' => 2,
      'empresa' => 3,
      _ => 0,
    };
