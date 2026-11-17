import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:gomaq_web/utils/efecto_guia.dart';
import 'package:gomaq_web/widgets/selector_dia_arriendo.dart';

// Reglas de referencia: migraciones 022 (gomaq_inicio_cobro: hora >= corte suma un día al despacho) y
// 028 (gomaq_fin_cobro: hora < corte resta un día a la recepción).
void main() {
  setUpAll(() => initializeDateFormatting('es_CL'));

  group('efectoCobroGuia, despacho', () {
    test('12:59 se cobra desde el mismo día', () {
      final e = efectoCobroGuia(tipo: 'despacho', fecha: DateTime(2026, 11, 16, 12, 59), horaCorte: 13)!;
      expect(e.dia, DateTime(2026, 11, 16));
      expect(e.texto, contains('desde el mismo día (16/11)'));
    });

    test('13:00 y 23:59 se cobran desde el día siguiente', () {
      for (final f in [DateTime(2026, 11, 16, 13, 0), DateTime(2026, 11, 16, 23, 59)]) {
        final e = efectoCobroGuia(tipo: 'despacho', fecha: f, horaCorte: 13)!;
        expect(e.dia, DateTime(2026, 11, 17));
        expect(e.texto, contains('desde el día siguiente (17/11)'));
        expect(e.texto, contains('13:00'));
      }
    });

    test('cambio de mes y de año', () {
      expect(efectoCobroGuia(tipo: 'despacho', fecha: DateTime(2026, 11, 30, 15), horaCorte: 13)!.dia, DateTime(2026, 12, 1));
      expect(efectoCobroGuia(tipo: 'despacho', fecha: DateTime(2026, 12, 31, 15), horaCorte: 13)!.dia, DateTime(2027, 1, 1));
    });

    test('hora de corte distinta de 13', () {
      expect(efectoCobroGuia(tipo: 'despacho', fecha: DateTime(2026, 11, 16, 13), horaCorte: 15)!.dia, DateTime(2026, 11, 16));
      final e = efectoCobroGuia(tipo: 'despacho', fecha: DateTime(2026, 11, 16, 9), horaCorte: 9)!;
      expect(e.dia, DateTime(2026, 11, 17));
      expect(e.texto, contains('09:00'));
    });
  });

  group('efectoCobroGuia, recepción', () {
    test('12:59 deja como último día el anterior', () {
      final e = efectoCobroGuia(tipo: 'recepcion', fecha: DateTime(2026, 11, 16, 12, 59), horaCorte: 13)!;
      expect(e.dia, DateTime(2026, 11, 15));
      expect(e.texto, contains('el último día cobrado es el anterior (15/11)'));
    });

    test('13:00 y 23:59 cobran ese mismo día', () {
      for (final f in [DateTime(2026, 11, 16, 13, 0), DateTime(2026, 11, 16, 23, 59)]) {
        final e = efectoCobroGuia(tipo: 'recepcion', fecha: f, horaCorte: 13)!;
        expect(e.dia, DateTime(2026, 11, 16));
        expect(e.texto, contains('el último día cobrado es 16/11'));
      }
    });

    test('cambio de mes y de año hacia atrás', () {
      expect(efectoCobroGuia(tipo: 'recepcion', fecha: DateTime(2026, 12, 1, 8), horaCorte: 13)!.dia, DateTime(2026, 11, 30));
      expect(efectoCobroGuia(tipo: 'recepcion', fecha: DateTime(2027, 1, 1, 8), horaCorte: 13)!.dia, DateTime(2026, 12, 31));
    });

    test('hora de corte distinta de 13', () {
      expect(efectoCobroGuia(tipo: 'recepcion', fecha: DateTime(2026, 11, 16, 14), horaCorte: 15)!.dia, DateTime(2026, 11, 15));
    });
  });

  test('un tipo desconocido no tiene efecto', () {
    expect(efectoCobroGuia(tipo: 'otro', fecha: DateTime(2026, 11, 16), horaCorte: 13), isNull);
  });

  group('SelectorDiaArriendo', () {
    Future<void> montar(
      WidgetTester tester, {
      required String tipo,
      int? horaCorte = 13,
      bool fallido = false,
      VoidCallback? onFecha,
      double ancho = 375,
    }) async {
      tester.view.physicalSize = Size(ancho, 800);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            child: SelectorDiaArriendo(
              tipo: tipo,
              fecha: DateTime(2026, 11, 16),
              hora: const TimeOfDay(hour: 14, minute: 0),
              horaTexto: '14:00',
              onElegirFecha: onFecha ?? () {},
              onElegirHora: () {},
              horaCorte: horaCorte,
              fallido: fallido,
            ),
          ),
        ),
      ));
    }

    testWidgets('despacho: título de inicio y frase del día siguiente', (tester) async {
      await montar(tester, tipo: 'despacho');
      expect(find.text('DÍA DE INICIO DEL ARRIENDO (DESPACHO)'), findsOneWidget);
      expect(find.textContaining('Salió desde las 13:00: se cobra desde el día siguiente (17/11)'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('recepción: título de término y último día cobrado', (tester) async {
      await montar(tester, tipo: 'recepcion');
      expect(find.text('DÍA DE TÉRMINO DEL ARRIENDO (RECEPCIÓN)'), findsOneWidget);
      expect(find.textContaining('el último día cobrado es 16/11'), findsOneWidget);
    });

    testWidgets('sin hora de corte o con guía fallida no hay frase', (tester) async {
      await montar(tester, tipo: 'despacho', horaCorte: null);
      expect(find.textContaining('Salió'), findsNothing);
      await montar(tester, tipo: 'despacho', fallido: true);
      expect(find.textContaining('Salió'), findsNothing);
    });

    testWidgets('el título es encabezado, el botón de fecha tiene nombre y se opera con teclado', (tester) async {
      final semantica = tester.ensureSemantics();
      var pulsado = 0;
      await montar(tester, tipo: 'despacho', onFecha: () => pulsado++);
      expect(find.bySemanticsLabel(RegExp('Día de inicio del arriendo: .* Cambiar')), findsOneWidget);
      final encabezado = tester.getSemantics(find.text('DÍA DE INICIO DEL ARRIENDO (DESPACHO)'));
      expect(encabezado.flagsCollection.isHeader, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(pulsado, 1);
      semantica.dispose();
    });
  });
}
