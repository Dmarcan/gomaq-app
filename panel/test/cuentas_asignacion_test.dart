import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/panel/orden_detalle.dart';
import 'package:gomaq_web/widgets/acciones_cuenta.dart';
import 'package:gomaq_web/widgets/asignar_mecanico.dart';

Widget _app(Widget hijo) => MaterialApp(home: Scaffold(body: hijo));

void main() {
  group('AccionesCuentaEquipo', () {
    final usuario = {'id': 4, 'nombre': 'Ana', 'estado_cuenta': 'activo'};

    testWidgets('la cuenta propia no tiene botones y dice (tu cuenta)', (t) async {
      await t.pumpWidget(_app(AccionesCuentaEquipo(
        usuario: usuario, esPropia: true, onClave: () {}, onDesactivar: () {}, onReactivar: () {},
      )));
      expect(find.text('(tu cuenta)'), findsOneWidget);
      expect(find.text('Contraseña'), findsNothing);
      expect(find.text('Desactivar'), findsNothing);
    });

    testWidgets('otra cuenta muestra Contraseña y Desactivar', (t) async {
      await t.pumpWidget(_app(AccionesCuentaEquipo(
        usuario: usuario, esPropia: false, onClave: () {}, onDesactivar: () {}, onReactivar: () {},
      )));
      expect(find.text('(tu cuenta)'), findsNothing);
      expect(find.text('Contraseña'), findsOneWidget);
      expect(find.text('Desactivar'), findsOneWidget);
    });
  });

  test('avisoOtAbiertas: singular, plural y sin órdenes', () {
    expect(avisoOtAbiertas(0), isNull);
    expect(avisoOtAbiertas('0'), isNull);
    expect(avisoOtAbiertas(null), isNull);
    expect(avisoOtAbiertas('1'), 'Tiene 1 orden abierta: reasígnalas antes o después de desactivar.');
    expect(avisoOtAbiertas(3), 'Tiene 3 órdenes abiertas: reasígnalas antes o después de desactivar.');
  });

  group('reasignar', () {
    test('solo el administrativo, con mecánico y sin finalizar', () {
      final enCurso = {'mecanico_id': 2, 'estado': 'asignada'};
      expect(puedeReasignar(esAdministrativo: true, orden: enCurso), isTrue);
      expect(puedeReasignar(esAdministrativo: false, orden: enCurso), isFalse);
      expect(puedeReasignar(esAdministrativo: true, orden: {'mecanico_id': 2, 'estado': 'finalizada'}), isFalse);
      expect(puedeReasignar(esAdministrativo: true, orden: {'mecanico_id': null, 'estado': 'pendiente'}), isFalse);
    });

    test('pide confirmación solo con la orden en viaje o en trabajo', () {
      for (final e in ['en_camino', 'en_terreno', 'en_reparacion']) {
        expect(reasignacionPideConfirmar(e), isTrue, reason: e);
      }
      for (final e in ['pendiente', 'asignada', 'aceptada']) {
        expect(reasignacionPideConfirmar(e), isFalse, reason: e);
      }
    });

    test('no ofrece al mecánico actual ni cuentas desactivadas', () {
      final lista = [
        {'id': 1, 'estado_cuenta': 'activo'},
        {'id': 2, 'estado_cuenta': 'activo'},
        {'id': 3, 'estado_cuenta': 'rechazado'},
      ];
      expect(mecanicosAsignables(lista, actualId: 1).map((m) => m['id']), [2]);
      expect(mecanicosAsignables(lista).map((m) => m['id']), [1, 2]);
    });
  });
}
