import 'package:gomaq_comun/push.dart';
import 'package:test/test.dart';

void main() {
  test('un MensajePush sin datos trae un mapa vacio y sin textos', () {
    const m = MensajePush();
    expect(m.titulo, isNull);
    expect(m.cuerpo, isNull);
    expect(m.data, isEmpty);
  });

  test('un MensajePush conserva el data que arma el backend', () {
    const m = MensajePush(titulo: 'OT #5', cuerpo: 'Nueva orden', data: {'tipo': 'ot_asignada', 'orden_trabajo_id': '5'});
    expect(m.data['orden_trabajo_id'], '5');
  });
}
