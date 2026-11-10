import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_mecanico/utils/envio_posicion.dart';

// 0,001 grados de latitud son unos 111 m
const _lat = -38.7359;
const _lng = -72.5904;
final _t0 = DateTime(2026, 11, 9, 12, 0, 0);
DateTime _despues(int segundos) => _t0.add(Duration(seconds: segundos));

void main() {
  group('distanciaMetros', () {
    test('un punto consigo mismo es 0 y un grado de latitud son unos 111 km', () {
      expect(distanciaMetros(_lat, _lng, _lat, _lng), 0);
      expect(distanciaMetros(0, 0, 1, 0), closeTo(111195, 200));
    });
  });

  group('debeEnviarPosicion', () {
    const enviada = (lat: _lat, lng: _lng);
    bool debe({int seg = 0, double dLat = 0, bool primera = false}) => debeEnviarPosicion(
      ultimoEnvio: primera ? null : _t0,
      ultimaEnviada: primera ? null : enviada,
      lat: _lat + dLat,
      lng: _lng,
      ahora: _despues(seg),
    );

    test('la primera siempre se envía', () {
      expect(debe(primera: true), isTrue);
    });

    test('antes de 60 s nunca, aunque se haya movido', () {
      expect(debe(seg: 30, dLat: 0.01), isFalse);
      expect(debe(seg: 59, dLat: 0.01), isFalse);
    });

    test('pasados 60 s, solo si se movió 25 m o más', () {
      expect(debe(seg: 60, dLat: 0), isFalse, reason: 'quieto');
      expect(debe(seg: 120, dLat: 0.0001), isFalse, reason: '~11 m');
      expect(debe(seg: 120, dLat: 0.0003), isTrue, reason: '~33 m');
    });

    test('quieto, el latido envía a los 5 min', () {
      expect(debe(seg: 299), isFalse);
      expect(debe(seg: 300), isTrue);
      expect(debe(seg: 900), isTrue);
    });
  });

  group('DetectorLlegada', () {
    DetectorLlegada detector() => DetectorLlegada(destinoLat: _lat, destinoLng: _lng);
    bool evaluar(DetectorLlegada d, int seg, {double dLat = 0, double? precision = 10}) =>
        d.evaluar(lat: _lat + dLat, lng: _lng, precisionM: precision, ahora: _despues(seg));

    test('avisa con dos posiciones dentro separadas por 30 s o más, y solo una vez', () {
      final d = detector();
      expect(evaluar(d, 0), isFalse, reason: 'la primera solo se anota');
      expect(evaluar(d, 20), isFalse, reason: 'faltan 30 s');
      expect(evaluar(d, 40), isTrue);
      expect(d.avisado, isTrue);
      expect(evaluar(d, 100), isFalse, reason: 'una sola vez por OT');
    });

    test('pasar cerca una sola vez no avisa: salir del radio reinicia', () {
      final d = detector();
      expect(evaluar(d, 0), isFalse);
      expect(evaluar(d, 15, dLat: 0.01), isFalse, reason: 'se alejó (~1,1 km)');
      expect(evaluar(d, 60), isFalse, reason: 'vuelve a empezar');
      expect(evaluar(d, 100), isTrue);
    });

    test('lejos del destino no avisa', () {
      final d = detector();
      for (var s = 0; s < 600; s += 60) {
        expect(evaluar(d, s, dLat: 0.005), isFalse);
      }
    });

    test('una posición con mala precisión (peor que 75 m) se descarta', () {
      final d = detector();
      expect(evaluar(d, 0, precision: 200), isFalse);
      expect(evaluar(d, 60, precision: 200), isFalse);
      expect(d.avisado, isFalse);
    });

    test('el radio crece con la precisión: a 190 m con 60 m de precisión cuenta como dentro', () {
      final d = detector();
      // 0,0017 grados son unos 189 m: fuera de 150 m, dentro de 150 + 60
      expect(evaluar(d, 0, dLat: 0.0017, precision: 60), isFalse);
      expect(evaluar(d, 40, dLat: 0.0017, precision: 60), isTrue);
      final otro = detector();
      expect(evaluar(otro, 0, dLat: 0.0017, precision: 10), isFalse);
      expect(evaluar(otro, 40, dLat: 0.0017, precision: 10), isFalse, reason: 'con buena precisión está fuera');
    });

    test('sin dato de precisión usa solo el radio', () {
      final d = detector();
      expect(evaluar(d, 0, precision: null), isFalse);
      expect(evaluar(d, 31, precision: null), isTrue);
    });
  });
}
