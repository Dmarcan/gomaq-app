import '../theme/gomaq_theme.dart';
import 'formato.dart';

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
      final monto = Formato.clp(num.tryParse('${detalle['valorizacion_nueva']}'));
      final antes = num.tryParse('${detalle['valorizacion_anterior']}');
      return antes == null ? 'Valorizada en $monto' : 'Valorización cambiada de ${Formato.clp(antes)} a $monto';
    case 'linea_agregada':
      return 'Repuesto agregado';
    case 'linea_modificada':
      return 'Repuesto modificado';
    case 'linea_anulada':
      return 'Repuesto anulado';
    case 'factura_cargada':
      return 'Factura cargada';
    default:
      return 'Evento registrado';
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
