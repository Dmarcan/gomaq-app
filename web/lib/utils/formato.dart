import 'package:intl/intl.dart';

/// Formato de fechas y montos, en un solo lugar.
///
/// Antes cada pantalla lo resolvía a mano: `'${f.day}/${f.month}/${f.year}'` en cuatro
/// archivos (sin ceros a la izquierda, así que salía "5/3/2026") y un `_clp()` duplicado
/// en dos pantallas del panel. Con `intl` además queda con locale chileno de verdad.
class Formato {
  Formato._();

  static final _fecha = DateFormat('dd/MM/yyyy', 'es_CL');
  static final _fechaHora = DateFormat('dd/MM/yyyy HH:mm', 'es_CL');
  static final _diaMesHora = DateFormat('dd/MM HH:mm', 'es_CL');

  /// 05/03/2026. Acepta DateTime o el String ISO que devuelve la API.
  static String fecha(dynamic valor, {String siVacio = '-'}) {
    final f = _aFecha(valor);
    return f == null ? siVacio : _fecha.format(f);
  }

  /// 05/03/2026 14:30
  static String fechaHora(dynamic valor, {String siVacio = '-'}) {
    final f = _aFecha(valor);
    return f == null ? siVacio : _fechaHora.format(f);
  }

  /// 05/03 14:30 — para los tramos de trabajo, donde el año sobra
  static String diaMesHora(dynamic valor, {String siVacio = '-'}) {
    final f = _aFecha(valor);
    return f == null ? siVacio : _diaMesHora.format(f);
  }

  /// $249.900 — pesos chilenos, sin decimales y con punto de miles.
  static String clp(num? valor, {String siVacio = '-'}) {
    if (valor == null) return siVacio;
    final formateado = NumberFormat.decimalPattern('es_CL').format(valor.round().abs());
    return '${valor < 0 ? '-' : ''}\$$formateado';
  }

  /// Duración en "2h 15m", a partir de minutos.
  static String duracion(int minutos) => '${minutos ~/ 60}h ${minutos % 60}m';

  static DateTime? _aFecha(dynamic valor) {
    if (valor == null) return null;
    if (valor is DateTime) return valor.toLocal();
    return DateTime.tryParse(valor.toString())?.toLocal();
  }
}
