import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/utils/envio_factura.dart';

void main() {
  group('cuerpoAutorizacionEnvio', () {
    test('sin cambios y sin lista de fotos no manda nada: el servidor usa su texto y repite las fotos del último correo', () {
      expect(cuerpoAutorizacionEnvio(), isEmpty);
    });

    test('asunto y mensaje solo van si cambiaron', () {
      expect(cuerpoAutorizacionEnvio(asunto: 'Otro asunto'), {'asunto': 'Otro asunto'});
      expect(cuerpoAutorizacionEnvio(cuerpo: 'Hola'), {'cuerpo': 'Hola'});
    });

    test('una lista vacía de fotos se manda: significa "sin fotos" y no es lo mismo que no mandarla', () {
      final c = cuerpoAutorizacionEnvio(fotos: <int>{});
      expect(c.containsKey('foto_ids'), isTrue);
      expect(c['foto_ids'], isEmpty);
    });

    test('los ids van ordenados, sin importar cómo se marcaron', () {
      expect(cuerpoAutorizacionEnvio(fotos: {12, 3, 7})['foto_ids'], [3, 7, 12]);
    });

    test('junta texto y fotos', () {
      expect(cuerpoAutorizacionEnvio(asunto: 'A', cuerpo: 'B', fotos: {2, 1}), {'asunto': 'A', 'cuerpo': 'B', 'foto_ids': [1, 2]});
    });
  });
}
