import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/motivo_cambio.dart';

void main() {
  group('motivo de un cambio de línea', () {
    test('la lista es la del servidor, con su texto en español', () {
      expect(motivosCambio.map((m) => m.codigo), ['cliente_antiguo', 'garantia', 'error_registro', 'cortesia_comercial', 'otro']);
      expect(motivosCambio.map((m) => m.etiqueta), ['Cliente antiguo', 'Garantía', 'Error de registro', 'Cortesía comercial', 'Otro']);
      expect(etiquetaMotivo('garantia'), 'Garantía');
      expect(etiquetaMotivo('inventado'), isNull);
      expect(etiquetaMotivo(null), isNull);
    });

    test('el código es obligatorio y de la lista', () {
      expect(validarCodigoMotivo(null), isNotNull);
      expect(validarCodigoMotivo('inventado'), isNotNull);
      expect(validarCodigoMotivo('otro'), isNull);
    });

    test('la explicación pide 10 caracteres sin contar espacios', () {
      expect(validarTextoMotivo(null), 'Explica el motivo del cambio.');
      expect(validarTextoMotivo('     '), 'Explica el motivo del cambio.');
      expect(validarTextoMotivo('abcdefghi'), contains('9 de 10'));
      expect(validarTextoMotivo('a b c d e f g h i'), contains('9 de 10'));
      expect(validarTextoMotivo('abcdefghij'), isNull);
      expect(validarTextoMotivo('  Se cobra por garantía  '), isNull);
    });

    test('el aviso de orden facturada manda a la nota de crédito', () {
      expect(
        avisoOrdenFacturada('F-1'),
        'Esta orden ya tiene la factura folio F-1. Para dejar de cobrarla emite una nota de crédito en el SII.',
      );
    });
  });

  group('llave de idempotencia', () {
    test('es un UUID versión 4 bien formado', () {
      final uuid = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
      for (var i = 0; i < 50; i++) {
        expect(uuid.hasMatch(nuevoUuid()), isTrue);
      }
      expect(uuid.hasMatch(nuevoUuid(Random(7))), isTrue);
    });

    test('dos llaves seguidas no se repiten', () {
      expect(nuevoUuid(), isNot(nuevoUuid()));
    });
  });
}
