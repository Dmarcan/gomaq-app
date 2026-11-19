import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/screens/cliente/cliente_seguimiento_screen.dart';
import 'package:gomaq_web/widgets/estado_chip.dart';

void main() {
  const paso = 'Un técnico está en camino hacia tu dirección y llegará dentro de la próxima hora';
  final item = {'titulo': 'Reparación de retroexcavadora', 'estado': 'en_camino'};

  Future<void> montar(WidgetTester tester, double ancho) async {
    tester.view.physicalSize = Size(ancho, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TarjetaSeguimiento(item: item, lineas: const [paso, 'Siguiente: En terreno'], alTocar: () {}),
      ),
    ));
  }

  testWidgets('a 375 px la etiqueta va arriba del título, sin desbordes y con el paso completo', (tester) async {
    await montar(tester, 375);
    expect(tester.takeException(), isNull);
    expect(find.byType(ListTile), findsNothing);
    expect(find.text(paso), findsOneWidget);
    final texto = tester.widget<Text>(find.text(paso));
    expect(texto.maxLines, isNull);
    // con puntos suspensivos y sin maxLines, Flutter deja una sola línea cortada: el paso debe ocupar más de una
    expect(texto.overflow, isNull);
    final alturaLinea = tester.getSize(find.text('Siguiente: En terreno')).height;
    expect(tester.getSize(find.text(paso)).height, greaterThan(alturaLinea * 1.5));
    expect(tester.getBottomLeft(find.byType(EstadoChip)).dy, lessThanOrEqualTo(tester.getTopLeft(find.text('Reparación de retroexcavadora')).dy));
  });

  testWidgets('desde 600 px la etiqueta queda a la derecha, como antes', (tester) async {
    await montar(tester, 900);
    expect(tester.takeException(), isNull);
    expect(find.byType(ListTile), findsOneWidget);
    expect(tester.widget<ListTile>(find.byType(ListTile)).trailing, isA<EstadoChip>());
  });

  testWidgets('la barra de pasos y la hora de llegada se ven sin tocar la tarjeta', (tester) async {
    tester.view.physicalSize = const Size(375, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TarjetaSeguimiento(
          item: item,
          lineas: const ['Paso 4 de 6: Técnico en camino'],
          llegada: 'Llega en ~20 min (hora estimada 22:15)',
          alTocar: () {},
        ),
      ),
    ));
    expect(tester.takeException(), isNull);
    expect(find.byType(BarraPasos), findsOneWidget);
    expect(find.byWidgetPredicate((w) => w is Semantics && w.properties.label == 'Paso 4 de 6: Técnico en camino'), findsOneWidget);
    expect(find.text('Llega en ~20 min (hora estimada 22:15)'), findsOneWidget);
  });

  testWidgets('sin llegada no hay recuadro, y con un estado desconocido tampoco barra', (tester) async {
    await montar(tester, 375);
    expect(find.byIcon(Icons.schedule), findsNothing);
    expect(find.byType(BarraPasos), findsOneWidget);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: TarjetaSeguimiento(item: const {'titulo': 'x', 'estado': 'raro'}, lineas: const ['a'], alTocar: () {}),
      ),
    ));
    expect(find.byType(BarraPasos), findsNothing);
  });
}
