import 'dart:async';

import 'package:geolocator/geolocator.dart';

/// Un punto del mapa. Es lo que el panel manda al servidor como `latitud` y `longitud`.
class Coordenada {
  final double latitud;
  final double longitud;
  const Coordenada(this.latitud, this.longitud);

  /// "-38.7359, -72.5904": con punto decimal a propósito, como se escriben las coordenadas.
  String get texto => '${latitud.toStringAsFixed(4)}, ${longitud.toStringAsFixed(4)}';

  @override
  bool operator ==(Object other) => other is Coordenada && other.latitud == latitud && other.longitud == longitud;

  @override
  int get hashCode => Object.hash(latitud, longitud);
}

/// Por qué no se pudo obtener la ubicación. Ninguno es grave: el cliente siempre puede
/// seguir con la dirección escrita.
enum MotivoUbicacion { servicioApagado, permisoDenegado, permisoBloqueado, sinSenal, otro }

class UbicacionException implements Exception {
  final MotivoUbicacion motivo;
  const UbicacionException(this.motivo);

  @override
  String toString() => 'UbicacionException($motivo)';
}

/// Cómo se obtiene la ubicación actual. Se inyecta para poder probar la pantalla sin GPS.
typedef ObtenerUbicacion = Future<Coordenada> Function();

/// Texto para mostrar al usuario. Siempre termina diciendo que puede seguir sin ubicación.
String mensajeUbicacion(MotivoUbicacion motivo) {
  switch (motivo) {
    case MotivoUbicacion.servicioApagado:
      return 'La ubicación del dispositivo está apagada. Actívala o escribe la dirección.';
    case MotivoUbicacion.permisoDenegado:
      return 'No diste permiso de ubicación. Puedes intentarlo de nuevo o escribir la dirección.';
    case MotivoUbicacion.permisoBloqueado:
      return 'El permiso de ubicación está bloqueado. Habilítalo en los ajustes del navegador o del teléfono, o escribe la dirección.';
    case MotivoUbicacion.sinSenal:
      return 'No se pudo obtener tu ubicación a tiempo. Intenta de nuevo o escribe la dirección.';
    case MotivoUbicacion.otro:
      return 'No se pudo obtener tu ubicación. Escribe la dirección.';
  }
}

/// Pide la ubicación actual del dispositivo (GPS en el teléfono, el navegador en la web).
/// Funciona en web y en Android con el mismo código. En la web solo anda con HTTPS o en localhost.
Future<Coordenada> obtenerUbicacionActual() async {
  try {
    if (!await Geolocator.isLocationServiceEnabled()) {
      throw const UbicacionException(MotivoUbicacion.servicioApagado);
    }
    var permiso = await Geolocator.checkPermission();
    if (permiso == LocationPermission.denied) {
      permiso = await Geolocator.requestPermission();
    }
    if (permiso == LocationPermission.deniedForever) {
      throw const UbicacionException(MotivoUbicacion.permisoBloqueado);
    }
    if (permiso == LocationPermission.denied || permiso == LocationPermission.unableToDetermine) {
      throw const UbicacionException(MotivoUbicacion.permisoDenegado);
    }
    final p = await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 15)),
    );
    return Coordenada(p.latitude, p.longitude);
  } on UbicacionException {
    rethrow;
  } on TimeoutException {
    throw const UbicacionException(MotivoUbicacion.sinSenal);
  } on LocationServiceDisabledException {
    throw const UbicacionException(MotivoUbicacion.servicioApagado);
  } on PermissionDeniedException {
    throw const UbicacionException(MotivoUbicacion.permisoDenegado);
  } catch (_) {
    throw const UbicacionException(MotivoUbicacion.otro);
  }
}
