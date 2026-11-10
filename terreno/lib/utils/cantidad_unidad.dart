import 'formato.dart';

const _plurales = {
  'unidad': 'unidades',
  'litro': 'litros',
  'metro': 'metros',
  'kilo': 'kilos',
  'galon': 'galones',
  'galón': 'galones',
  'caja': 'cajas',
  'par': 'pares',
};

/// "-2 unidades", "2,5 litros", "1 unidad": cantidad sin decimales sobrantes (usa Formato.medida) y
/// la unidad en plural cuando corresponde. Las unidades que no se conocen (kg, m, lt) quedan tal cual.
String cantidadConUnidad(dynamic cantidad, String unidad) {
  final n = cantidad is num ? cantidad : num.tryParse('$cantidad');
  final u = unidad.trim();
  final plural = n != null && n.abs() != 1 ? (_plurales[u.toLowerCase()] ?? u) : u;
  return Formato.medida(cantidad, plural).trim();
}

/// Stock de un repuesto en la hoja "Cargar desde bodega" de Mi furgón: las dos cantidades con su
/// unidad, igual que en la lista del furgón ("Bodega: 10 unidades · Tu furgón: -3 unidades").
/// [detalle] es la variante que se ve al elegir el repuesto ("En bodega: ... · En tu furgón: ...").
String textoStockBodegaFurgon(dynamic bodega, dynamic furgon, String unidad, {bool detalle = false}) {
  final b = cantidadConUnidad(bodega, unidad);
  final f = cantidadConUnidad(furgon, unidad);
  return detalle ? 'En bodega: $b · En tu furgón: $f' : 'Bodega: $b · Tu furgón: $f';
}
