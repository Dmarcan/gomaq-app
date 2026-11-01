import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/cliente/cliente_seguimiento_screen.dart';

void main() {
  group('pasos del seguimiento para el cliente', () {
    test('cada estado de la orden cae en su paso', () {
      expect(pasoParaCliente(null), 0);
      expect(pasoParaCliente('pendiente'), 0);
      expect(pasoParaCliente('asignada'), 1);
      expect(pasoParaCliente('aceptada'), 2);
      expect(pasoParaCliente('en_camino'), 3);
      expect(pasoParaCliente('en_terreno'), 4);
      expect(pasoParaCliente('en_reparacion'), 4);
      expect(pasoParaCliente('finalizada'), 5);
    });

    test('hay seis pasos, en el orden decidido', () {
      expect(pasosParaCliente, [
        'Solicitud recibida',
        'Técnico asignado',
        'Técnico aceptó',
        'Técnico en camino',
        'Trabajando en tu equipo',
        'Finalizada',
      ]);
    });

    test('las etiquetas del chip coinciden con los pasos', () {
      expect(etiquetaParaCliente('aceptada'), 'Técnico aceptó');
      expect(etiquetaParaCliente('en_terreno'), 'Trabajando en tu equipo');
      expect(etiquetaParaCliente('en_reparacion'), 'Trabajando en tu equipo');
      expect(etiquetaParaCliente('asignada'), 'Técnico asignado');
    });
  });
}
