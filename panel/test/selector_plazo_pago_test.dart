import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/widgets/selector_plazo_pago.dart';

Widget _app(Widget hijo) => MaterialApp(home: Scaffold(body: SingleChildScrollView(child: Padding(padding: const EdgeInsets.all(16), child: hijo))));

void main() {
  testWidgets('arranca sin ninguna opción elegida', (t) async {
    await t.pumpWidget(_app(SelectorPlazoPago()));
    expect(find.text('Contado'), findsOneWidget);
    for (final d in ['5', '15', '30', '45', '60', '90', 'Otro']) {
      expect(find.text(d), findsOneWidget, reason: d);
    }
    expect(find.byIcon(Icons.check), findsNothing, reason: 'sin preselección');
    expect(find.byType(TextField), findsNothing);
  });

  for (final c in [(0, 'Contado'), (5, '5'), (15, '15'), (30, '30'), (45, '45'), (60, '60'), (90, '90')]) {
    testWidgets('el botón ${c.$2} entrega ${c.$1} y queda marcado', (t) async {
      int? valor;
      await t.pumpWidget(_app(SelectorPlazoPago(onChanged: (v) => valor = v)));
      await t.tap(find.text(c.$2));
      await t.pump();
      expect(valor, c.$1);
      expect(find.byIcon(Icons.check), findsOneWidget, reason: 'la elegida lleva marca, no solo color');
    });
  }

  testWidgets('Otro abre un campo numérico y entrega el número escrito', (t) async {
    int? valor = -1;
    await t.pumpWidget(_app(SelectorPlazoPago(onChanged: (v) => valor = v)));
    await t.tap(find.text('Otro'));
    await t.pump();
    expect(valor, isNull, reason: 'todavía no escribió nada');
    expect(find.byType(TextField), findsOneWidget);
    await t.enterText(find.byType(TextField), '120');
    expect(valor, 120);
    await t.enterText(find.byType(TextField), '0');
    expect(valor, 0);
    await t.enterText(find.byType(TextField), '365');
    expect(valor, 365);
    // 366 no vale: el campo solo admite hasta 365
    await t.enterText(find.byType(TextField), '366');
    expect(valor, isNull);
    // las letras no entran
    await t.enterText(find.byType(TextField), 'abc');
    expect(valor, isNull);
  });

  testWidgets('un valor fuera de los botones abre Otro con el número escrito', (t) async {
    await t.pumpWidget(_app(SelectorPlazoPago(valor: 20)));
    expect(find.byType(TextField), findsOneWidget);
    expect(find.text('20'), findsOneWidget);
  });

  testWidgets('dentro de un Form es obligatorio: sin elegir muestra el aviso', (t) async {
    final clave = GlobalKey<FormState>();
    await t.pumpWidget(_app(Form(key: clave, child: SelectorPlazoPago())));
    expect(clave.currentState!.validate(), isFalse);
    await t.pump();
    expect(find.text('Elige el plazo de pago'), findsOneWidget);
    await t.tap(find.text('30'));
    await t.pump();
    expect(clave.currentState!.validate(), isTrue);
    await t.pump();
    expect(find.text('Elige el plazo de pago'), findsNothing);
  });

  testWidgets('Contado (0) cuenta como elegido', (t) async {
    final clave = GlobalKey<FormState>();
    await t.pumpWidget(_app(Form(key: clave, child: SelectorPlazoPago(valor: 0))));
    expect(clave.currentState!.validate(), isTrue);
  });

  testWidgets('teclado: Tab llega a los botones y Enter o Espacio los activan', (t) async {
    int? valor;
    await t.pumpWidget(_app(SelectorPlazoPago(onChanged: (v) => valor = v)));
    await t.sendKeyEvent(LogicalKeyboardKey.tab);
    await t.pump();
    await t.sendKeyEvent(LogicalKeyboardKey.enter);
    await t.pump();
    expect(valor, 0, reason: 'el primer botón es Contado');
    await t.sendKeyEvent(LogicalKeyboardKey.tab);
    await t.pump();
    await t.sendKeyEvent(LogicalKeyboardKey.space);
    await t.pump();
    expect(valor, 5);
  });

  testWidgets('cada botón tiene nombre para el lector de pantalla', (t) async {
    final sem = t.ensureSemantics();
    await t.pumpWidget(_app(SelectorPlazoPago()));
    expect(find.bySemanticsLabel('Contado'), findsOneWidget);
    expect(find.bySemanticsLabel('30 días'), findsOneWidget);
    expect(find.bySemanticsLabel('Otro plazo'), findsOneWidget);
    sem.dispose();
  });

  test('etiquetaPlazoPago', () {
    expect(etiquetaPlazoPago(null), 'Sin plazo de pago');
    expect(etiquetaPlazoPago(0), 'Contado');
    expect(etiquetaPlazoPago(1), '1 día');
    expect(etiquetaPlazoPago(45), '45 días');
  });
}
