import '../services/api_client.dart';
import 'ubicacion.dart';

/// Una dirección sugerida por el buscador (GET /api/geocodificar), con su punto en el mapa.
class SugerenciaDireccion {
  final String etiqueta;
  final Coordenada ubicacion;

  /// true cuando solo se pudo ubicar la calle o la comuna (no el número): conviene ajustar el punto.
  final bool aproximada;
  const SugerenciaDireccion(this.etiqueta, this.ubicacion, {this.aproximada = false});

  /// Devuelve null si la fila no trae etiqueta o coordenadas utilizables.
  static SugerenciaDireccion? fromJson(dynamic j) {
    if (j is! Map) return null;
    final etiqueta = j['etiqueta'];
    final lat = j['latitud'];
    final lng = j['longitud'];
    if (etiqueta is! String || etiqueta.trim().isEmpty || lat is! num || lng is! num) return null;
    return SugerenciaDireccion(etiqueta.trim(), Coordenada(lat.toDouble(), lng.toDouble()), aproximada: j['aproximada'] == true);
  }
}

/// Cómo se buscan direcciones. Se inyecta para poder probar la pantalla sin servidor.
typedef BuscarDirecciones = Future<List<SugerenciaDireccion>> Function(String texto);

/// Pide las sugerencias al backend (que consulta el geocodificador con la llave del servidor: el
/// panel nunca ve ninguna llave).
Future<List<SugerenciaDireccion>> buscarDireccionesEnServidor(String texto) async {
  final r = await ApiClient.instance.get('/api/geocodificar?texto=${Uri.encodeQueryComponent(texto)}');
  if (r is! List) return const [];
  return [
    for (final fila in r)
      if (SugerenciaDireccion.fromJson(fila) != null) SugerenciaDireccion.fromJson(fila)!,
  ];
}
