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
}
