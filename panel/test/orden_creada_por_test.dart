import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/orden_detalle.dart' show textoCreadaPor;

// "Creada por" del detalle de la orden: una asistencia que pide el cliente desde el portal crea la OT sola, y el
// servidor guarda el rol de quien la creó (`creada_por_rol`, del evento de creación).
void main() {
  test('la orden que nace de una asistencia del cliente dice "Cliente (portal)"', () {
    expect(textoCreadaPor({'creada_por_rol': 'cliente'}), 'Cliente (portal)');
  });

  test('las demás: oficina, gerente y mecánico en terreno', () {
    expect(textoCreadaPor({'creada_por_rol': 'administrativo'}), 'Administrativo');
    expect(textoCreadaPor({'creada_por_rol': 'gerente'}), 'Gerente');
    expect(textoCreadaPor({'creada_por_rol': 'mecanico'}), 'Mecánico');
  });

  test('una orden antigua sin evento de creación, o con un rol desconocido, dice "No registrado"', () {
    expect(textoCreadaPor({'creada_por_rol': null}), 'No registrado');
    expect(textoCreadaPor({}), 'No registrado');
    expect(textoCreadaPor({'creada_por_rol': 'otro'}), 'No registrado');
  });
}
