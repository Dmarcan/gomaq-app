import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/notificaciones_screen.dart';
import 'package:gomaq_web/screens/panel/orden_detalle.dart';
import 'package:gomaq_web/theme/gomaq_theme.dart';

void main() {
  group('aviso sin proveedor de envío', () {
    final sinProveedor = {'estado': 'error', 'ultimo_error': 'Proveedor de email no configurado todavia', 'intentos': 3};
    final errorReal = {'estado': 'error', 'ultimo_error': 'timeout', 'intentos': 3};

    test('se ve apagado y no ofrece reintentar', () {
      expect(esAvisoSinProveedor(sinProveedor), isTrue);
      expect(puedeReintentarAviso(sinProveedor), isFalse);
      expect(colorPuntoAviso(sinProveedor), GomaqColors.grisApagado);
    });

    test('un error real queda como siempre', () {
      expect(esAvisoSinProveedor(errorReal), isFalse);
      expect(puedeReintentarAviso(errorReal), isTrue);
      expect(colorPuntoAviso(errorReal), GomaqColors.colorEstado('error'));
    });

    test('un aviso que no está en error no ofrece reintentar', () {
      expect(puedeReintentarAviso({'estado': 'enviado'}), isFalse);
    });
  });

  group('textoMecanicoOrden', () {
    test('dice el nombre, o Sin asignar', () {
      expect(textoMecanicoOrden({'mecanico_id': 4, 'mecanico_nombre': 'Juan Pérez'}), 'Juan Pérez');
      expect(textoMecanicoOrden({'mecanico_id': null, 'mecanico_nombre': null}), 'Sin asignar');
      expect(textoMecanicoOrden({}), 'Sin asignar');
      expect(textoMecanicoOrden({'mecanico_id': 4}), 'Mecánico asignado');
    });
  });
}
