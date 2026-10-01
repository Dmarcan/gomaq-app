import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/rut.dart';

void main() {
  group('rutEsValido', () {
    test('acepta RUT con el digito verificador correcto, con o sin puntos y guion', () {
      expect(rutEsValido('12.345.678-5'), isTrue);
      expect(rutEsValido('12345678-5'), isTrue);
      expect(rutEsValido('123456785'), isTrue);
      expect(rutEsValido('11.111.111-1'), isTrue);
    });

    test('rechaza un digito verificador incorrecto', () {
      expect(rutEsValido('12.345.678-9'), isFalse);
      expect(rutEsValido('11.111.111-2'), isFalse);
    });

    test('un digito cambiado en el cuerpo se detecta', () {
      expect(rutEsValido('12.345.679-5'), isFalse);
    });

    test('la K es un digito verificador valido, en mayuscula o minuscula', () {
      // 5.000.001-K: al calcular el digito, el resto da 10
      expect(rutEsValido('5.000.001-K'), isTrue);
      expect(rutEsValido('5000001-k'), isTrue);
      expect(rutEsValido('5.000.001-5'), isFalse);
    });

    test('un resto de 11 da verificador 0', () {
      // 5.000.006-0: al calcular el digito, el resto da 11
      expect(rutEsValido('5.000.006-0'), isTrue);
      expect(rutEsValido('5.000.006-K'), isFalse);
    });

    test('rechaza lo que no tiene forma de RUT', () {
      expect(rutEsValido(''), isFalse);
      expect(rutEsValido('abc'), isFalse);
      expect(rutEsValido('123'), isFalse);
      expect(rutEsValido('12.345.678-55'), isFalse);
      expect(rutEsValido('K1234567-8'), isFalse);
    });
  });
}
