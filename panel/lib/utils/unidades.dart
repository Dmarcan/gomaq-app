import 'formato.dart';

/// Una medida con su unidad, bien dicha: "1 unidad" y "3 unidades", "-3 unidades".
///
/// La unidad se guarda como texto libre ("unidad", "kg", "lt", "m"). Solo "unidad" lleva plural
/// simple; las demás (kg, lt, m, un) se dejan tal cual para no inventar plurales raros.
String medidaConUnidad(dynamic valor, String unidad, {String siVacio = ''}) {
  final texto = Formato.medida(valor, '', siVacio: '\u0000').trim();
  if (texto == '\u0000') return siVacio;
  return '$texto ${unidadSegunCantidad(valor, unidad)}'.trim();
}

/// "unidad" pasa a "unidades" salvo cuando la cantidad es exactamente 1 o -1.
String unidadSegunCantidad(dynamic valor, String unidad) {
  final limpia = unidad.trim();
  if (limpia.toLowerCase() != 'unidad') return limpia;
  final n = valor is num ? valor : num.tryParse('$valor'.replaceAll(',', '.'));
  if (n == null) return limpia;
  return n.abs() == 1 ? limpia : '${limpia}es';
}
