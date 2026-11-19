import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/widgets/tabla_ordenable.dart';

const _columnas = <ColumnaTabla>[
  (id: 'equipo', titulo: 'Equipo', flex: 3, orden: 'codigo', minAncho: 0),
  (id: 'gasto', titulo: 'Gasto', flex: 2, orden: 'gasto', minAncho: 0),
  (id: 'nota', titulo: 'Nota', flex: 2, orden: null, minAncho: 0),
];

Widget _montar({String? ordenActual, bool ascendente = true, ValueChanged<String>? alOrdenar}) {
  return MaterialApp(
    home: Scaffold(
      body: EncabezadoTablaOrdenable(
        columnas: _columnas,
        ordenActual: ordenActual,
        ascendente: ascendente,
        alOrdenar: alOrdenar ?? (_) {},
        alinearDerecha: (c) => c.id == 'gasto',
      ),
    ),
  );
}

void main() {
  testWidgets('tocar una columna ordenable avisa su nombre del servidor', (tester) async {
    final tocadas = <String>[];
    await tester.pumpWidget(_montar(alOrdenar: tocadas.add));
    await tester.tap(find.text('Gasto'));
    await tester.tap(find.text('Equipo'));
    expect(tocadas, ['gasto', 'codigo']);
  });

  testWidgets('una columna sin orden no responde al toque', (tester) async {
    final tocadas = <String>[];
    await tester.pumpWidget(_montar(alOrdenar: tocadas.add));
    await tester.tap(find.text('Nota'));
    expect(tocadas, isEmpty);
  });

  testWidgets('la columna activa muestra la flecha de su dirección', (tester) async {
    await tester.pumpWidget(_montar(ordenActual: 'gasto', ascendente: true));
    expect(find.byIcon(Icons.arrow_upward), findsOneWidget);
    await tester.pumpWidget(_montar(ordenActual: 'gasto', ascendente: false));
    expect(find.byIcon(Icons.arrow_downward), findsOneWidget);
    await tester.pumpWidget(_montar());
    expect(find.byIcon(Icons.arrow_upward), findsNothing);
    expect(find.byIcon(Icons.arrow_downward), findsNothing);
  });

  testWidgets('el lector de pantalla oye la columna y su dirección', (tester) async {
    final semantica = tester.ensureSemantics();
    await tester.pumpWidget(_montar(ordenActual: 'gasto', ascendente: false));
    expect(find.bySemanticsLabel('Ordenar por Gasto, de mayor a menor'), findsOneWidget);
    expect(find.bySemanticsLabel('Ordenar por Equipo'), findsOneWidget);
    semantica.dispose();
  });
}
