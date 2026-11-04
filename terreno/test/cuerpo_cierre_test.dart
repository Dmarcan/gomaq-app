import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_mecanico/utils/cuerpo_cierre.dart';

void main() {
  group('cuerpoFinalizar', () {
    test('tarea nueva: manda uuid_cliente, estado_equipo y la hora real del cierre', () {
      final cuerpo = cuerpoFinalizar({
        'uuid': 'a1b2',
        'persona_recibe': 'Ana',
        'sin_persona': false,
        'estado_equipo': estadoEquipoFueraDeServicio,
        'ocurrio_en': '2026-11-04T15:00:00.000Z',
      }, creadoEn: '2026-11-04T12:00:00.000', firmaPath: 'firmas/x.png');
      expect(cuerpo['uuid_cliente'], 'a1b2');
      expect(cuerpo['estado_equipo'], 'fuera_de_servicio');
      expect(cuerpo['ocurrio_en'], '2026-11-04T15:00:00.000Z');
      expect(cuerpo['persona_recibe'], 'Ana');
      expect(cuerpo['sin_persona'], false);
      expect(cuerpo['firma_path'], 'firmas/x.png');
    });

    test('tarea del APK anterior: sin estado_equipo, y la hora sale de creado_en en UTC', () {
      final cuerpo = cuerpoFinalizar({'uuid': 'u', 'sin_persona': true}, creadoEn: '2026-11-04T12:00:00.000');
      expect(cuerpo.containsKey('estado_equipo'), isFalse, reason: 'el servidor decide solo');
      expect(cuerpo['ocurrio_en'], DateTime.parse('2026-11-04T12:00:00.000').toUtc().toIso8601String());
      expect(cuerpo.containsKey('persona_recibe'), isFalse);
      expect(cuerpo.containsKey('firma_path'), isFalse);
    });

    test('respaldo de ocurrio_en: creado_en local se convierte a UTC con la misma hora', () {
      final cuerpo = cuerpoFinalizar({'uuid': 'u'}, creadoEn: '2026-11-04T17:14:25.525222');
      final esperado = DateTime.parse('2026-11-04T17:14:25.525222').toUtc();
      expect(DateTime.parse(cuerpo['ocurrio_en'] as String).toUtc(), esperado);
      expect((cuerpo['ocurrio_en'] as String).endsWith('Z'), isTrue);
    });

    test('si la tarea trae ocurrio_en, creado_en no la pisa', () {
      final cuerpo = cuerpoFinalizar({'uuid': 'u', 'ocurrio_en': '2026-11-04T15:00:00.000Z'}, creadoEn: '2026-11-05T01:00:00.000');
      expect(cuerpo['ocurrio_en'], '2026-11-04T15:00:00.000Z');
    });

    test('sin creado_en ni ocurrio_en no inventa una hora', () {
      final cuerpo = cuerpoFinalizar({'uuid': 'u'}, creadoEn: null);
      expect(cuerpo.containsKey('ocurrio_en'), isFalse);
    });

    test('un reintento arma el mismo cuerpo', () {
      final payload = {'uuid': 'u', 'estado_equipo': estadoEquipoOperativo, 'ocurrio_en': '2026-11-04T15:00:00.000Z'};
      expect(cuerpoFinalizar(payload, creadoEn: 'x'), cuerpoFinalizar(payload, creadoEn: 'y'));
    });
  });

  group('cuerpoDiagnostico', () {
    test('agrega uuid_cliente sin perder nada de lo que ya viajaba', () {
      final cuerpo = cuerpoDiagnostico({'uuid': 'u', 'estado': 'en_terreno', 'ocurrio_en': '2026-11-04T15:00:00.000Z'});
      expect(cuerpo['uuid'], 'u');
      expect(cuerpo['uuid_cliente'], 'u');
      expect(cuerpo['estado'], 'en_terreno');
      expect(cuerpo['ocurrio_en'], '2026-11-04T15:00:00.000Z');
    });

    test('sin uuid no agrega uuid_cliente', () {
      expect(cuerpoDiagnostico({'diagnostico': 'x'}).containsKey('uuid_cliente'), isFalse);
    });
  });
}
