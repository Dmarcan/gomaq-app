import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:gomaq_web/widgets/fotos_orden.dart';

Widget _envolver(Widget hijo) => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: hijo)));

void main() {
  testWidgets('una orden sin fotos lo dice y avisa que no se adjuntan al correo', (tester) async {
    await tester.pumpWidget(_envolver(FotosOrden(ordenId: 1, cargador: () async => [])));
    await tester.pumpAndSettle();
    expect(find.text('Esta orden no tiene fotos.'), findsOneWidget);
    expect(find.text('Las fotos no se adjuntan al correo.'), findsOneWidget);
  });

  testWidgets('separa antes y después, y una URL que no carga muestra un ícono en vez de romperse', (tester) async {
    await tester.pumpWidget(_envolver(FotosOrden(
      ordenId: 1,
      cargador: () async => [
        {'tipo': 'antes', 'url': 'http://localhost:1/no-existe-a.jpg'},
        {'tipo': 'despues', 'url': 'http://localhost:1/no-existe-b.jpg'},
        {'tipo': 'despues', 'url': null},
      ],
    )));
    await tester.pumpAndSettle();
    expect(find.text('Antes'), findsOneWidget);
    expect(find.text('Después'), findsOneWidget);
    expect(find.byIcon(Icons.broken_image_outlined), findsNWidgets(3));
  });

  testWidgets('si falla la carga muestra el error y se puede recargar', (tester) async {
    var llamadas = 0;
    await tester.pumpWidget(_envolver(FotosOrden(
      ordenId: 1,
      cargador: () async {
        llamadas++;
        if (llamadas == 1) throw Exception('sin red');
        return [];
      },
    )));
    await tester.pumpAndSettle();
    expect(find.textContaining('No se pudieron cargar las fotos'), findsOneWidget);
    await tester.tap(find.text('Recargar'));
    await tester.pumpAndSettle();
    expect(find.text('Esta orden no tiene fotos.'), findsOneWidget);
    expect(llamadas, 2);
  });

  group('selección para el correo', () {
    List<Map<String, dynamic>> fotos({int antes = 2, int despues = 1, int primerId = 1}) => [
          for (var i = 0; i < antes; i++) {'id': primerId + i, 'tipo': 'antes', 'url': null},
          for (var i = 0; i < despues; i++) {'id': primerId + antes + i, 'tipo': 'despues', 'url': null},
        ];

    Future<List<Set<int>>> montar(
      WidgetTester tester,
      List<Map<String, dynamic>> lista, {
      Set<int>? inicial,
      double ancho = 375,
    }) async {
      tester.view.physicalSize = Size(ancho, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final cambios = <Set<int>>[];
      await tester.pumpWidget(_envolver(FotosOrden(
        ordenId: 1,
        cargador: () async => lista,
        seleccionable: true,
        seleccionInicial: inicial,
        alCambiarSeleccion: cambios.add,
      )));
      await tester.pumpAndSettle();
      return cambios;
    }

    testWidgets('arrancan todas marcadas, se avisa la selección inicial y se dice cuántas van', (tester) async {
      final cambios = await montar(tester, fotos());
      expect(cambios.last, {1, 2, 3});
      expect(find.text('3 de 3 fotos irán adjuntas al correo, junto a la factura.'), findsOneWidget);
      expect(find.byType(Checkbox), findsNWidgets(3));
      expect(find.text('Las fotos no se adjuntan al correo.'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('con la selección de un correo anterior arrancan solo esas (un reenvío la repite)', (tester) async {
      final cambios = await montar(tester, fotos(), inicial: {2});
      expect(cambios.last, {2});
      expect(find.text('1 de 3 fotos irán adjuntas al correo, junto a la factura.'), findsOneWidget);
    });

    testWidgets('si la selección anterior ya no existe, vuelven a quedar todas', (tester) async {
      final cambios = await montar(tester, fotos(), inicial: {99});
      expect(cambios.last, {1, 2, 3});
    });

    testWidgets('marcar y desmarcar una foto cambia la selección y el resumen', (tester) async {
      final cambios = await montar(tester, fotos());
      await tester.tap(find.bySemanticsLabel('Adjuntar al correo la foto 1 de antes'));
      await tester.pump();
      expect(cambios.last, {2, 3});
      expect(find.text('2 de 3 fotos irán adjuntas al correo, junto a la factura.'), findsOneWidget);
      await tester.tap(find.bySemanticsLabel('Adjuntar al correo la foto 1 de antes'));
      await tester.pump();
      expect(cambios.last, {1, 2, 3});
    });

    testWidgets('Ninguna deja el correo solo con la factura y Todas vuelve a marcarlas', (tester) async {
      final cambios = await montar(tester, fotos());
      await tester.tap(find.text('Ninguna'));
      await tester.pump();
      expect(cambios.last, isEmpty);
      expect(find.text('No se adjuntará ninguna foto: el correo llevará solo la factura.'), findsOneWidget);
      await tester.tap(find.text('Todas'));
      await tester.pump();
      expect(cambios.last, {1, 2, 3});
    });

    testWidgets('con más de 12 fotos arrancan 12 y no deja marcar la siguiente', (tester) async {
      final cambios = await montar(tester, fotos(antes: 14, despues: 0));
      expect(cambios.last.length, maxFotosCorreo);
      expect(cambios.last.contains(13), isFalse);
      await tester.ensureVisible(find.bySemanticsLabel('Adjuntar al correo la foto 13 de antes'));
      await tester.tap(find.bySemanticsLabel('Adjuntar al correo la foto 13 de antes'));
      await tester.pump();
      expect(find.text('Se pueden adjuntar hasta 12 fotos por correo.'), findsOneWidget);
      expect(cambios.last.length, maxFotosCorreo);
    });

    testWidgets('Recargar conserva lo que la persona eligió', (tester) async {
      final cambios = await montar(tester, fotos());
      await tester.tap(find.bySemanticsLabel('Adjuntar al correo la foto 2 de antes'));
      await tester.pump();
      expect(cambios.last, {1, 3});
      await tester.tap(find.text('Recargar'));
      await tester.pumpAndSettle();
      expect(cambios.last, {1, 3});
    });

    testWidgets('una foto sin id no se puede elegir', (tester) async {
      final cambios = await montar(tester, [
        {'tipo': 'antes', 'url': null},
        {'id': 5, 'tipo': 'despues', 'url': null},
      ]);
      expect(cambios.last, {5});
      expect(find.byType(Checkbox), findsOneWidget);
    });

    testWidgets('sin fotos no hay casillas ni resumen', (tester) async {
      final cambios = await montar(tester, []);
      expect(cambios.last, isEmpty);
      expect(find.byType(Checkbox), findsNothing);
      expect(find.textContaining('irán adjuntas'), findsNothing);
    });

    testWidgets('cada casilla es un objetivo táctil de al menos 44 px y se usa con teclado', (tester) async {
      await montar(tester, fotos());
      final alto = tester.getSize(find.bySemanticsLabel('Adjuntar al correo la foto 1 de antes')).height;
      expect(alto, greaterThanOrEqualTo(44));
    });
  });
}
