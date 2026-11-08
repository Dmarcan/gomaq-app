// Enlaces para "Como llegar" y cuerpo de la posicion del mecanico. Logica pura, sin plugins, para
// poder probarla sola (terreno/test/navegacion_test.dart).

/// true si el par es una coordenada usable: numeros finitos y dentro de rango. Un destino a medias o
/// fuera de rango no debe armar un enlace que lleve al mecanico a cualquier parte.
bool coordenadaValida(double? lat, double? lng) {
  if (lat == null || lng == null) return false;
  if (!lat.isFinite || !lng.isFinite) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

String _coord(double v) => v.toStringAsFixed(6);

/// Google Maps con la ruta en auto al destino. Con https abre la app si esta instalada y si no, el
/// navegador. Null si el destino no es valido.
Uri? enlaceGoogleMaps(double? lat, double? lng) {
  if (!coordenadaValida(lat, lng)) return null;
  return Uri.https('www.google.com', '/maps/dir/', {
    'api': '1',
    'destination': '${_coord(lat!)},${_coord(lng!)}',
    'travelmode': 'driving',
  });
}

/// Waze con navegacion directa al destino. Null si el destino no es valido.
Uri? enlaceWaze(double? lat, double? lng) {
  if (!coordenadaValida(lat, lng)) return null;
  return Uri.https('waze.com', '/ul', {
    'll': '${_coord(lat!)},${_coord(lng!)}',
    'navigate': 'yes',
  });
}

/// Cuerpo de `POST /api/ordenes-trabajo/:id/posicion` y de la `posicion` que viaja con el cambio a
/// en camino. La hora es la del momento en que se tomo la posicion (UTC): con ella el servidor decide
/// cual es la mas nueva y descarta las atrasadas. Null si la posicion no es valida.
Map<String, dynamic>? cuerpoPosicion({
  required double latitud,
  required double longitud,
  double? precisionMetros,
  required DateTime capturadaEn,
}) {
  if (!coordenadaValida(latitud, longitud)) return null;
  return {
    'latitud': latitud,
    'longitud': longitud,
    if (precisionMetros != null && precisionMetros.isFinite && precisionMetros >= 0) 'precision_m': precisionMetros.round(),
    'capturada_en': capturadaEn.toUtc().toIso8601String(),
  };
}
