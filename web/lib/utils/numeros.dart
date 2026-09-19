// Lectura de números escritos como se hace en Chile.
//
// Los formularios leían los campos con `double.tryParse`, que solo entiende el punto como
// decimal. Alguien que escribe el costo de un repuesto como "18.500" (punto de miles, como en
// todo Chile) dejaba guardado 18,5 pesos, sin ningún aviso; y "12,5" no se leía como número.

final _soloNumero = RegExp(r'^-?[\d.,]+$');
final _conMiles = RegExp(r'^-?\d{1,3}(\.\d{3})+$');

/// Un número cualquiera: "12,5" y "12.5" son doce y medio.
///
/// El punto es decimal, no separador de miles: sirve para cantidades, kilos y metros, donde
/// "1.5" es uno y medio. Para pesos, [parsearMonto]. Devuelve null si no es un número.
double? parsearNumero(String texto) {
  final t = texto.trim();
  if (t.isEmpty || !_soloNumero.hasMatch(t)) return null;
  // con coma decimal, los puntos que haya son de miles ("1.500,5")
  final normalizado = t.contains(',') ? t.replaceAll('.', '').replaceAll(',', '.') : t;
  final n = double.tryParse(normalizado);
  return (n == null || n.isNaN || n.isInfinite) ? null : n;
}

/// Pesos: acá el punto SÍ es separador de miles, "18.500" son dieciocho mil quinientos.
///
/// Un punto solo se lee como miles cuando lo siguen exactamente tres dígitos ("18.500",
/// "1.250.000"); "12.5" sigue siendo un decimal. También acepta el signo "$" y espacios.
double? parsearMonto(String texto) {
  var t = texto.trim();
  if (t.startsWith(r'$')) t = t.substring(1).trim();
  if (t.isEmpty) return null;
  if (_conMiles.hasMatch(t)) return double.tryParse(t.replaceAll('.', ''));
  return parsearNumero(t);
}
