import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_mecanico/models/orden_trabajo.dart';
import 'package:gomaq_mecanico/utils/navegacion.dart';

void main() {
  group('coordenadaValida', () {
    test('acepta un par dentro de rango, incluidos los limites y el cero', () {
      expect(coordenadaValida(-38.7359, -72.5904), isTrue);
      expect(coordenadaValida(90, 180), isTrue);
      expect(coordenadaValida(-90, -180), isTrue);
      expect(coordenadaValida(0, 0), isTrue, reason: 'el cero es una coordenada, no "falta"');
    });

    test('rechaza lo incompleto, fuera de rango y no finito', () {
      expect(coordenadaValida(null, -72.5), isFalse);
      expect(coordenadaValida(-38.7, null), isFalse);
      expect(coordenadaValida(90.001, 0), isFalse);
      expect(coordenadaValida(0, -180.001), isFalse);
      expect(coordenadaValida(double.nan, 0), isFalse);
      expect(coordenadaValida(0, double.infinity), isFalse);
    });
  });

  group('enlaces de navegacion', () {
    test('Google Maps: ruta en auto con la coordenada del destino', () {
      final uri = enlaceGoogleMaps(-38.7359, -72.5904)!;
      expect(uri.scheme, 'https');
      expect(uri.host, 'www.google.com');
      expect(uri.path, '/maps/dir/');
      expect(uri.queryParameters['api'], '1');
      expect(uri.queryParameters['destination'], '-38.735900,-72.590400');
      expect(uri.queryParameters['travelmode'], 'driving');
    });

    test('Waze: navegacion directa al destino', () {
      final uri = enlaceWaze(-38.7359, -72.5904)!;
      expect(uri.scheme, 'https');
      expect(uri.host, 'waze.com');
      expect(uri.path, '/ul');
      expect(uri.queryParameters['ll'], '-38.735900,-72.590400');
      expect(uri.queryParameters['navigate'], 'yes');
    });

    test('un destino invalido o ausente no arma ningun enlace', () {
      expect(enlaceGoogleMaps(null, null), isNull);
      expect(enlaceWaze(null, null), isNull);
      expect(enlaceGoogleMaps(95, 0), isNull);
      expect(enlaceWaze(0, 200), isNull);
    });

    test('la coma de la coordenada viaja bien codificada en el enlace', () {
      expect(enlaceGoogleMaps(-38.7, -72.5).toString(), contains('destination=-38.700000%2C-72.500000'));
    });
  });

  group('cuerpoPosicion', () {
    final hora = DateTime.utc(2026, 11, 8, 13, 30, 5);

    test('trae coordenadas, precision redondeada y la hora en UTC', () {
      final c = cuerpoPosicion(latitud: -38.7359, longitud: -72.5904, precisionMetros: 12.6, capturadaEn: hora)!;
      expect(c['latitud'], -38.7359);
      expect(c['longitud'], -72.5904);
      expect(c['precision_m'], 13);
      expect(c['capturada_en'], '2026-11-08T13:30:05.000Z');
    });

    test('la hora local se manda convertida a UTC', () {
      final c = cuerpoPosicion(latitud: 1, longitud: 2, capturadaEn: hora.toLocal())!;
      expect(c['capturada_en'], '2026-11-08T13:30:05.000Z');
    });

    test('sin precision valida no la manda', () {
      expect(cuerpoPosicion(latitud: 1, longitud: 2, capturadaEn: hora)!.containsKey('precision_m'), isFalse);
      expect(cuerpoPosicion(latitud: 1, longitud: 2, precisionMetros: -1, capturadaEn: hora)!.containsKey('precision_m'), isFalse);
      expect(cuerpoPosicion(latitud: 1, longitud: 2, precisionMetros: double.nan, capturadaEn: hora)!.containsKey('precision_m'), isFalse);
    });

    test('una posicion invalida no se manda', () {
      expect(cuerpoPosicion(latitud: 99, longitud: 2, capturadaEn: hora), isNull);
      expect(cuerpoPosicion(latitud: double.nan, longitud: 2, capturadaEn: hora), isNull);
    });
  });

  group('OrdenTrabajo y el destino', () {
    Map<String, dynamic> base() => {'id': 1, 'maquinaria_id': 2, 'estado': 'aceptada'};

    test('el servidor manda el destino como texto: se convierte a numero', () {
      final o = OrdenTrabajo.fromApiJson({...base(), 'destino_lat': '-38.735900', 'destino_lng': '-72.590400'});
      expect(o.destinoLat, -38.7359);
      expect(o.destinoLng, -72.5904);
    });

    test('acepta numeros y nulos, y un texto raro no rompe', () {
      expect(OrdenTrabajo.fromApiJson({...base(), 'destino_lat': -38.7, 'destino_lng': -72.5}).destinoLat, -38.7);
      final sin = OrdenTrabajo.fromApiJson(base());
      expect(sin.destinoLat, isNull);
      expect(sin.destinoLng, isNull);
      expect(OrdenTrabajo.fromApiJson({...base(), 'destino_lat': 'abc'}).destinoLat, isNull);
    });

    test('un telefono con la base anterior (sin las columnas) lee la OT sin destino', () {
      final o = OrdenTrabajo.fromLocalMap({'id': 1, 'maquinaria_id': 2, 'estado': 'aceptada', 'facturable': 0});
      expect(o.destinoLat, isNull);
    });

    test('el destino sobrevive al viaje servidor -> base local -> pantalla', () {
      final desdeApi = OrdenTrabajo.fromApiJson({...base(), 'destino_lat': '-38.7359', 'destino_lng': '-72.5904'});
      final local = desdeApi.toLocalMap();
      expect(local['destino_lat'], -38.7359);
      final deVuelta = OrdenTrabajo.fromLocalMap({...local, 'facturable': 0});
      expect(deVuelta.destinoLat, -38.7359);
      expect(deVuelta.destinoLng, -72.5904);
    });
  });
}
