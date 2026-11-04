import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:gomaq_web/screens/panel/orden_detalle.dart' show OrdenDetalleScreen;
import 'package:gomaq_web/screens/panel/ordenes_screen.dart';
import 'package:gomaq_web/services/auth_service.dart';

void main() {
  pruebasDeLaPantalla();
  group('consultaPestanaOrdenes', () {
    test('Sin asignar pide las órdenes sin mecánico, la más antigua primero', () {
      expect(consultaPestanaOrdenes('sin_asignar'), {'sin_asignar': '1', 'dir': 'asc'});
    });

    test('En curso pide la lista de estados de trabajo', () {
      final q = consultaPestanaOrdenes('en_curso');
      expect(q['estado'], 'asignada,aceptada,en_camino,en_terreno,en_reparacion');
      expect(q.containsKey('sin_asignar'), isFalse);
    });

    test('Finalizadas pide solo ese estado', () {
      expect(consultaPestanaOrdenes('finalizadas'), {'estado': 'finalizada'});
    });

    test('Todas no filtra, salvo el estado que se elija', () {
      expect(consultaPestanaOrdenes('todas'), isEmpty);
      expect(consultaPestanaOrdenes('todas', estado: 'pendiente'), {'estado': 'pendiente'});
    });

    test('las pestañas son las cuatro del plan, en ese orden', () {
      expect([for (final p in pestanasOrdenes) p.id], ['sin_asignar', 'en_curso', 'finalizadas', 'todas']);
      expect([for (final p in pestanasOrdenes) p.etiqueta], ['Sin asignar', 'En curso', 'Finalizadas', 'Todas']);
    });
  });

  group('antiguedadOrden', () {
    final ahora = DateTime.utc(2026, 11, 4, 12, 0);

    test('minutos, horas y días', () {
      expect(antiguedadOrden('2026-11-04T11:59:30Z', ahora: ahora), 'ahora');
      expect(antiguedadOrden('2026-11-04T11:15:00Z', ahora: ahora), 'hace 45 min');
      expect(antiguedadOrden('2026-11-04T09:00:00Z', ahora: ahora), 'hace 3 h');
      expect(antiguedadOrden('2026-11-03T11:00:00Z', ahora: ahora), 'hace 1 día');
      expect(antiguedadOrden('2026-10-30T12:00:00Z', ahora: ahora), 'hace 5 días');
    });

    test('una fecha ilegible no rompe la fila', () {
      expect(antiguedadOrden(null, ahora: ahora), '-');
      expect(antiguedadOrden('no es fecha', ahora: ahora), '-');
    });
  });
}

void pruebasDeLaPantalla() {
  group('mezclarPaginaOrdenes', () {
    test('no repite las órdenes que ya estaban', () {
      final r = mezclarPaginaOrdenes(
        [{'id': 1}, {'id': 2}],
        [{'id': 2}, {'id': 3}, {'id': 3}, {'id': 4}],
      );
      expect([for (final o in r) (o as Map)['id']], [1, 2, 3, 4]);
    });

    test('con la lista vacía devuelve la página tal cual', () {
      expect(mezclarPaginaOrdenes([], [{'id': 5}]).length, 1);
    });
  });

  group('detalle como página', () {
    for (final id in <int?>[null, 0, -3]) {
      testWidgets('el id $id muestra "No encontramos esa orden" sin Reintentar', (tester) async {
        await tester.pumpWidget(MaterialApp(home: Scaffold(body: OrdenDetalleScreen(id: id))));
        await tester.pump();
        expect(find.text('No encontramos esa orden'), findsOneWidget);
        expect(find.text('Reintentar'), findsNothing);
      });
    }
  });

  group('pestaña en la URL', () {
    testWidgets('cambiar ?pestana= cambia la pestaña seleccionada', (tester) async {
      final auth = AuthService();
      Widget envolver(String pestana) => ChangeNotifierProvider<AuthService>.value(
            value: auth,
            child: MaterialApp(home: OrdenesScreen(pestanaInicial: pestana)),
          );
      await tester.pumpWidget(envolver('sin_asignar'));
      await tester.pump();
      expect(_seleccionada(tester), 'Sin asignar');
      await tester.pumpWidget(envolver('finalizadas'));
      await tester.pump();
      expect(_seleccionada(tester), 'Finalizadas');
      // una pestaña desconocida cae en Todas
      await tester.pumpWidget(envolver('inventada'));
      await tester.pump();
      expect(_seleccionada(tester), 'Todas');
    });
  });
}

/// Etiqueta de la pestaña marcada como seleccionada en el árbol de accesibilidad.
String _seleccionada(WidgetTester tester) {
  for (final x in pestanasOrdenes) {
    final nodo = tester.getSemantics(find.bySemanticsLabel(RegExp('^${x.etiqueta}')).first);
    if (nodo.getSemanticsData().flagsCollection.isSelected == ui.Tristate.isTrue) return x.etiqueta;
  }
  return '';
}
