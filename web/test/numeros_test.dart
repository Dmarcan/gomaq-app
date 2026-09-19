import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/numeros.dart';

void main() {
  group('parsearNumero', () {
    test('entiende el punto y la coma como decimal', () {
      expect(parsearNumero('12.5'), 12.5);
      expect(parsearNumero('12,5'), 12.5);
    });

    test('un entero es un entero', () {
      expect(parsearNumero('8'), 8);
      expect(parsearNumero('  8  '), 8);
    });

    test('con coma decimal, los puntos son de miles', () {
      expect(parsearNumero('1.500,5'), 1500.5);
    });

    test('no lee como numero lo que no lo es', () {
      expect(parsearNumero(''), isNull);
      expect(parsearNumero('abc'), isNull);
      expect(parsearNumero('1e3'), isNull);
      expect(parsearNumero('12 kg'), isNull);
      expect(parsearNumero('1,2,3'), isNull);
    });

    test('un valor negativo se lee, para que el validador decida', () {
      expect(parsearNumero('-4'), -4);
    });
  });

  group('parsearMonto', () {
    test('el punto de miles no se lee como decimal: 18.500 son dieciocho mil quinientos', () {
      expect(parsearMonto('18.500'), 18500);
      expect(parsearMonto('1.250.000'), 1250000);
    });

    test('sin separador de miles', () {
      expect(parsearMonto('18500'), 18500);
    });

    test('acepta el signo peso y los espacios', () {
      expect(parsearMonto(r'$18.500'), 18500);
      expect(parsearMonto(r'$ 18.500'), 18500);
      expect(parsearMonto('  18500 '), 18500);
    });

    test('un punto sin tres digitos despues sigue siendo un decimal', () {
      expect(parsearMonto('12.5'), 12.5);
      expect(parsearMonto('1250.75'), 1250.75);
    });

    test('con coma decimal', () {
      expect(parsearMonto('18.500,50'), 18500.5);
      expect(parsearMonto('99,9'), 99.9);
    });

    test('lo que no es un numero es null', () {
      expect(parsearMonto(''), isNull);
      expect(parsearMonto(r'$'), isNull);
      expect(parsearMonto('mil'), isNull);
    });
  });
}
