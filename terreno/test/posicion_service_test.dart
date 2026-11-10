import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:gomaq_mecanico/services/posicion_service.dart';

void main() {
  test('sin seguimiento, detener es seguro y no hay orden seguida', () async {
    await PosicionService.detenerSeguimiento();
    expect(PosicionService.ordenSeguida, isNull);
  });

  test('detener el seguimiento limpia el aviso de llegada', () async {
    PosicionService.llegada.value = 7;
    await PosicionService.detenerSeguimiento();
    expect(PosicionService.llegada.value, isNull);
  });

  test('una orden aun no sincronizada (id negativo) no inicia seguimiento', () async {
    await PosicionService.iniciarSeguimiento(-3);
    expect(PosicionService.ordenSeguida, isNull);
  });

  group('accionTrasPedirPermiso', () {
    test('con permiso concedido se inicia el seguimiento', () {
      expect(accionTrasPedirPermiso(LocationPermission.whileInUse), AccionTrasPermiso.iniciarSeguimiento);
      expect(accionTrasPedirPermiso(LocationPermission.always), AccionTrasPermiso.iniciarSeguimiento);
    });

    test('si sigue negado se abren los ajustes de la app', () {
      expect(accionTrasPedirPermiso(LocationPermission.denied), AccionTrasPermiso.abrirAjustes);
      expect(accionTrasPedirPermiso(LocationPermission.deniedForever), AccionTrasPermiso.abrirAjustes);
    });

    test('si no se puede determinar no se hace nada', () {
      expect(accionTrasPedirPermiso(LocationPermission.unableToDetermine), AccionTrasPermiso.nada);
    });
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
