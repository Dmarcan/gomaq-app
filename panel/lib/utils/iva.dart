// IVA de los precios de repuestos e insumos.
//
// Convención: el costo de un insumo se guarda SIEMPRE neto (sin IVA), en pesos enteros, igual que
// el ingreso de la rentabilidad. Quien tiene el precio con IVA (boleta o factura del proveedor
// con el total) marca la casilla y esta regla lo convierte antes de enviarlo.

/// Divisor del precio con IVA: 1,19 expresado como 1190 / 1000, para calcular solo con enteros.
const int _divisorIva = 1190;

/// Convierte un precio con IVA incluido a neto, en pesos enteros: bruto / 1,19.
///
/// Redondeo explícito: al peso más cercano, y la mitad exacta hacia arriba. Se calcula con enteros
/// (nada de `double`), así 119 da 100 y 1190 da 1000 sin error de coma flotante.
/// Lanza [ArgumentError] si el precio es negativo.
int netoDesdePrecioConIva(int precioConIva) {
  if (precioConIva < 0) {
    throw ArgumentError.value(precioConIva, 'precioConIva', 'El precio no puede ser negativo');
  }
  // neto = bruto * 1000 / 1190; redondeo half-up: floor((2 * num + den) / (2 * den))
  return (2 * precioConIva * 1000 + _divisorIva) ~/ (2 * _divisorIva);
}

/// El costo que se envía al servidor: el monto tal cual, o su neto si el precio incluye IVA.
/// Null si el monto está vacío o no es válido. Un monto con decimales se devuelve sin tocar, para que
/// el servidor lo rechace con su mensaje de siempre (los pesos son enteros) en vez de guardarlo mal.
num? costoNetoParaGuardar(double? monto, {required bool incluyeIva}) {
  if (monto == null || monto.isNaN || monto.isInfinite || monto < 0) return null;
  if (monto != monto.truncateToDouble()) return monto;
  final entero = monto.toInt();
  return incluyeIva ? netoDesdePrecioConIva(entero) : entero;
}
