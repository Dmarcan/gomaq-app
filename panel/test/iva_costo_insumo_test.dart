import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';

import 'package:gomaq_web/utils/iva.dart';
import 'package:gomaq_web/utils/numeros.dart';
import 'package:gomaq_web/widgets/campo_costo_iva.dart';

/// Un cuadro mínimo con el campo y un texto que muestra lo que se enviaría al servidor.
class _Anfitrion extends StatefulWidget {
  const _Anfitrion();
  @override
  State<_Anfitrion> createState() => _AnfitrionState();
}

class _AnfitrionState extends State<_Anfitrion> {
  final ctrl = TextEditingController();
  bool iva = false;

  @override
  void dispose() {
    ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final enviado = costoNetoParaGuardar(parsearMonto(ctrl.text), incluyeIva: iva);
    return Scaffold(
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(children: [
          CampoCostoIva(
            controller: ctrl,
            incluyeIva: iva,
            onIvaChanged: (v) => setState(() => iva = v),
            onTextoChanged: () => setState(() {}),
          ),
          Text('ENVIA:${enviado ?? 'nada'}'),
        ]),
      ),
    );
  }
}

void main() {
  setUpAll(() => initializeDateFormatting('es_CL'));

  group('netoDesdePrecioConIva', () {
    test('casos límite', () {
      expect(netoDesdePrecioConIva(0), 0);
      expect(netoDesdePrecioConIva(1), 1); // 0,84 redondea a 1
      expect(netoDesdePrecioConIva(119), 100);
      expect(netoDesdePrecioConIva(1190), 1000);
      expect(netoDesdePrecioConIva(11900), 10000);
      expect(netoDesdePrecioConIva(1190000000), 1000000000);
    });

    test('redondea al peso más cercano', () {
      expect(netoDesdePrecioConIva(18500), 15546); // 15546,22
      expect(netoDesdePrecioConIva(10000), 8403); // 8403,36
      expect(netoDesdePrecioConIva(2), 2); // 1,68
      expect(netoDesdePrecioConIva(1000), 840); // 840,33
      expect(netoDesdePrecioConIva(1100), 924); // 924,37
      expect(netoDesdePrecioConIva(1130), 950); // 949,58 sube
    });

    test('es monótono y queda a un peso del original', () {
      var anterior = 0;
      for (var b = 0; b <= 5000; b++) {
        final n = netoDesdePrecioConIva(b);
        expect(n >= anterior, isTrue, reason: 'bruto $b');
        // volver a aplicar IVA no se aleja más de un peso del original
        expect(((n * 1.19) - b).abs() <= 1.0, isTrue, reason: 'bruto $b');
        anterior = n;
      }
    });

    test('un precio negativo es un error', () {
      expect(() => netoDesdePrecioConIva(-1), throwsArgumentError);
    });
  });

  group('costoNetoParaGuardar', () {
    test('sin casilla guarda el valor tal cual', () {
      expect(costoNetoParaGuardar(18500, incluyeIva: false), 18500);
      expect(costoNetoParaGuardar(0, incluyeIva: false), 0);
    });
    test('con casilla convierte', () {
      expect(costoNetoParaGuardar(119, incluyeIva: true), 100);
    });
    test('vacío o inválido no envía nada', () {
      expect(costoNetoParaGuardar(null, incluyeIva: true), isNull);
      expect(costoNetoParaGuardar(-5, incluyeIva: false), isNull);
    });
    test('un decimal pasa intacto para que el servidor lo rechace', () {
      expect(costoNetoParaGuardar(12.5, incluyeIva: true), 12.5);
    });
  });

  group('casilla en el formulario', () {
    testWidgets('desmarcada por defecto, sin neto a la vista y se envía el valor tal cual', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: _Anfitrion()));
      final casilla = tester.widget<CheckboxListTile>(find.byKey(const Key('casilla_incluye_iva')));
      expect(casilla.value, isFalse);
      expect(find.text('El precio incluye IVA (19 %)'), findsOneWidget);
      expect(find.textContaining('Se guarda sin IVA'), findsOneWidget); // la línea de ayuda
      await tester.enterText(find.byType(TextFormField), '18.500');
      await tester.pump();
      expect(find.textContaining('Se guardará sin IVA'), findsNothing);
      expect(find.text('ENVIA:18500'), findsOneWidget);
    });

    testWidgets('marcada muestra el neto en vivo y envía el neto', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: _Anfitrion()));
      await tester.enterText(find.byType(TextFormField), '11.900');
      await tester.tap(find.byKey(const Key('casilla_incluye_iva')));
      await tester.pump();
      expect(find.textContaining(r'Se guardará sin IVA: $10.000'), findsOneWidget);
      expect(find.text('ENVIA:10000'), findsOneWidget);
      await tester.enterText(find.byType(TextFormField), '119');
      await tester.pump();
      expect(find.textContaining(r'Se guardará sin IVA: $100'), findsOneWidget);
      expect(find.text('ENVIA:100'), findsOneWidget);
      // al desmarcar vuelve al valor tal cual
      await tester.tap(find.byKey(const Key('casilla_incluye_iva')));
      await tester.pump();
      expect(find.text('ENVIA:119'), findsOneWidget);
    });

    testWidgets('marcada y vacía pide escribir el precio', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: _Anfitrion()));
      await tester.tap(find.byKey(const Key('casilla_incluye_iva')));
      await tester.pump();
      expect(find.textContaining('Escribe el precio con IVA'), findsOneWidget);
      expect(find.text('ENVIA:nada'), findsOneWidget);
    });

    testWidgets('se maneja con teclado (Espacio marca la casilla)', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: _Anfitrion()));
      await tester.enterText(find.byType(TextFormField), '119');
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.space);
      await tester.pump();
      expect(tester.widget<CheckboxListTile>(find.byKey(const Key('casilla_incluye_iva'))).value, isTrue);
      expect(find.text('ENVIA:100'), findsOneWidget);
    });

    testWidgets('semántica: casilla con nombre y neto como región viva', (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(const MaterialApp(home: _Anfitrion()));
      await tester.enterText(find.byType(TextFormField), '119');
      await tester.tap(find.byKey(const Key('casilla_incluye_iva')));
      await tester.pump();
      final casilla = tester.getSemantics(find.byKey(const Key('casilla_incluye_iva')));
      expect(casilla.label, contains('El precio incluye IVA'));
      final vivo = tester.getSemantics(find.textContaining('Se guardará sin IVA'));
      expect(vivo.flagsCollection.isLiveRegion, isTrue);
      handle.dispose();
    });

    testWidgets('a 375 px no desborda', (tester) async {
      tester.view.physicalSize = const Size(375, 812);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(const MaterialApp(home: _Anfitrion()));
      await tester.enterText(find.byType(TextFormField), '1.190.000');
      await tester.tap(find.byKey(const Key('casilla_incluye_iva')));
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.text('ENVIA:1000000'), findsOneWidget);
    });
  });
}
