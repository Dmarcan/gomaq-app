import 'dart:math' as math;

/// Reglas puras del envío de posición durante el viaje y de la detección de llegada. Sin plugins ni
/// red, para poder probarlas sin teléfono. Las usa `services/posicion_service.dart`.

/// Cada cuánto se envía como máximo la posición.
const entreEnvios = Duration(seconds: 60);

/// Aunque el teléfono no se mueva (un taco, una parada), se envía una posición cada tanto: así la
/// oficina ve "detenido" y no "sin posición". La hora estimada también se sigue actualizando.
const latidoEnvio = Duration(minutes: 5);

/// Movimiento mínimo para enviar sin esperar al latido.
const metrosParaEnviar = 25;

/// Distancia en línea recta entre dos puntos, en metros (haversine).
double distanciaMetros(double lat1, double lng1, double lat2, double lng2) {
  const radioTierra = 6371000.0;
  double rad(double g) => g * math.pi / 180;
  final dLat = rad(lat2 - lat1);
  final dLng = rad(lng2 - lng1);
  final h = math.pow(math.sin(dLat / 2), 2) + math.cos(rad(lat1)) * math.cos(rad(lat2)) * math.pow(math.sin(dLng / 2), 2);
  return 2 * radioTierra * math.asin(math.min(1.0, math.sqrt(h)));
}

/// Si esta posición debe enviarse al servidor.
/// - La primera siempre.
/// - Nunca antes de [entreEnvios] desde el último envío.
/// - Pasados [latidoEnvio], siempre (latido), esté quieto o no.
/// - Entre medio, solo si se movió [metrosParaEnviar] o más desde la última posición enviada.
bool debeEnviarPosicion({
  required DateTime? ultimoEnvio,
  required ({double lat, double lng})? ultimaEnviada,
  required double lat,
  required double lng,
  required DateTime ahora,
}) {
  if (ultimoEnvio == null || ultimaEnviada == null) return true;
  final transcurrido = ahora.difference(ultimoEnvio);
  if (transcurrido < entreEnvios) return false;
  if (transcurrido >= latidoEnvio) return true;
  return distanciaMetros(ultimaEnviada.lat, ultimaEnviada.lng, lat, lng) >= metrosParaEnviar;
}

/// Detecta que el mecánico llegó al destino de su OT. Todo ocurre en el teléfono: el destino ya está
/// en su OT (lo usa "Cómo llegar") y no se envía nada. No cambia el estado de la OT: solo avisa, y el
/// mecánico confirma con un toque. Avisa una sola vez.
///
/// Reglas: se descartan posiciones con precisión peor que [precisionMaxima]; cuenta como dentro si
/// está a [radioMetros] más la precisión del destino; y hacen falta dos posiciones seguidas dentro,
/// con al menos [separacion] entre ellas (así pasar por la calle de al lado o un salto de GPS no avisa).
class DetectorLlegada {
  static const radioMetros = 150.0;
  static const precisionMaxima = 75.0;
  static const separacion = Duration(seconds: 30);

  final double destinoLat;
  final double destinoLng;
  DateTime? _primeraDentro;
  bool _avisado = false;

  DetectorLlegada({required this.destinoLat, required this.destinoLng});

  bool get avisado => _avisado;

  /// true solo la vez que se confirma la llegada.
  bool evaluar({required double lat, required double lng, double? precisionM, required DateTime ahora}) {
    if (_avisado) return false;
    if (precisionM != null && precisionM > precisionMaxima) return false;
    final dentro = distanciaMetros(lat, lng, destinoLat, destinoLng) <= radioMetros + (precisionM ?? 0);
    if (!dentro) {
      _primeraDentro = null;
      return false;
    }
    final primera = _primeraDentro;
    if (primera == null) {
      _primeraDentro = ahora;
      return false;
    }
    if (ahora.difference(primera) >= separacion) {
      _avisado = true;
      return true;
    }
    return false;
  }
}
