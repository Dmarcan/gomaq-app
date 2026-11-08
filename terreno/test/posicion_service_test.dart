import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:gomaq_mecanico/services/posicion_service.dart';

void main() {
  test('sin seguimiento, detener es seguro y no hay orden seguida', () async {
    await PosicionService.detenerSeguimiento();
    expect(PosicionService.ordenSeguida, isNull);
  });

  test('una orden aun no sincronizada (id negativo) no inicia seguimiento', () async {
    await PosicionService.iniciarSeguimiento(-3);
    expect(PosicionService.ordenSeguida, isNull);
  });

  group('estadoDeUbicacion', () {
    test('con el GPS apagado manda el GPS, sin importar el permiso', () {
      for (final p in LocationPermission.values) {
        expect(estadoDeUbicacion(servicioActivo: false, permiso: p), EstadoUbicacion.servicioApagado);
      }
    });

    test('mientras se usa la app o siempre alcanza', () {
      expect(estadoDeUbicacion(servicioActivo: true, permiso: LocationPermission.whileInUse), EstadoUbicacion.ok);
      expect(estadoDeUbicacion(servicioActivo: true, permiso: LocationPermission.always), EstadoUbicacion.ok);
    });

    test('denegado se puede volver a pedir; bloqueado solo se arregla en Ajustes', () {
      expect(estadoDeUbicacion(servicioActivo: true, permiso: LocationPermission.denied), EstadoUbicacion.permisoDenegado);
      expect(estadoDeUbicacion(servicioActivo: true, permiso: LocationPermission.deniedForever), EstadoUbicacion.permisoBloqueado);
      expect(estadoDeUbicacion(servicioActivo: true, permiso: LocationPermission.unableToDetermine), EstadoUbicacion.desconocido);
    });
  });
}
