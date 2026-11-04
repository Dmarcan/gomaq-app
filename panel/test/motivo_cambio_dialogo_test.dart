import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gomaq_web/services/api_client.dart';
import 'package:gomaq_web/widgets/motivo_cambio_dialogo.dart';

/// Abre el cuadro del motivo desde un botón y deja a mano lo que recibió [alEnviar].
Future<void> _abrir(
  WidgetTester tester,
  Future<void> Function(Map<String, String> motivo) alEnviar, {
  Size pantalla = const Size(900, 900),
}) async {
  tester.view.physicalSize = pantalla;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: ElevatedButton(
            onPressed: () => mostrarCambioConMotivo(
              context,
              titulo: 'Cambiar lo facturable',
              resumen: 'Filtro · 2\nDe «Por decidir» a «No se cobra».',
              textoAccion: 'Guardar cambio',
              alEnviar: alEnviar,
            ),
            child: const Text('abrir'),
          ),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('abrir'));
  await tester.pumpAndSettle();
}

Future<void> _elegirMotivo(WidgetTester tester, String etiqueta) async {
  await tester.tap(find.byType(DropdownButtonFormField<String>));
  await tester.pumpAndSettle();
  await tester.tap(find.text(etiqueta).last);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('sin motivo ni explicación avisa en cada campo y no envía', (tester) async {
    var llamadas = 0;
    await _abrir(tester, (_) async => llamadas++);

    await tester.tap(find.text('Guardar cambio'));
    await tester.pumpAndSettle();

    expect(find.text('Elige el motivo del cambio.'), findsOneWidget);
    expect(find.text('Explica el motivo del cambio.'), findsOneWidget);
    expect(llamadas, 0);
    expect(find.text('Cambiar lo facturable'), findsOneWidget, reason: 'el cuadro sigue abierto');
  });

  testWidgets('una explicación corta se rechaza en línea y una válida envía motivo_codigo y motivo', (tester) async {
    Map<String, String>? recibido;
    await _abrir(tester, (m) async => recibido = m);

    await _elegirMotivo(tester, 'Garantía');
    await tester.enterText(find.byType(TextFormField), 'corto');
    await tester.tap(find.text('Guardar cambio'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Escribe al menos 10 caracteres'), findsOneWidget);
    expect(recibido, isNull);

    await tester.enterText(find.byType(TextFormField), '  Cambio por garantía del fabricante  ');
    await tester.tap(find.text('Guardar cambio'));
    await tester.pumpAndSettle();
    expect(recibido, {'motivo_codigo': 'garantia', 'motivo': 'Cambio por garantía del fabricante'});
    expect(find.text('Cambiar lo facturable'), findsNothing, reason: 'se cierra al guardar');
  });

  testWidgets('mientras se envía el botón queda deshabilitado y no se envía dos veces', (tester) async {
    final espera = Completer<void>();
    var llamadas = 0;
    await _abrir(tester, (_) {
      llamadas++;
      return espera.future;
    });

    await _elegirMotivo(tester, 'Otro');
    await tester.enterText(find.byType(TextFormField), 'Una explicación suficiente');
    await tester.tap(find.text('Guardar cambio'));
    await tester.pump();

    expect(find.text('Guardando...'), findsOneWidget);
    final boton = tester.widget<FilledButton>(find.ancestor(of: find.text('Guardando...'), matching: find.byType(FilledButton)));
    expect(boton.onPressed, isNull);
    expect(llamadas, 1);

    espera.complete();
    await tester.pumpAndSettle();
    expect(llamadas, 1);
  });

  testWidgets('el mensaje del servidor (400 o 409) queda dentro del cuadro con lo escrito', (tester) async {
    await _abrir(tester, (_) async {
      throw ApiException(409, 'Esta orden ya tiene la factura folio F-1. Para dejar de cobrar algo ya facturado, emite una nota de crédito en el SII.');
    });

    await _elegirMotivo(tester, 'Error de registro');
    await tester.enterText(find.byType(TextFormField), 'Se registró mal el repuesto');
    await tester.tap(find.text('Guardar cambio'));
    await tester.pumpAndSettle();

    expect(find.textContaining('factura folio F-1'), findsOneWidget);
    expect(find.text('Se registró mal el repuesto'), findsOneWidget);
    // el botón vuelve a quedar disponible
    final boton = tester.widget<FilledButton>(find.ancestor(of: find.text('Guardar cambio'), matching: find.byType(FilledButton)));
    expect(boton.onPressed, isNotNull);
  });
}
