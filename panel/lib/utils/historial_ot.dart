import '../theme/gomaq_theme.dart';
import 'formato.dart';
import 'motivo_cambio.dart';

/// Textos de la línea de tiempo de una orden (GET /api/ordenes-trabajo/:id/historial).
///
/// Viven aparte de la pantalla para poder probarlos sin armar el diálogo: cada tipo de evento
/// del backend (utils/eventosOt.js) se dice en una frase corta.

/// Qué pasó, en español. `evento` es una fila del historial tal como la entrega la API.
String textoEventoOt(Map<String, dynamic> evento) {
  final detalle = evento['detalle'] is Map ? evento['detalle'] as Map : const {};
  final anterior = evento['estado_anterior'] as String?;
  final nuevo = evento['estado_nuevo'] as String?;
  final aplicado = evento['aplicado'] != false;

  switch (evento['tipo']) {
    case 'creacion':
      if (evento['origen'] == 'terreno') return 'Creada en terreno';
      return detalle['solicitud_id'] != null ? 'Creada a partir de una solicitud del cliente' : 'Creada';
    case 'asignacion':
      final nombre = detalle['mecanico_nuevo_nombre'];
      final destino = nombre == null ? 'otro mecánico' : '$nombre';
      final anteriorId = detalle['mecanico_anterior_id'];
      // reasignada solo si ya había un mecánico y es otro
      final esReasignacion = anteriorId != null && '$anteriorId' != '${detalle['mecanico_nuevo_id']}';
      return esReasignacion ? 'Reasignada a $destino' : 'Asignada a $destino';
    case 'toma':
      return 'Tomada por el mecánico';
    case 'cambio_estado':
      final hasta = GomaqColors.etiquetaEstado(nuevo);
      if (!aplicado) {
        // mismo estado: se repitió; distinto: el cambio llegó cuando la orden ya iba más adelante
        if (anterior == nuevo) return 'Se repitió el estado $hasta (la orden ya estaba en ese estado)';
        return 'Estado: $hasta (llegó atrasado, la orden ya estaba más adelante)';
      }
      if (anterior == null) return 'Estado: pasó a $hasta';
      return 'Estado: de ${GomaqColors.etiquetaEstado(anterior)} a $hasta';
    case 'cierre':
      return 'Cerrada';
    case 'valorizacion':
      // el servidor anula la valorización cuando un cambio de líneas altera lo que se cobra
      if (detalle['anulada'] == true) return 'Valorización anulada por un cambio en las líneas facturables';
      final monto = Formato.clp(num.tryParse('${detalle['valorizacion_nueva']}'));
      final antes = num.tryParse('${detalle['valorizacion_anterior']}');
      return antes == null ? 'Valorizada en $monto' : 'Valorización cambiada de ${Formato.clp(antes)} a $monto';
    case 'linea_agregada':
      return 'Repuesto agregado: ${_nombreLinea(detalle)}${_motivoDelCambio(detalle)}';
    case 'linea_modificada':
      return '${_cambioDeLinea(detalle)}${_motivoDelCambio(detalle)}';
    case 'linea_anulada':
      return 'Repuesto anulado: ${_nombreLinea(detalle)}${_motivoDelCambio(detalle)}';
    case 'factura_cargada':
      final folio = detalle['folio'];
      return folio == null || '$folio'.isEmpty ? 'Factura cargada' : 'Factura folio $folio cargada';
    case 'factura_anulada':
      final folioAnulada = detalle['folio'];
      final nombre = folioAnulada == null || '$folioAnulada'.isEmpty ? 'Factura' : 'Factura folio $folioAnulada';
      return '$nombre anulada${_motivoDelCambio(detalle)}';
    default:
      return 'Evento registrado';
  }
}

String _nombreLinea(Map detalle) {
  final nombre = detalle['insumo'];
  return nombre == null || '$nombre'.trim().isEmpty ? 'sin nombre' : '$nombre';
}

/// ". Motivo: Garantía: texto" cuando el cambio lo registró; vacío si no hubo motivo.
String _motivoDelCambio(Map detalle) {
  final etiqueta = etiquetaMotivo(detalle['motivo_codigo'] as String?);
  final texto = (detalle['motivo'] as String?)?.trim() ?? '';
  if (etiqueta == null && texto.isEmpty) return '';
  if (etiqueta == null) return '. Motivo: $texto';
  return texto.isEmpty ? '. Motivo: $etiqueta' : '. Motivo: $etiqueta: $texto';
}

String _valorFacturable(dynamic valor) => switch (valor) {
      'si' => 'Sí',
      'no' => 'No',
      'pendiente' => 'Por decidir',
      _ => '$valor',
    };

/// Qué cambió en una línea: un evento por campo, con el valor de antes y el de después.
String _cambioDeLinea(Map detalle) {
  final nombre = _nombreLinea(detalle);
  final antes = detalle['antes'];
  final despues = detalle['despues'];
  switch (detalle['campo']) {
    case 'facturable':
      return 'Facturable de $nombre: ${_valorFacturable(antes)} a ${_valorFacturable(despues)}';
    case 'precio_unitario':
      final de = Formato.clp(num.tryParse('$antes'), siVacio: 'sin precio');
      final a = Formato.clp(num.tryParse('$despues'), siVacio: 'sin precio');
      return 'Precio de $nombre: $de a $a';
    case 'cantidad':
      return 'Cantidad de $nombre: $antes a $despues';
    case 'descripcion':
      return 'Descripción de $nombre cambiada';
    default:
      return 'Repuesto modificado: $nombre';
  }
}

/// "sincronizado a las 14:35" cuando el evento viajó por la cola offline y llegó tarde; si llegó
/// otro día que el que ocurrió, agrega la fecha: "sincronizado el 05/11 a las 15:00". Null si se
/// registró al momento.
String? textoSincronizacionOt(Map<String, dynamic> evento) {
  if (evento['sincronizado_tarde'] != true) return null;
  final registrado = DateTime.tryParse('${evento['registrado_en']}')?.toLocal();
  if (registrado == null) return null;
  final ocurrio = DateTime.tryParse('${evento['ocurrio_en']}')?.toLocal();
  String dos(int n) => n.toString().padLeft(2, '0');
  final hora = '${dos(registrado.hour)}:${dos(registrado.minute)}';
  final otroDia = ocurrio != null &&
      (ocurrio.year != registrado.year || ocurrio.month != registrado.month || ocurrio.day != registrado.day);
  return otroDia ? 'sincronizado el ${dos(registrado.day)}/${dos(registrado.month)} a las $hora' : 'sincronizado a las $hora';
}

/// Quién lo hizo. Los eventos reconstruidos al crear el historial no saben quién fue.
String? quienHizoEventoOt(Map<String, dynamic> evento) {
  final nombre = evento['usuario_nombre'] as String?;
  if (nombre != null && nombre.isNotEmpty) return nombre;
  return evento['origen'] == 'migracion' ? 'Registro anterior al historial' : null;
}
