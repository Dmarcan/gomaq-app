import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/numeros.dart';

void main() {
  test('un monto entero va como solo dígitos', () {
    expect(montoParaCampo(249900.0), '249900');
    expect(montoParaCampo(0), '0');
  });

  test('un monto con decimales es un error', () {
    expect(() => montoParaCampo(1234.5), throwsArgumentError);
  });
}
